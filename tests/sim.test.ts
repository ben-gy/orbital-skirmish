/**
 * sim.test.ts — the rules, and the two invariants the netcode rests on.
 *
 * Determinism is the load-bearing one: rock spawns, splits and respawn points all
 * come from the seeded rng, so two peers never have to be TOLD what the arena
 * did. The moment anything here reaches for Math.random, multiplayer desyncs in a
 * way that looks like lag and is not.
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_R,
  IN_FIRE,
  IN_LEFT,
  IN_RIGHT,
  IN_THRUST,
  MAX_SPEED,
  SHIP_R,
  Sim,
  SPAWN_R,
  STAR_KILL_R,
} from '../src/game/sim';
import { MODES } from '../src/modes';

const mk = (seed = 1, players = 2, mode = MODES.skirmish) => new Sim({ seed, mode, players });
const idle = (n: number): number[] => new Array(n).fill(0);

describe('P2P sync: the arena is a pure function of the seed', () => {
  it('two peers on the same seed build the identical arena', () => {
    const a = mk(1234);
    const b = mk(1234);
    expect(b.rocks).toEqual(a.rocks);
    expect(b.ships.map((s) => [s.x, s.y, s.ang])).toEqual(a.ships.map((s) => [s.x, s.y, s.ang]));
  });

  it('and stay identical through a few hundred steps of identical input', () => {
    const a = mk(99, 4);
    const b = mk(99, 4);
    for (let i = 0; i < 600; i++) {
      const inp = [IN_THRUST, IN_LEFT | IN_FIRE, IN_RIGHT, IN_FIRE];
      a.step(inp);
      b.step(inp);
    }
    expect(b.tick).toBe(a.tick);
    expect(b.ships.map((s) => [s.x, s.y, s.kills, s.deaths])).toEqual(
      a.ships.map((s) => [s.x, s.y, s.kills, s.deaths]),
    );
    expect(b.rocks.length).toBe(a.rocks.length);
  });

  it('different seeds give different arenas — the seed is actually used', () => {
    expect(mk(1).rocks).not.toEqual(mk(2).rocks);
  });
});

describe('the opening is fair by construction', () => {
  it('every seat starts the same distance from the star', () => {
    for (const players of [2, 3, 4]) {
      const sim = mk(7, players);
      const radii = sim.ships.map((s) => Math.hypot(s.x, s.y));
      for (const r of radii) expect(r).toBeCloseTo(SPAWN_R, 5);
    }
  });

  it('seats are evenly spaced around the ring, at every table size', () => {
    for (const players of [2, 3, 4]) {
      const sim = mk(7, players);
      const angles = sim.ships.map((s) => Math.atan2(s.y, s.x));
      for (let i = 0; i < players; i++) {
        const expected = (Math.PI * 2 * i) / players;
        // atan2 wraps to (-π, π]; compare on the unit circle to dodge the seam.
        expect(Math.cos(angles[i])).toBeCloseTo(Math.cos(expected), 5);
        expect(Math.sin(angles[i])).toBeCloseTo(Math.sin(expected), 5);
      }
    }
  });

  it('every seat starts with the identical speed — nobody spawns behind', () => {
    const sim = mk(7, 4);
    const speeds = sim.ships.map((s) => Math.hypot(s.vx, s.vy));
    for (const v of speeds) expect(v).toBeCloseTo(speeds[0], 5);
    expect(speeds[0]).toBeGreaterThan(0); // spawned INTO orbit, not at rest
  });

  it('nobody starts inside the star, or on a rock', () => {
    for (let seed = 0; seed < 40; seed++) {
      const sim = mk(seed, 4);
      for (const s of sim.ships) {
        expect(Math.hypot(s.x, s.y)).toBeGreaterThan(STAR_KILL_R + SHIP_R);
        for (const r of sim.rocks) expect(Math.hypot(s.x - r.x, s.y - r.y)).toBeGreaterThan(r.r + SHIP_R);
      }
    }
  });

  it('the spawn orbit actually holds — an idle ship does not fall into the star', () => {
    // The regression guard for the measured dead start: spawned at rest, the
    // first death landed at 2.8s and 3 of every 11 deaths were the star eating
    // someone who never chose to go near it.
    //
    // Rocks are cleared first, on purpose. This asks one question — does the
    // orbit hold — and an idle ship eventually meeting a drifting boulder is a
    // different (and correct) answer that would otherwise mask it.
    const sim = mk(5, 2);
    sim.rocks.length = 0;
    for (let i = 0; i < 60 * 30; i++) {
      sim.step(idle(2));
      sim.rocks.length = 0; // suppress the top-up too
    }
    for (const s of sim.ships) {
      expect(s.deaths).toBe(0);
      expect(Math.hypot(s.x, s.y)).toBeCloseTo(SPAWN_R, 0);
    }
  });
});

describe('flight', () => {
  it('thrust adds speed along the heading', () => {
    const sim = mk(1, 1);
    const s = sim.ships[0];
    s.vx = 0;
    s.vy = 0;
    s.ang = 0; // +x
    sim.step([IN_THRUST]);
    expect(s.vx).toBeGreaterThan(0);
  });

  it('rotation is symmetric — left and right cancel', () => {
    const sim = mk(1, 1);
    const a0 = sim.ships[0].ang;
    sim.step([IN_LEFT | IN_RIGHT]);
    expect(sim.ships[0].ang).toBeCloseTo(a0, 6);
  });

  it('speed is capped', () => {
    const sim = mk(1, 1);
    for (let i = 0; i < 600; i++) sim.step([IN_THRUST]);
    expect(Math.hypot(sim.ships[0].vx, sim.ships[0].vy)).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
  });

  it('nothing ever leaves the arena', () => {
    const sim = mk(3, 4);
    for (let i = 0; i < 60 * 30; i++) sim.step([IN_THRUST, IN_THRUST | IN_FIRE, IN_THRUST, IN_THRUST]);
    for (const s of sim.ships) expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(ARENA_R);
    for (const b of sim.bullets) expect(Math.hypot(b.x, b.y)).toBeLessThanOrEqual(ARENA_R + 1);
    for (const r of sim.rocks) expect(Math.hypot(r.x, r.y)).toBeLessThanOrEqual(ARENA_R);
  });

  it('gravity pulls bullets too — that is the whole game', () => {
    const sim = mk(1, 1);
    const s = sim.ships[0];
    // Park a ship and fire straight "up" (tangentially); the shot must bend.
    s.x = 0;
    s.y = -300;
    s.vx = 0;
    s.vy = 0;
    s.ang = 0;
    s.invuln = 99;
    sim.step([IN_FIRE]);
    const b = sim.bullets[0];
    expect(b).toBeTruthy();
    const vy0 = b.vy;
    for (let i = 0; i < 30; i++) sim.step([0]);
    // It started with no downward velocity and acquired some, toward the star.
    expect(b.vy).toBeGreaterThan(vy0);
  });

  it('the fire rate is limited — holding fire is not a laser', () => {
    const sim = mk(1, 1);
    for (let i = 0; i < 60; i++) sim.step([IN_FIRE]);
    // One second of held fire at a 0.28s cooldown is 3-4 shots, not 60.
    expect(sim.ships[0].shots).toBeLessThanOrEqual(5);
    expect(sim.ships[0].shots).toBeGreaterThanOrEqual(3);
  });
});

describe('death, lives and the end of a round', () => {
  it('the star kills, and costs a life', () => {
    const sim = mk(1, 2);
    const s = sim.ships[0];
    s.x = 0;
    s.y = 0;
    s.vx = 0;
    s.vy = 0;
    s.invuln = 0;
    const lives = s.lives;
    sim.step(idle(2));
    expect(s.alive).toBe(false);
    expect(s.lives).toBe(lives - 1);
    expect(s.deaths).toBe(1);
  });

  it('invulnerability protects — a fresh spawn cannot be farmed', () => {
    const sim = mk(1, 2);
    const s = sim.ships[0];
    s.x = 0;
    s.y = 0;
    s.invuln = 1;
    sim.step(idle(2));
    expect(s.alive).toBe(true);
  });

  it('a dead ship respawns into orbit, not at rest', () => {
    const sim = mk(1, 2);
    const s = sim.ships[0];
    s.x = 0;
    s.y = 0;
    s.invuln = 0;
    sim.step(idle(2));
    expect(s.alive).toBe(false);
    for (let i = 0; i < 60 * 2; i++) sim.step(idle(2));
    expect(s.alive).toBe(true);
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(0);
    // Near the ring, not pinned to it: the ship respawns ON it and then flies,
    // so a few units of drift by the time we look is the orbit working.
    expect(Math.abs(Math.hypot(s.x, s.y) - SPAWN_R)).toBeLessThan(5);
  });

  it('spending the last life puts a ship out, and ends a duel', () => {
    const sim = mk(1, 2);
    const s = sim.ships[0];
    for (let i = 0; i < 20 && !sim.over; i++) {
      s.x = 0;
      s.y = 0;
      s.vx = 0;
      s.vy = 0;
      s.invuln = 0;
      s.alive = true;
      s.respawn = 0;
      sim.step(idle(2));
    }
    expect(s.out).toBe(true);
    expect(sim.over).toBe(true);
    expect(sim.winner).toBe(1);
  });

  it('the round clock ends it, and the leader takes it', () => {
    // Rocks cleared so the round reaches the buzzer at all: left in, seat 1
    // idles into a boulder five times and the round ends by elimination — a
    // correct outcome, but not the one under test.
    const sim = mk(1, 2);
    sim.ships[1].kills = 3;
    for (let i = 0; i < 60 * MODES.skirmish.roundSeconds + 2 && !sim.over; i++) {
      sim.rocks.length = 0;
      sim.step(idle(2));
    }
    expect(sim.over).toBe(true);
    expect(sim.time).toBeGreaterThanOrEqual(MODES.skirmish.roundSeconds);
    expect(sim.winner).toBe(1);
  });

  it('a level score is a draw, not a win for seat 0', () => {
    // Asserted on leader() directly. Idling two ships for two minutes and
    // expecting a draw is a different claim — rocks drift, somebody dies, and
    // the deaths tiebreak (correctly) picks a winner.
    const sim = mk(1, 2);
    expect(sim.leader()).toBe(-1);
    sim.ships[0].kills = 2;
    sim.ships[1].kills = 2;
    expect(sim.leader()).toBe(-1);
  });

  it('a three-way level score is also a draw', () => {
    const sim = mk(1, 3);
    sim.ships.forEach((s) => (s.kills = 1));
    expect(sim.leader()).toBe(-1);
  });

  it('leader() breaks a kill tie on fewer deaths', () => {
    const sim = mk(1, 2);
    sim.ships[0].kills = 2;
    sim.ships[1].kills = 2;
    sim.ships[1].deaths = 1;
    expect(sim.leader()).toBe(0);
  });
});

describe('the wire cannot be trusted, and a missing input is not a freeze', () => {
  it('a missing input mask coasts that ship rather than stalling the round', () => {
    const sim = mk(1, 4);
    for (let i = 0; i < 120; i++) sim.step([IN_THRUST]); // only seat 0 reports
    expect(sim.tick).toBe(120);
    expect(sim.ships.every((s) => Number.isFinite(s.x))).toBe(true);
  });
});

describe('survival changes the ending, and only the ending', () => {
  it('clearing the arena does not end a survival run', () => {
    const sim = new Sim({ seed: 1, mode: MODES.skirmish, players: 1, survival: true });
    for (let i = 0; i < 300; i++) sim.step([0]);
    // Under the deathmatch rule "one ship left standing" this would be over.
    expect(sim.over).toBe(false);
  });

  it('but the player running out of lives does', () => {
    const sim = new Sim({ seed: 1, mode: MODES.skirmish, players: 1, survival: true });
    const s = sim.ships[0];
    for (let i = 0; i < 40 && !sim.over; i++) {
      s.x = 0;
      s.y = 0;
      s.vx = 0;
      s.vy = 0;
      s.invuln = 0;
      s.alive = true;
      s.respawn = 0;
      sim.step([0]);
    }
    expect(sim.over).toBe(true);
  });

  it('a survival run ignores the round clock', () => {
    // Rocks cleared: the question is whether the CLOCK ends the run, and a
    // player idling into a boulder would end it for an unrelated (correct) reason.
    const sim = new Sim({ seed: 1, mode: MODES.skirmish, players: 1, survival: true });
    for (let i = 0; i < 60 * (MODES.skirmish.roundSeconds + 2); i++) {
      sim.rocks.length = 0;
      sim.step([0]);
    }
    expect(sim.time).toBeGreaterThan(MODES.skirmish.roundSeconds);
    expect(sim.over).toBe(false);
  });
});
