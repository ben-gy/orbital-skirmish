/**
 * bot.ts — an AI pilot, as a pure function of sim state.
 *
 * It exists twice over: it is Survival's opposition, and it is what plays the few
 * hundred headless rounds in tests/balance.test.ts. The second job is the one
 * that sets the quality bar. A bot that flies badly does not produce a gentle,
 * conservative balance reading — it produces a reading of the BOT, and every
 * conclusion drawn from it is about the wrong system. So this pilot has to
 * actually respect the well, lead its shots, and dodge rock.
 *
 * It is deterministic: seeded jitter, no Math.random. The jitter is not for
 * flavour — four identical pilots on a rotationally symmetric ring evolve
 * symmetrically and can stalemate forever, which would make the balance numbers
 * a measurement of the arena's symmetry rather than of the game.
 *
 * Priorities, strictly ordered. Staying alive beats shooting, always: the star
 * kills more often than any player does, and a pilot that trades a life for a
 * kill is not modelling how a human plays a 3-life round.
 */

import { makeRng, type Rng } from '../engine/rng';
import { IN_FIRE, IN_LEFT, IN_RIGHT, IN_THRUST, MUZZLE_SPEED, Sim, type Ship } from './sim';

/** Inside this, the well is winning and nothing else matters. */
const DANGER_PAD = 130;
/** Rocks inside this cone+range get dodged before anything is aimed at. */
const ROCK_FEAR = 92;
const AIM_TOLERANCE = 0.12; // rad
const FIRE_RANGE = 430;

export interface BotOptions {
  /** 0..1. Scales aim jitter and reaction. Survival ramps it; balance uses 1. */
  skill?: number;
}

export class Bot {
  readonly seat: number;
  private rng: Rng;
  private skill: number;
  private jitter = 0;
  private jitterT = 0;

  constructor(seed: number, seat: number, opts: BotOptions = {}) {
    this.seat = seat;
    // Per-seat stream so two seats never fly the same line from the same state.
    this.rng = makeRng(seed * 7919 + seat * 104_729 + 17);
    this.skill = opts.skill ?? 1;
  }

