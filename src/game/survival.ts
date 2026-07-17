/**
 * survival.ts — the solo run: you, five lives, and waves that keep coming.
 *
 * This is the mode that has to be fun in the first five seconds with nobody else
 * online, so it is what the menu's Play button starts. It is a thin wrapper over
 * the same Sim the deathmatch uses — same physics, same star, same rocks. Only
 * the terminal condition and the opposition differ, which is exactly why the
 * balance work done on the deathmatch carries over for free.
 *
 * The ramp is deliberately shallow at the start. Wave 1 is two clumsy pilots, so
 * you get to learn that thrusting is a commitment before anything punishes you
 * for it. Skill climbs faster than headcount: more enemies is a crowd, better
 * enemies is a fight, and only one of those is interesting.
 */

import { Bot } from './bot';
import { Sim, type Ship } from './sim';
import type { Mode } from '../modes';

/** Wave n fields this many hostiles. Capped so the arena never gridlocks. */
export function waveSize(wave: number): number {
  return Math.min(2 + Math.floor((wave - 1) / 2), 5);
}

/** Enemy competence, 0..1. Reaches expert around wave 8 and stops. */
export function waveSkill(wave: number): number {
  return Math.min(0.35 + (wave - 1) * 0.09, 1);
}

export const SCORE_KILL = 100;
export const SCORE_ROCK = 25;
/** Clearing a wave pays a bonus that scales — the reason to push one more wave. */
export const SCORE_WAVE = 250;

export interface SurvivalState {
  wave: number;
  score: number;
  lives: number;
  over: boolean;
}

export class Survival {
  readonly sim: Sim;
  wave = 1;
  score = 0;
  private bots = new Map<number, Bot>();
  private nextSeat = 1;
  private seed: number;
  /** Beat between a wave clearing and the next arriving, in seconds. */
  private lull = 0;
  /**
   * The player's counters as of the END of the last step. The delta against them
   * is what scores. Held across steps rather than sampled inside one, so the
   * score is a function of the ship's history and not of where in this function
   * the read happens.
   */
  private lastKills = 0;
  private lastRocks = 0;

  constructor(seed: number, mode: Mode) {
    this.seed = seed;
    // Seat 0 is the player, alone on the ring; `players: 1` puts them at angle 0.
    this.sim = new Sim({ seed, mode, players: 1, survival: true });
    this.spawnWave();
  }

  private spawnWave(): void {
    const n = waveSize(this.wave);
    const skill = waveSkill(this.wave);
    for (let i = 0; i < n; i++) {
      const seat = this.nextSeat++;
      // Ring slots for the wave: spread them around the player, not on top of
      // them. `players` here is only the angle divisor — a hostile at slot i of n
      // sits at 2πi/n, which is the same rotational fairness the deathmatch uses.
      const ship = this.sim.addShip(seat, n, 1);
      // Nudge the wave off the player's own slot so nothing spawns in your lap.
      const a = (Math.PI * 2 * (i + 0.5)) / n;
      const r = Math.hypot(ship.x, ship.y);
      const v = Math.hypot(ship.vx, ship.vy);
      ship.x = Math.cos(a) * r;
      ship.y = Math.sin(a) * r;
      ship.vx = -Math.sin(a) * v;
      ship.vy = Math.cos(a) * v;
      ship.ang = a + Math.PI / 2;
      this.bots.set(seat, new Bot(this.seed + this.wave * 31, seat, { skill }));
    }
  }

  private hostiles(): Ship[] {
    return this.sim.ships.filter((s) => s.seat !== 0 && !s.out);
  }

  /** Advance one sim step. `playerInput` is seat 0's bitmask. */
  step(playerInput: number): void {
    if (this.sim.over) return;

    const inputs: number[] = [];
    inputs[0] = playerInput;
    for (const [seat, bot] of this.bots) inputs[seat] = bot.input(this.sim);
    this.sim.step(inputs);

    // Score off the ship's own counters, never off the arena.
    //
    // The obvious version — "did rocks.length go down?" — is wrong twice over: a
    // big rock SPLITS, so shooting one makes the array grow, and a rock falling
    // into the star shrinks it without anyone having earned a thing. Both bugs
    // pay out on the wrong event. These counters only move when a bullet this
    // player fired actually connected with something.
    const me = this.sim.ships[0];
    this.score += (me.kills - this.lastKills) * SCORE_KILL;
    this.score += (me.rocksBroken - this.lastRocks) * SCORE_ROCK;
    this.lastKills = me.kills;
    this.lastRocks = me.rocksBroken;

    if (this.sim.over) return;
    if (this.hostiles().length === 0) {
      if (this.lull === 0) {
        this.score += SCORE_WAVE * this.wave;
        this.lull = 1.6;
      } else {
        this.lull -= 1 / 60;
        if (this.lull <= 0) {
          this.lull = 0;
          this.wave++;
          this.spawnWave();
        }
      }
    }
  }

  state(): SurvivalState {
    return {
      wave: this.wave,
      score: this.score,
      lives: Math.max(0, this.sim.ships[0]?.lives ?? 0),
      over: this.sim.over,
    };
  }
}
