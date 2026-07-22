// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * snapshot.ts — the world, on the wire.
 *
 * Host-authoritative star: the host owns the Sim and broadcasts one of these at
 * 20Hz; clients overwrite their own Sim from it. Trystero JSON-serializes
 * payloads, so this is flat number arrays rather than objects — the field names
 * would otherwise be most of the packet.
 *
 * Coordinates are rounded to whole units and angles to 1/100 rad. That is not
 * only bandwidth: it also means a snapshot is a value you can compare, which is
 * what the round-trip test asserts.
 *
 * WHY EVERY PEER HOLDS A REAL SIM, not just the latest snapshot: the promoted
 * host has to keep the round running. If clients only kept a bag of positions to
 * draw, promotion would mean reconstructing a simulation from a picture of one —
 * bullets with no velocity, rocks with no drift, a round clock nobody owns. So
 * clients apply snapshots INTO a Sim they already have, and promotion is just
 * "start stepping the thing you were already holding".
 */

import { Sim, type SimEvent, type EventKind } from './sim';

/**
 * Ship fields per entry, in order.
 *
 * `respawn` is on the wire and must stay there, even though a client never reads
 * it: clients hold a Sim they never step, so an omitted field sits at its
 * constructor value forever — and the moment that client is PROMOTED it starts
 * stepping with that stale value. Leaving `respawn` off meant a promoted host's
 * very first tick ran `respawn -= STEP` on a dead ship, went straight past zero
 * and resurrected everyone mid-penalty. "The client doesn't use it" is not a
 * reason to omit a field; the client is one host-transfer away from being the
 * authority on it.
 */
const SHIP_STRIDE = 17;
const BULLET_STRIDE = 5;
const ROCK_STRIDE = 5;
const EVENT_STRIDE = 4;

const KINDS: EventKind[] = ['shot', 'hit', 'boom', 'split', 'flare', 'spawn', 'star'];

export interface Snapshot {
  /** Sim tick. Monotonic — a snapshot older than the one we hold is dropped. */
  t: number;
  /** Round time, in tenths of a second. */
  tm: number;
  /** over ? 1 : 0 */
  o: number;
  /** Winning seat, or -1. */
  w: number;
  /** Flare intensity, 0..100. */
  f: number;
  s: number[];
  b: number[];
  r: number[];
  e: number[];
}

const r1 = (n: number): number => Math.round(n);
const r100 = (n: number): number => Math.round(n * 100);

export function encodeSnapshot(sim: Sim, events: SimEvent[]): Snapshot {
  const s: number[] = [];
  for (const p of sim.ships) {
    s.push(
      p.seat,
      r1(p.x),
      r1(p.y),
      r1(p.vx),
      r1(p.vy),
      r100(p.ang),
      (p.alive ? 1 : 0) | (p.thrusting ? 2 : 0) | (p.out ? 4 : 0),
      p.lives,
      Math.round(p.invuln * 10),
      p.kills,
      p.deaths,
      p.shots,
      p.hits,
      p.rocksBroken,
      p.streak,
      p.bestStreak,
      Math.round(p.respawn * 10),
    );
  }
  const b: number[] = [];
  for (const x of sim.bullets) b.push(r1(x.x), r1(x.y), r1(x.vx), r1(x.vy), x.owner);
  const r: number[] = [];
  for (const x of sim.rocks) r.push(r1(x.x), r1(x.y), r1(x.vx), r1(x.vy), r1(x.r));
  const e: number[] = [];
  for (const x of events) e.push(KINDS.indexOf(x.t), r1(x.x), r1(x.y), x.p);
  return { t: sim.tick, tm: Math.round(sim.time * 10), o: sim.over ? 1 : 0, w: sim.winner, f: r100(sim.flare), s, b, r, e };
}

/**
 * Overwrite `sim` from a snapshot. Returns the events it carried, for juice.
 *
 * Ships are matched BY SEAT, not by array position. The frozen roster makes the
 * two agree today, but matching by index would silently mis-assign every score
 * on the day it does not — and that is the kind of bug that shows up as "my
 * kills are on someone else's name" long after anyone would guess why.
 */
export function applySnapshot(sim: Sim, snap: Snapshot): SimEvent[] {
  sim.tick = snap.t;
  sim.time = snap.tm / 10;
  sim.over = snap.o === 1;
  sim.winner = snap.w;
  sim.flare = snap.f / 100;

  for (let i = 0; i + SHIP_STRIDE <= snap.s.length; i += SHIP_STRIDE) {
    const seat = snap.s[i];
    const p = sim.ships.find((x) => x.seat === seat);
    if (!p) continue;
    const flags = snap.s[i + 6];
    p.x = snap.s[i + 1];
    p.y = snap.s[i + 2];
    p.vx = snap.s[i + 3];
    p.vy = snap.s[i + 4];
    p.ang = snap.s[i + 5] / 100;
    p.alive = (flags & 1) !== 0;
    p.thrusting = (flags & 2) !== 0;
    p.out = (flags & 4) !== 0;
    p.lives = snap.s[i + 7];
    p.invuln = snap.s[i + 8] / 10;
    p.kills = snap.s[i + 9];
    p.deaths = snap.s[i + 10];
    p.shots = snap.s[i + 11];
    p.hits = snap.s[i + 12];
    p.rocksBroken = snap.s[i + 13];
    p.streak = snap.s[i + 14];
    p.bestStreak = snap.s[i + 15];
    p.respawn = snap.s[i + 16] / 10;
  }

  sim.bullets.length = 0;
  for (let i = 0; i + BULLET_STRIDE <= snap.b.length; i += BULLET_STRIDE) {
    sim.bullets.push({
      x: snap.b[i],
      y: snap.b[i + 1],
      vx: snap.b[i + 2],
      vy: snap.b[i + 3],
      owner: snap.b[i + 4],
      // Life is not on the wire — it only decides when the HOST retires a
      // bullet, and the client is told that by the bullet's absence.
      life: 1,
    });
  }

  sim.rocks.length = 0;
  for (let i = 0; i + ROCK_STRIDE <= snap.r.length; i += ROCK_STRIDE) {
    const rad = snap.r[i + 4];
    sim.rocks.push({ x: snap.r[i], y: snap.r[i + 1], vx: snap.r[i + 2], vy: snap.r[i + 3], r: rad, big: rad > 20 });
  }

  const out: SimEvent[] = [];
  for (let i = 0; i + EVENT_STRIDE <= snap.e.length; i += EVENT_STRIDE) {
    const k = KINDS[snap.e[i]];
    if (!k) continue;
    out.push({ t: k, x: snap.e[i + 1], y: snap.e[i + 2], p: snap.e[i + 3] });
  }
  return out;
}
