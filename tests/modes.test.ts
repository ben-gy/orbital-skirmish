/**
 * modes.test.ts — the host's mode is what the room plays.
 *
 * A mode changes gravity, the rock count and whether the star flares, so two
 * peers resolving it differently are not playing at different difficulties —
 * they are in different arenas on the same seed, watching each other's ships
 * curve through geometry that is not there. The mode therefore travels frozen
 * inside the round start, and an id off the wire is never trusted.
 *
 * The failure worth pinning is not a crash. An unresolved mode does not throw:
 * `undefined.gravity` inside Sim would make every acceleration NaN, and NaN
 * coordinates render as nothing at all. You would get a black arena that never
 * ends, with no error anywhere.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_LIST, MODES, modeOf } from '../src/modes';
import { Sim } from '../src/game/sim';

/** Does this mode actually produce a finite, simulable world? */
function simulable(mode: ReturnType<typeof modeOf>): boolean {
  const sim = new Sim({ seed: 7, mode, players: 2 });
  for (let i = 0; i < 120; i++) sim.step([0, 0]);
  return sim.ships.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y));
}

describe('modeOf', () => {
  it('resolves a known id', () => {
    expect(modeOf('skirmish').id).toBe('skirmish');
    expect(modeOf('nova').pulse).toBe(true);
    expect(modeOf('belt').rocks).toBe(14);
  });

  it('falls back rather than handing the Sim an undefined gravity', () => {
    // A start from an older peer, a corrupted store, or a hand-edited message.
    for (const bad of [undefined, null, '', 'nope', 42, {}, ['skirmish']]) {
      const m = modeOf(bad as unknown);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isFinite(m.gravity)).toBe(true);
      expect(Number.isInteger(m.rocks)).toBe(true);
      expect(Number.isFinite(m.roundSeconds)).toBe(true);
    }
  });

  it('resolves a hostile id off the wire without inheriting from Object', () => {
    // MODES is an object literal, so 'constructor' / 'toString' are truthy on it.
    // Returning one of those as a Mode would put `undefined` in every field —
    // the exact NaN arena the fallback above exists to prevent, reached through
    // the one input it exists to distrust.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const m = modeOf(bad);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isFinite(m.gravity)).toBe(true);
      expect(simulable(m)).toBe(true);
    }
  });
});

describe('the three modes are three different games', () => {
  it('every mode builds a world that simulates without going NaN', () => {
    for (const m of MODE_LIST) expect(simulable(m), m.id).toBe(true);
  });

  it('no two modes are the same round', () => {
    const shapes = new Set(MODE_LIST.map((m) => `${m.gravity}/${m.rocks}/${m.pulse}`));
    expect(shapes.size).toBe(MODE_LIST.length);
  });

  it('each mode changes the SPATIAL problem, not a difficulty dial', () => {
    // Nova is the only one where the star has a clock…
    expect(MODES.nova.pulse).toBe(true);
    expect(MODES.skirmish.pulse).toBe(false);
    expect(MODES.belt.pulse).toBe(false);
    // …and Belt is the only one where the well stops mattering and the rock
    // starts. A mode that only moved `lives` or a speed would fail this.
    expect(MODES.belt.gravity).toBeLessThan(MODES.skirmish.gravity / 2);
    expect(MODES.belt.rocks).toBeGreaterThan(MODES.skirmish.rocks * 2);
  });

  it('Nova actually flares inside a round, or it is just Skirmish', () => {
    const sim = new Sim({ seed: 3, mode: MODES.nova, players: 2 });
    let flared = false;
    for (let i = 0; i < 60 * (MODES.nova.pulsePeriod + 1); i++) {
      sim.step([0, 0]);
      if (sim.flare > 0.5) flared = true;
    }
    expect(flared).toBe(true);
  });

  it('the flare really does swell the kill radius', () => {
    const sim = new Sim({ seed: 3, mode: MODES.nova, players: 2 });
    const rest = sim.killRadius();
    for (let i = 0; i < 60 * (MODES.nova.pulsePeriod + 0.1); i++) sim.step([0, 0]);
    expect(sim.killRadius()).toBeGreaterThan(rest * 2);
  });
});
