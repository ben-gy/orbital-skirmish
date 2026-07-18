import { describe, it, expect } from 'vitest';
import { autoSteer } from '../src/steer';
import { IN_LEFT, IN_RIGHT, IN_THRUST } from '../src/game/sim';

const has = (m: number, bit: number): boolean => (m & bit) !== 0;

describe('autoSteer — analog stick → rotate/thrust bits', () => {
  it('thrusts straight ahead and does not turn when already aligned', () => {
    const m = autoSteer(0.5, 0.5);
    expect(has(m, IN_THRUST)).toBe(true);
    expect(has(m, IN_LEFT)).toBe(false);
    expect(has(m, IN_RIGHT)).toBe(false);
  });

  it('turns toward a target that is clockwise (larger angle) with IN_RIGHT', () => {
    // want ahead of facing by ~0.5rad → err > 0 → IN_RIGHT (increases ang).
    const m = autoSteer(0.5, 0.0);
    expect(has(m, IN_RIGHT)).toBe(true);
    expect(has(m, IN_LEFT)).toBe(false);
    expect(has(m, IN_THRUST)).toBe(true); // within the thrust cone
  });

  it('turns the other way (IN_LEFT) for a counter-clockwise target', () => {
    const m = autoSteer(-0.5, 0.0);
    expect(has(m, IN_LEFT)).toBe(true);
    expect(has(m, IN_RIGHT)).toBe(false);
  });

  it('does NOT thrust while facing well away from the target (turn first)', () => {
    // Target roughly behind (π away) → must turn, must not thrust backwards.
    const m = autoSteer(Math.PI, 0.0);
    expect(has(m, IN_THRUST)).toBe(false);
    // Some turn is commanded.
    expect(has(m, IN_LEFT) || has(m, IN_RIGHT)).toBe(true);
  });

  it('takes the SHORTEST way around the ±π wrap', () => {
    // Facing 3.0, target -3.0 (≈ +2.98 apart the long way, but only ~0.28 the
    // short way through π). Shortest turn is toward -π side → IN_RIGHT.
    const m = autoSteer(-3.0, 3.0);
    expect(has(m, IN_RIGHT)).toBe(true);
    expect(has(m, IN_LEFT)).toBe(false);
    expect(has(m, IN_THRUST)).toBe(true); // it's a small error → within cone
  });

  it('respects the dead band — a tiny error is treated as aligned', () => {
    const m = autoSteer(0.05, 0.0); // 0.05 < 0.1 deadband
    expect(has(m, IN_LEFT)).toBe(false);
    expect(has(m, IN_RIGHT)).toBe(false);
    expect(has(m, IN_THRUST)).toBe(true);
  });
});
