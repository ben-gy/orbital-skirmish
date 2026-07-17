/**
 * survival.test.ts — the solo run, which is the game most people will play.
 *
 * Multiplayer is an option behind a room code; this is what the Play button
 * starts, and it has to be fun with nobody else online. The ramp and the scoring
 * are the whole of it.
 */

import { describe, expect, it } from 'vitest';
import { SCORE_KILL, SCORE_ROCK, SCORE_WAVE, Survival, waveSize, waveSkill } from '../src/game/survival';
import { MODES } from '../src/modes';

describe('the wave ramp', () => {
  it('opens gently — wave 1 is two pilots, not a swarm', () => {
    expect(waveSize(1)).toBe(2);
  });

  it('never fields more than the arena can hold', () => {
    for (let w = 1; w < 60; w++) expect(waveSize(w)).toBeLessThanOrEqual(5);
  });

  it('grows, but never shrinks', () => {
    for (let w = 2; w < 40; w++) expect(waveSize(w)).toBeGreaterThanOrEqual(waveSize(w - 1));
  });

  it('climbs skill faster than headcount — a fight, not a crowd', () => {
    // More enemies is a crowd; better enemies is a fight, and only one of those
    // is interesting. Skill saturates before the headcount does.
    expect(waveSkill(1)).toBeLessThan(waveSkill(4));
    expect(waveSkill(9)).toBe(1);
    expect(waveSkill(30)).toBe(1); // saturates rather than climbing forever
    for (let w = 1; w < 40; w++) {
      expect(waveSkill(w)).toBeGreaterThan(0);
      expect(waveSkill(w)).toBeLessThanOrEqual(1);
    }
  });
});

describe('a run', () => {
  it('starts with hostiles already in the air', () => {
    const s = new Survival(7, MODES.skirmish);
    expect(s.sim.ships.length).toBe(1 + waveSize(1));
    expect(s.state().wave).toBe(1);
    expect(s.state().score).toBe(0);
  });

  it('puts the player on seat 0 with the mode`s lives, and hostiles on one', () => {
    const s = new Survival(7, MODES.skirmish);
    expect(s.sim.ships[0].seat).toBe(0);
    expect(s.sim.ships[0].lives).toBe(MODES.skirmish.lives);
    for (const h of s.sim.ships.slice(1)) expect(h.lives).toBe(1);
  });

  it('never spawns a hostile on top of the player', () => {
    for (let seed = 0; seed < 30; seed++) {
      const s = new Survival(seed, MODES.skirmish);
      const me = s.sim.ships[0];
      for (const h of s.sim.ships.slice(1)) {
        expect(Math.hypot(h.x - me.x, h.y - me.y)).toBeGreaterThan(60);
      }
    }
  });

  it('is deterministic from its seed', () => {
    const a = new Survival(11, MODES.skirmish);
    const b = new Survival(11, MODES.skirmish);
    for (let i = 0; i < 600; i++) {
      a.step(0);
      b.step(0);
    }
    expect(b.state()).toEqual(a.state());
    expect(b.sim.ships.map((s) => [s.x, s.y])).toEqual(a.sim.ships.map((s) => [s.x, s.y]));
  });

  it('runs on past the round clock — survival has no buzzer', () => {
    const s = new Survival(11, MODES.skirmish);
    for (let i = 0; i < 60 * (MODES.skirmish.roundSeconds + 2) && !s.state().over; i++) s.step(0);
    // Either it is still going, or the player died. What must NOT happen is the
    // clock quietly ending a run that was going fine.
    if (!s.state().over) expect(s.sim.time).toBeGreaterThan(MODES.skirmish.roundSeconds);
  });

  it('ends when the player is out of lives', () => {
    const s = new Survival(11, MODES.skirmish);
    const me = s.sim.ships[0];
    for (let i = 0; i < 60 && !s.state().over; i++) {
      me.x = 0;
      me.y = 0;
      me.vx = 0;
      me.vy = 0;
      me.invuln = 0;
      me.alive = true;
      me.respawn = 0;
      s.step(0);
    }
    expect(s.state().over).toBe(true);
    expect(s.state().lives).toBe(0);
  });
});

describe('scoring pays for what you did, never for what the arena did', () => {
  it('a kill pays, once', () => {
    const s = new Survival(3, MODES.skirmish);
    const before = s.state().score;
    s.sim.ships[0].kills += 1;
    s.step(0);
    expect(s.state().score).toBe(before + SCORE_KILL);
    // And it does not keep paying every step for the same kill.
    s.step(0);
    expect(s.state().score).toBe(before + SCORE_KILL);
  });

  it('breaking a rock pays', () => {
    const s = new Survival(3, MODES.skirmish);
    const before = s.state().score;
    s.sim.ships[0].rocksBroken += 1;
    s.step(0);
    expect(s.state().score).toBe(before + SCORE_ROCK);
  });

  it('a rock the STAR ate pays nothing', () => {
    // The obvious implementation — "did rocks.length go down?" — pays out here,
    // and you would farm points by parking and waiting. It also pays NEGATIVELY
    // when you shoot a big rock, because splitting makes the array grow.
    const s = new Survival(3, MODES.skirmish);
    const before = s.state().score;
    s.sim.rocks.length = 0; // as if the star swallowed every one of them
    s.step(0);
    expect(s.state().score).toBe(before);
  });

  it('splitting a big rock pays once, not minus one', () => {
    const s = new Survival(3, MODES.skirmish);
    const before = s.state().score;
    const rocks = s.sim.rocks.length;
    s.sim.ships[0].rocksBroken += 1;
    s.sim.rocks.push({ ...s.sim.rocks[0], big: false }); // the split's offspring
    s.step(0);
    expect(s.sim.rocks.length).toBeGreaterThan(rocks);
    expect(s.state().score).toBe(before + SCORE_ROCK);
  });

  it('clearing a wave pays a bonus that scales with the wave', () => {
    const s = new Survival(3, MODES.skirmish);
    for (const h of s.sim.ships.slice(1)) h.out = true;
    const before = s.state().score;
    s.step(0);
    expect(s.state().score).toBe(before + SCORE_WAVE * 1);
  });

  it('and then the next wave actually arrives', () => {
    const s = new Survival(3, MODES.skirmish);
    for (const h of s.sim.ships.slice(1)) h.out = true;
    for (let i = 0; i < 200 && s.state().wave === 1; i++) s.step(0);
    expect(s.state().wave).toBe(2);
    expect(s.sim.ships.filter((x) => x.seat !== 0 && !x.out).length).toBe(waveSize(2));
  });
});
