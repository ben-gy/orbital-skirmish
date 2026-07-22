// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * net-game.ts — glue between the P2P net and the Sim.
 *
 * Host-authoritative star. The host advances the Sim on a 50ms `setInterval` and
 * broadcasts a snapshot; clients send their input bitmask on 'in' and overwrite
 * their Sim from 'snap'. Every peer holds a real Sim, so promotion is continuous
 * rather than a reconstruction (see snapshot.ts).
 *
 * THE INTERVAL IS NOT AN IMPLEMENTATION DETAIL. Browsers pause rAF in a
 * backgrounded tab, so a host that ticks the round off rAF freezes the whole room
 * the moment they switch tabs — and it cannot be caught headlessly, because
 * there is no rAF in a test either. rAF draws; setInterval decides.
 *
 * There is exactly ONE answer to "who is host": engine/net.ts. NetGame holds a
 * hostFlag only so the core stays testable without a Net; it is seeded from
 * net.isHost() and thereafter moved ONLY by net's onHostChange. Now that net
 * elects by incumbency, a mid-round joiner with a lower peer id wins nothing —
 * so this must not quietly hold a second opinion and hand it authority.
 */

import type { Net } from '@ben-gy/game-engine/net';
import { STEP, Sim, type SimEvent } from './game/sim';
import { applySnapshot, encodeSnapshot, type Snapshot } from './game/snapshot';

/** Host sim cadence. ~3 sim steps per tick at 60Hz. */
export const TICK_MS = 50;

export interface NetGameCallbacks {
  /** Fires on every peer with whatever the last step produced, for juice. */
  onEvents: (events: SimEvent[]) => void;
  /** This peer just became the authoritative host mid-round. */
  onHostPromoted: () => void;
  /** The round reached its end (on the authoritative timeline). */
  onOver: () => void;
}

export class NetGame {
  readonly sim: Sim;
  private net: Net;
  private cb: NetGameCallbacks;
  private hostFlag: boolean;
  private sendIn: ((d: number) => void) & { off: () => void };
  private sendSnap: ((s: Snapshot) => void) & { off: () => void };
  /** seat -> latest bitmask heard. Host-only. */
  private inputs = new Map<number, number>();
  /** peer id -> seat, from the frozen roster. */
  private seatOf: Map<string, number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private acc = 0;
  private selfInput = 0;
  private lastSnapTick = -1;
  private ended = false;

  constructor(net: Net, sim: Sim, roster: { id: string; name: string }[], cb: NetGameCallbacks) {
    this.net = net;
    this.sim = sim;
    this.cb = cb;
    this.hostFlag = net.isHost();
    this.seatOf = new Map(roster.map((p, i) => [p.id, i]));

    this.sendIn = net.channel<number>('in', (mask, from) => {
      const seat = this.seatOf.get(from);
      // A peer that is not in this round's frozen roster (a spectator who joined
      // mid-round) has no seat, and its input must not land on someone else's.
      if (seat === undefined) return;
      this.inputs.set(seat, mask);
    });

    this.sendSnap = net.channel<Snapshot>('snap', (snap) => {
      if (this.hostFlag) return; // our own sim is the truth; ignore the echo
      // Out-of-order delivery is normal on a mesh. An older snapshot would drag
      // the world backwards, which reads as rubber-banding.
      if (snap.t <= this.lastSnapTick) return;
      this.lastSnapTick = snap.t;
      const events = applySnapshot(this.sim, snap);
      this.cb.onEvents(events);
      this.checkOver();
    });
  }

  /** Seat this peer occupies, or -1 if it is spectating this round. */
  selfSeat(): number {
    return this.seatOf.get(this.net.selfId) ?? -1;
  }

  isHost(): boolean {
    return this.hostFlag;
  }

  start(): void {
    if (this.hostFlag) this.startTicking();
  }

  /** Called every animation frame with the local player's bitmask. */
  setInput(mask: number): void {
    if (mask === this.selfInput) {
      // Unchanged input still needs to reach the host occasionally, or a held
      // key looks like a released one after a dropped packet. The host keeps the
      // last mask it heard, so re-sending on change is enough — but a change to
      // the SAME value is not a change, hence the early return.
      return;
    }
    this.selfInput = mask;
    const seat = this.selfSeat();
    if (seat < 0) return;
    if (this.hostFlag) this.inputs.set(seat, mask);
    else this.sendIn(mask);
  }

  private startTicking(): void {
    if (this.timer != null) return;
    this.last = Date.now();
    this.acc = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    // Clamp: a tab that was backgrounded for a minute must not try to catch up
    // by running 3600 steps in one frame.
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    this.acc += dt;
    const collected: SimEvent[] = [];
    while (this.acc >= STEP) {
      this.acc -= STEP;
      const masks: number[] = [];
      for (const [seat, m] of this.inputs) masks[seat] = m;
      this.sim.step(masks);
      const ev = this.sim.drainEvents();
      if (ev.length) collected.push(...ev);
      if (this.sim.over) break;
    }
    this.sendSnap(encodeSnapshot(this.sim, collected));
    if (collected.length) this.cb.onEvents(collected);
    this.checkOver();
  }

  private checkOver(): void {
    if (!this.sim.over || this.ended) return;
    this.ended = true;
    this.stopTicking();
    this.cb.onOver();
  }

  // ── routed from net handlers in main.ts ────────────────────────────────────

  /**
   * The one path by which authority moves. net.ts promotes exactly one survivor
   * when the host leaves; we adopt the Sim we have been holding all along and
   * resume ticking it. The round keeps running and can still reach game-over —
   * which is contract gate #2, and is what rhythm-relay shipped without.
   */
  onHostChange(isHost: boolean): void {
    const was = this.hostFlag;
    this.hostFlag = isHost;
    if (isHost && !was) {
      // Our Sim is already current: snapshots have been overwriting it.
      this.inputs.set(this.selfSeat(), this.selfInput);
      if (!this.sim.over) this.startTicking();
      this.cb.onHostPromoted();
    } else if (!isHost && was) {
      this.stopTicking();
    }
  }

  onPeerLeave(id: string): void {
    const seat = this.seatOf.get(id);
    if (seat === undefined) return;
    // Their ship coasts rather than freezing the round. Sim.step already treats
    // a missing mask as 0, so this is belt-and-braces: stop replaying the last
    // thing they were holding down forever.
    this.inputs.set(seat, 0);
  }

  destroy(): void {
    this.stopTicking();
    // The Net outlives every round (rematches run inside the same room) and
    // channel() fans out to all receivers, so a finished NetGame left subscribed
    // would keep folding the NEXT round's inputs into its dead Sim — and, if it
    // was the host, broadcast snapshots of a finished round over the live one.
    this.sendIn.off();
    this.sendSnap.off();
  }
}