  /** Shortest signed angle from `a` to `b`, in (-π, π]. */
  private static delta(a: number, b: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /**
   * Where to shoot so the bullet and the target arrive together.
   *
   * Two corrections, and the second is the one that makes the bot look like it
   * understands the game: lead for the target's motion, then bend the aim
   * against the gravity the bullet will pick up on the way. Without the second
   * the bot shoots straight lines in a curved world and misses every shot that
   * crosses the well — which would have read, in the balance numbers, as "combat
   * is rare and the star decides everything".
   */
  private aimAt(sim: Sim, me: Ship, t: Ship): number {
    // The heading that solves the intercept, which is NOT the heading to the
    // target and not even the heading to where the target will be.
    //
    // The bullet leaves at (ship velocity + MUZZLE × heading), because a shot
    // inherits the ship's momentum — the trade that makes charging someone
    // brutal and running away feeble. At orbital speed that inherited term is
    // comparable to the muzzle speed itself, so pointing the NOSE at the
    // intercept sends the bullet somewhere else entirely. That single error was
    // most of the bot's ~5% hit rate, and no amount of lead refinement touches
    // it: it is not a prediction error, it is aiming the wrong vector.
    //
    // So: guess a flight time, work out where the target will be by then, work
    // out the velocity the bullet needs, and subtract the momentum it already
    // has. What is left is what the muzzle must supply. Three passes — every
    // term depends on the flight time and the flight time depends on the answer.
    let flight = Math.hypot(t.x - me.x, t.y - me.y) / MUZZLE_SPEED;
    let dirX = 1;
    let dirY = 0;

    for (let pass = 0; pass < 3; pass++) {
      // Where the target will be: it is in the same well, so it is curving too.
      const tr2 = Math.max(t.x * t.x + t.y * t.y, 1);
      const tr = Math.sqrt(tr2);
      const ta = sim.mode.gravity / tr2;
      let px = t.x + t.vx * flight - (t.x / tr) * 0.5 * ta * flight * flight;
      let py = t.y + t.vy * flight - (t.y / tr) * 0.5 * ta * flight * flight;

      // Where the bullet will fall on the way, sampled midway along its path.
      const mx = (me.x + px) / 2;
      const my = (me.y + py) / 2;
      const r2 = Math.max(mx * mx + my * my, 1);
      const r = Math.sqrt(r2);
      const drop = 0.5 * (sim.mode.gravity / r2) * flight * flight;
      px += (mx / r) * drop;
      py += (my / r) * drop;

      // The velocity the bullet must have, minus the velocity it is born with.
      const relX = px - me.x;
      const relY = py - me.y;
      const needX = relX / Math.max(flight, 1e-3) - me.vx;
      const needY = relY / Math.max(flight, 1e-3) - me.vy;
      const needLen = Math.hypot(needX, needY);
      if (needLen < 1e-3) break; // degenerate; keep the previous heading
      dirX = needX / needLen;
      dirY = needY / needLen;

      // Re-time it against the speed the bullet will ACTUALLY travel at.
      const bvx = me.vx + dirX * MUZZLE_SPEED;
      const bvy = me.vy + dirY * MUZZLE_SPEED;
      flight = Math.hypot(relX, relY) / Math.max(Math.hypot(bvx, bvy), 1);
    }
    return Math.atan2(dirY, dirX);
  }

  /**
   * The nearest live enemy — scanned from the seat AFTER this one, not from
   * seat 0.
   *
   * The scan order is a fairness constant, which is not obvious and cost a
   * measurement to find. The natural version iterates sim.ships in seat order
   * and keeps the strictly-closest, so an EXACT distance tie silently resolves
   * to the lowest seat. Ties are supposed to be a curiosity — except the opening
   * is a rotationally symmetric ring, where they are guaranteed: at the 3P start
   * every ship is exactly 120° from both rivals. So seat 1 and seat 2 both opened
   * on seat 0 while seat 0 opened on seat 1, and the round began 2-on-1 against a
   * seat chosen by array index. Over 800 games the 3P seats read 36.8/28.8/34.5
   * (χ²≈8.2, p≈0.017).
   *
   * The bug was mine, not the game's: real players do not tie-break by seat
   * index, so that spread was the balance sim measuring the BOT. Rotating the
   * scan start makes each pilot open on "the next seat around", which is
   * symmetric under the same rotation the arena is, so the sim measures the arena
   * again. Pinned by tests/bot.test.ts.
   */
  private nearestEnemy(sim: Sim, me: Ship): Ship | null {
    let best: Ship | null = null;
    let bestD = Infinity;
    const n = sim.ships.length;
    for (let k = 1; k <= n; k++) {
      const s = sim.ships[(me.seat + k) % n];
      if (!s || s.seat === me.seat || !s.alive || s.out) continue;
      const d = Math.hypot(s.x - me.x, s.y - me.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** The rock most about to matter, or null. */
  private threatRock(sim: Sim, me: Ship): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD = ROCK_FEAR;
    for (const r of sim.rocks) {
      const d = Math.hypot(r.x - me.x, r.y - me.y) - r.r;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  input(sim: Sim): number {
    const me = sim.ships.find((s) => s.seat === this.seat);
    if (!me || !me.alive || me.out) return 0;

    this.jitterT -= 1;
    if (this.jitterT <= 0) {
      this.jitterT = 18 + Math.floor(this.rng() * 26);
      this.jitter = (this.rng() - 0.5) * 0.5 * (1 - this.skill * 0.7);
    }

    const r = Math.hypot(me.x, me.y);
    const kill = sim.killRadius();
    let want: number;
    let thrust = false;
    let mayFire = false;

    const rock = this.threatRock(sim, me);

    if (r < kill + DANGER_PAD) {
      // The well is winning. Burn straight out — no aiming, no cleverness.
      want = Math.atan2(me.y, me.x);
      thrust = true;
    } else if (rock) {
      // Rock in the face: turn side-on to it and burn away.
      want = Math.atan2(me.y - rock.y, me.x - rock.x);
      thrust = true;
    } else {
      const t = this.nearestEnemy(sim, me);
      if (!t) {
        // Nobody to fight — hold a stable orbit rather than drifting into the star.
        want = Math.atan2(me.y, me.x) + Math.PI / 2;
        thrust = Math.hypot(me.vx, me.vy) < 120;
      } else {
        want = this.aimAt(sim, me, t) + this.jitter;
        const dist = Math.hypot(t.x - me.x, t.y - me.y);
        mayFire = dist < FIRE_RANGE;
        // Close the gap when far, but never burn toward the star to do it.
        thrust = dist > 220 && r > kill + DANGER_PAD * 1.6;
      }
    }

    const d = Bot.delta(me.ang, want);
    let out = 0;
    if (d < -0.04) out |= IN_LEFT;
    else if (d > 0.04) out |= IN_RIGHT;
    if (thrust && Math.abs(d) < 0.6) out |= IN_THRUST;
    if (mayFire && Math.abs(d) < AIM_TOLERANCE) out |= IN_FIRE;
    return out;
  }
}
