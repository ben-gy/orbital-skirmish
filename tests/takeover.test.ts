/**
 * takeover.test.ts — CONTRACT GATE #2: the host leaving must not end the game.
 *
 * This is the test rhythm-relay shipped without, and the bug it would have
 * caught was not subtle: the host closed their tab and the survivor sat on a
 * frozen board forever. The manual smoke test (close the host tab, keep playing)
 * is the other half of this gate; both are required, because the smoke test
 * cannot run in CI and this cannot see the real relay.
 *
 * The fake bus below stands in for Trystero DELIBERATELY and within its remit:
 * it is here to make claims about NetGame's promotion path, which lives strictly
 * above the transport. It proves nothing about the leave/rejoin trap and is not
 * asked to — net-lifecycle.test.ts and trystero-rejoin.test.ts own that, because
 * a fake bus sits above Trystero's room cache and structurally cannot contain
 * the defect. Using one for the transport is exactly how that bug shipped twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetGame, TICK_MS } from '../src/net-game';
import { Sim } from '../src/game/sim';
import { MODES } from '../src/modes';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

type Handler = (data: unknown, from: PeerId) => void;

/** An in-memory mesh: every send fans out to the other peers' receivers. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<Handler>>>();
  send(from: PeerId, chan: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to == null ? [...this.peers.keys()].filter((p) => p !== from) : Array.isArray(to) ? to : [to];
    for (const id of targets) {
      // Round-trip through JSON: Trystero serializes, and a test that passes
      // live object references would hide any shared-mutation bug.
      for (const h of this.peers.get(id)?.get(chan) ?? []) h(JSON.parse(JSON.stringify(data)), from);
    }
  }
}

function fakeNet(bus: Bus, selfId: PeerId, host: () => PeerId | null): Net {
  bus.peers.set(selfId, new Map());
  return {
    selfId,
    peers: () => [...bus.peers.keys()].sort(),
    host,
    isHost: () => host() === selfId,
    hostSettled: () => host() !== null,
    // Terms are net.ts's business. This file drives promotion explicitly via
    // setHost()/onHostChange(), which is the only path NetGame is allowed to
    // learn about authority through, so a static term is honest here.
    hostEpoch: () => 1,
    count: () => bus.peers.size,
    onPeersChange: () => () => {},
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const chans = bus.peers.get(selfId)!;
      if (!chans.has(name)) chans.set(name, new Set());
      const h = onReceive as Handler;
      chans.get(name)!.add(h);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        d: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = () => void chans.get(name)!.delete(h);
      return send;
    },
    ping: async () => 0,
    // The lobby's "Host this room" button. Nothing here presses it — promotion
    // in these cases arrives from net.ts, which is the case that matters.
    takeover: () => {},
    netDiag: () => ({
      selfId,
      host: host(),
      epoch: 1,
      settled: host() !== null,
      peers: [...bus.peers.keys()].sort(),
      relaySockets: {},
      turn: false,
    }),
    leave: async () => void bus.peers.delete(selfId),
  };
}

const ROSTER = [
  { id: 'a', name: 'Ana' },
  { id: 'b', name: 'Bo' },
];

function pair() {
  const bus = new Bus();
  let host: PeerId | null = 'a';
  const netA = fakeNet(bus, 'a', () => host);
  const netB = fakeNet(bus, 'b', () => host);
  const simA = new Sim({ seed: 42, mode: MODES.skirmish, players: 2 });
  const simB = new Sim({ seed: 42, mode: MODES.skirmish, players: 2 });
  const overA = vi.fn();
  const overB = vi.fn();
  const promotedB = vi.fn();
  const a = new NetGame(netA, simA, ROSTER, { onEvents: () => {}, onHostPromoted: () => {}, onOver: overA });
  const b = new NetGame(netB, simB, ROSTER, { onEvents: () => {}, onHostPromoted: promotedB, onOver: overB });
  return {
    bus,
    a,
    b,
    simA,
    simB,
    overB,
    promotedB,
    setHost: (h: PeerId | null) => (host = h),
  };
}

describe('host transfer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the host advances the world and the client follows it', () => {
    const { a, b, simA, simB } = pair();
    a.start();
    b.start();
    expect(a.isHost()).toBe(true);
    expect(b.isHost()).toBe(false);

    vi.advanceTimersByTime(TICK_MS * 20);
    expect(simA.tick).toBeGreaterThan(0);
    // The client did not simulate anything — it was TOLD the world.
    expect(simB.tick).toBe(simA.tick);
  });

  it('a client does NOT drive shared state before it is promoted', () => {
    const { b, simB } = pair();
    b.start(); // a non-host start must not begin ticking
    vi.advanceTimersByTime(TICK_MS * 40);
    expect(simB.tick).toBe(0);
  });

  it('the promoted peer keeps the round running — it does not freeze', () => {
    const { a, b, simB, setHost, promotedB } = pair();
    a.start();
    b.start();
    vi.advanceTimersByTime(TICK_MS * 20);
    const atHandover = simB.tick;
    expect(atHandover).toBeGreaterThan(0);

    // The host's tab closes.
    a.destroy();
    setHost('b');
    b.onHostChange(true);

    expect(promotedB).toHaveBeenCalledTimes(1);
    expect(b.isHost()).toBe(true);
    vi.advanceTimersByTime(TICK_MS * 20);
    // THE ASSERTION THAT MATTERS: the world moved on without the old host.
    expect(simB.tick).toBeGreaterThan(atHandover);
  });

  it('the promoted peer can still reach game-over', () => {
    const { a, b, simB, setHost, overB } = pair();
    a.start();
    b.start();
    vi.advanceTimersByTime(TICK_MS * 20);
    a.destroy();
    setHost('b');
    b.onHostChange(true);

    // Run the authoritative clock out. A survivor who can move but can never
    // finish is still a failed round — "it does not freeze" is not enough.
    vi.advanceTimersByTime((MODES.skirmish.roundSeconds + 2) * 1000);
    expect(simB.over).toBe(true);
    expect(overB).toHaveBeenCalled();
  });

  it('the promoted peer starts broadcasting, so a third peer keeps seeing the world', () => {
    const { bus, a, b, setHost } = pair();
    a.start();
    b.start();
    vi.advanceTimersByTime(TICK_MS * 10);

    const netC = fakeNet(bus, 'c', () => 'b');
    const simC = new Sim({ seed: 42, mode: MODES.skirmish, players: 2 });
    const c = new NetGame(netC, simC, ROSTER, { onEvents: () => {}, onHostPromoted: () => {}, onOver: () => {} });

    a.destroy();
    setHost('b');
    b.onHostChange(true);
    vi.advanceTimersByTime(TICK_MS * 10);
    expect(simC.tick).toBeGreaterThan(0);
    c.destroy();
  });

  it('demotion stops the old host ticking, so two peers never both simulate', () => {
    const { a, b, simA, setHost } = pair();
    a.start();
    vi.advanceTimersByTime(TICK_MS * 5);
    const t = simA.tick;

    // A partition heals and net.ts converges on b.
    setHost('b');
    a.onHostChange(false);
    b.onHostChange(true);
    vi.advanceTimersByTime(TICK_MS * 10);
    // a's sim only moves now if b tells it to — never on its own authority.
    expect(a.isHost()).toBe(false);
    expect(simA.tick).toBeGreaterThanOrEqual(t);
  });

  it('a peer leaving does not stall the host', () => {
    const { a, b, simA } = pair();
    a.start();
    vi.advanceTimersByTime(TICK_MS * 5);
    b.destroy();
    a.onPeerLeave('b');
    const t = simA.tick;
    vi.advanceTimersByTime(TICK_MS * 10);
    expect(simA.tick).toBeGreaterThan(t);
  });

  it('a client input reaches the host and moves the right seat', () => {
    const { a, b, simA } = pair();
    a.start();
    b.setInput(4 /* IN_THRUST */);
    vi.advanceTimersByTime(TICK_MS * 30);
    // Seat 1 is Bo. Thrusting changes its speed away from the pure orbital one.
    const bo = simA.ships[1];
    expect(bo.thrusting).toBe(true);
  });

  it('an input from a peer with no seat this round is ignored', () => {
    const { bus, a, simA } = pair();
    a.start();
    // A spectator who joined mid-round: present on the mesh, absent from the
    // frozen roster. Its input must not land on somebody else's ship.
    const netZ = fakeNet(bus, 'z', () => 'a');
    const sendZ = netZ.channel<number>('in', () => {});
    sendZ(4);
    vi.advanceTimersByTime(TICK_MS * 10);
    expect(simA.ships.every((s) => !s.thrusting)).toBe(true);
  });
});
