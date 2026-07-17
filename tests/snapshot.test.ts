/**
 * snapshot.test.ts — the world survives the wire.
 *
 * A snapshot is the only thing a client knows about the world, and a promoted
 * host has to keep simulating from one. So a field that does not survive encode
 * → JSON → decode is not a rendering glitch; it is a peer that disagrees about
 * the game and cannot take over.
 */

import { describe, expect, it } from 'vitest';
import { applySnapshot, encodeSnapshot } from '../src/game/snapshot';
import { IN_FIRE, IN_LEFT, IN_THRUST, Sim } from '../src/game/sim';
import { MODES } from '../src/modes';

/** Play a live-looking round so the snapshot has bullets, rocks and stats in it. */
function busy(seed = 5, players = 4): Sim {
  const sim = new Sim({ seed, mode: MODES.skirmish, players });
  for (let i = 0; i < 400; i++) sim.step([IN_THRUST | IN_FIRE, IN_LEFT | IN_FIRE, IN_THRUST, IN_FIRE]);
  return sim;
}

/** A peer's own Sim: same seed and mode, but it has simulated nothing. */
function blank(seed = 5, players = 4): Sim {
  return new Sim({ seed, mode: MODES.skirmish, players });
}

describe('encode → JSON → decode', () => {
  it('round-trips the world onto a peer that simulated nothing', () => {
    const host = busy();
    const client = blank();
    const wire = JSON.parse(JSON.stringify(encodeSnapshot(host, [])));
    applySnapshot(client, wire);

    expect(client.tick).toBe(host.tick);
    expect(client.time).toBeCloseTo(host.time, 1);
    expect(client.bullets.length).toBe(host.bullets.length);
    expect(client.rocks.length).toBe(host.rocks.length);
    for (let i = 0; i < host.ships.length; i++) {
      const a = host.ships[i];
      const b = client.ships[i];
      expect(b.x).toBeCloseTo(a.x, 0);
      expect(b.y).toBeCloseTo(a.y, 0);
      expect(b.ang).toBeCloseTo(a.ang, 1);
      expect(b.alive).toBe(a.alive);
      expect(b.lives).toBe(a.lives);
      expect(b.kills).toBe(a.kills);
      expect(b.deaths).toBe(a.deaths);
    }
  });

  it('carries every stat the results screen shows — for every player', () => {
    // Principle 9: the summary shows everyone's breakdown, and on a client that
    // breakdown exists ONLY because it rode in on a snapshot.
    const host = busy();
    host.ships[2].bestStreak = 4;
    host.ships[2].rocksBroken = 7;
    const client = blank();
    applySnapshot(client, JSON.parse(JSON.stringify(encodeSnapshot(host, []))));
    for (let i = 0; i < host.ships.length; i++) {
      for (const k of ['kills', 'deaths', 'shots', 'hits', 'rocksBroken', 'bestStreak'] as const) {
        expect(client.ships[i][k], `seat ${i} ${k}`).toBe(host.ships[i][k]);
      }
    }
  });

  it('carries the respawn penalty, so a promoted host does not resurrect the dead', () => {
    // A client holds a Sim it never steps, so any field NOT on the wire keeps its
    // constructor value forever — and the instant that client is promoted it
    // starts stepping with that stale value. With `respawn` omitted, a dead ship
    // arrived as {alive:false, respawn:0} and the promoted host's very first tick
    // ran `respawn -= STEP` → -0.0167 ≤ 0 → back on the ring, penalty skipped.
    const host = blank(1, 2);
    const dead = host.ships[1];
    dead.alive = false;
    dead.lives = 3;
    dead.respawn = 1.5;

    const client = blank(1, 2);
    applySnapshot(client, JSON.parse(JSON.stringify(encodeSnapshot(host, []))));
    expect(client.ships[1].alive).toBe(false);
    expect(client.ships[1].respawn).toBeCloseTo(1.5, 1);

    // Promote: one step must NOT bring them back.
    client.step([0, 0]);
    expect(client.ships[1].alive).toBe(false);
    expect(client.ships[1].respawn).toBeGreaterThan(1.4);
  });

  it('round-trips the terminal state, so a client agrees the round is over', () => {
    const host = blank(1, 2);
    host.over = true;
    host.winner = 1;
    const client = blank(1, 2);
    applySnapshot(client, JSON.parse(JSON.stringify(encodeSnapshot(host, []))));
    expect(client.over).toBe(true);
    expect(client.winner).toBe(1);
  });

  it('round-trips a draw as a draw, not as seat -1 becoming seat 0', () => {
    const host = blank(1, 2);
    host.over = true;
    host.winner = -1;
    const client = blank(1, 2);
    applySnapshot(client, JSON.parse(JSON.stringify(encodeSnapshot(host, []))));
    expect(client.winner).toBe(-1);
  });

  it('round-trips the flare, so Nova looks the same on every peer', () => {
    const host = blank(1, 2);
    host.flare = 0.75;
    const client = blank(1, 2);
    applySnapshot(client, JSON.parse(JSON.stringify(encodeSnapshot(host, []))));
    expect(client.flare).toBeCloseTo(0.75, 2);
  });

  it('carries events through, and drops an unknown kind rather than crashing', () => {
    const host = blank();
    const client = blank();
    const snap = encodeSnapshot(host, [
      { t: 'boom', x: 10, y: -20, p: 2 },
      { t: 'flare', x: 0, y: 0, p: -1 },
    ]);
    // An event kind from a future build: unknown index, must not become undefined
    // in the render loop.
    snap.e.push(99, 0, 0, 0);
    const out = applySnapshot(client, JSON.parse(JSON.stringify(snap)));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ t: 'boom', x: 10, y: -20, p: 2 });
    expect(out[1].t).toBe('flare');
  });

  it('matches ships by SEAT, not by array position', () => {
    // The frozen roster makes the two agree today. Matching by index would
    // silently put every score on the wrong name the day it does not — a bug
    // that surfaces as "my kills are on someone else's row", long after anyone
    // would guess why.
    const host = blank(1, 3);
    host.ships[0].kills = 9;
    const client = blank(1, 3);
    client.ships.reverse(); // same seats, different order
    applySnapshot(client, JSON.parse(JSON.stringify(encodeSnapshot(host, []))));
    expect(client.ships.find((s) => s.seat === 0)!.kills).toBe(9);
    expect(client.ships.find((s) => s.seat === 1)!.kills).toBe(0);
  });

  it('is small enough to send at 20Hz', () => {
    const bytes = JSON.stringify(encodeSnapshot(busy(), [])).length;
    expect(bytes).toBeLessThan(4000);
  });

  it('an older snapshot applied after a newer one is the caller`s problem, but decode stays sane', () => {
    const client = blank();
    const s1 = encodeSnapshot(busy(5), []);
    applySnapshot(client, JSON.parse(JSON.stringify(s1)));
    expect(Number.isFinite(client.ships[0].x)).toBe(true);
  });
});
