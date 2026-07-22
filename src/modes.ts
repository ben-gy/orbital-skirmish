// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the three shapes a round can take.
 *
 * Every knob here changes the SPATIAL problem, not the size of a number. That is
 * the whole test a mode has to pass: if you can describe the difference as "the
 * same game but more X", it is a difficulty slider wearing a mode's name and it
 * gets cut. Two candidates were cut on exactly that ground — "more lives" and
 * "faster bullets" are both Skirmish with a dial turned.
 *
 * What survived:
 *
 *  - Skirmish. The well is a tool and the rocks are traffic. Baseline.
 *  - Nova. The star flares on a clock. The centre stops being a place you pass
 *    through and becomes a rhythm you read — the same ships, played on a
 *    different map every nine seconds.
 *  - Belt. The star is nearly irrelevant and the arena is full of rock. Bullets
 *    die on cover, so the fight is about lanes rather than orbits.
 *
 * The HOST's pick is what the room plays, and it travels frozen inside the round
 * start (engine/rematch.ts `roundOpts()`). A mode each peer read from its own UI
 * is a mode two peers can disagree about — and here that means two different
 * arenas on the same seed. Guests render `state().hostOpts`, never their own
 * local pick.
 */

export type ModeId = 'skirmish' | 'nova' | 'belt';

export interface Mode {
  id: ModeId;
  name: string;
  /** Gravitational parameter. Accel toward the star is G / r², clamped at STAR_R. */
  gravity: number;
  /** How many big rocks the arena holds. The sim tops back up to this. */
  rocks: number;
  /** Star flares on a cycle: kill radius swells and a shockwave throws everything out. */
  pulse: boolean;
  /** Seconds between flares. Ignored unless `pulse`. */
  pulsePeriod: number;
  /**
   * Lives per ship. Identical across modes on purpose — it is not a mode knob,
   * it is a balance constant, and it is PINNED by tests/balance.test.ts.
   *
   * Five, and the number was measured, not chosen. The sweep (300 bot-vs-bot
   * rounds per cell, pooled across six seed bases), reading P(whoever is ahead
   * at this fraction of the round goes on to win) — ahead meaning most lives,
   * then most kills, because this round is won by surviving:
   *
   *   lives  2P round  2P 15%→85%   4P round  4P 15%→85%
   *     3      17s      69% → 85%     16s      40% → 64%
   *     4      23s      60% → 85%     22s      41% → 74%
   *     5      30s      67% → 86%     27s      39% → 74%
   *     6      36s      70% → 84%     33s      46% → 72%
   *     7      42s      65% → 84%     39s      46% → 72%
   *
   * (chance is 50% at 2P, 25% at 4P.)
   *
   * Read the 4P column, which is where the spread lives. At 3 the endgame does
   * not resolve — the leader with a lap to go still loses a third of the time,
   * because five seconds is not long enough for anyone's advantage to mean
   * anything. At 6 and 7 the problem inverts: an early lead climbs to 46%,
   * because with that many lives the round is long enough for the better pilot
   * to simply compound. Five sits at the bottom of the early curve (39%) and the
   * top of the late one (74%) — the widest gap on offer, which is the "small
   * early game, big late game" lever in its purest form.
   *
   * The number survived a rewrite of the bot that quadrupled its accuracy (5% →
   * 20%) and halved the round. That is worth knowing: it is a property of the
   * game, not of the pilot that measured it.
   */
  lives: number;
  /**
   * Round clock (seconds) — a backstop, not a pacing device. Rounds average ~28s
   * and p90 is ~32s, so this is only ever reached by a stalemate.
   */
  roundSeconds: number;
  /** One line, shown under the name — what it FEELS like, not the numbers. */
  blurb: string;
}

export const MODES: Record<ModeId, Mode> = {
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    gravity: 3.75e6,
    rocks: 5,
    pulse: false,
    pulsePeriod: 0,
    lives: 5,
    roundSeconds: 120,
    blurb: 'The open arena. Use the well, respect the rocks.',
  },
  nova: {
    id: 'nova',
    name: 'Nova',
    gravity: 3.75e6,
    rocks: 3,
    pulse: true,
    pulsePeriod: 9,
    lives: 5,
    roundSeconds: 120,
    blurb: 'The star flares every nine seconds. Learn its clock or be thrown by it.',
  },
  belt: {
    id: 'belt',
    name: 'Belt',
    gravity: 1.1e6,
    rocks: 14,
    pulse: false,
    pulsePeriod: 0,
    lives: 5,
    roundSeconds: 120,
    blurb: 'A weak star and a crowded field. Cover is real. Bullets die on rock.',
  },
};

export const DEFAULT_MODE: ModeId = 'skirmish';

export const MODE_LIST: Mode[] = [MODES.skirmish, MODES.nova, MODES.belt];

/**
 * Resolve a mode id that arrived over the wire, out of a URL, or out of storage.
 *
 * Never trust it. An older peer, a corrupted store or a hand-edited message would
 * otherwise hand `undefined` to the sim, and `undefined.rocks` is not a crash —
 * it is an arena with NaN rocks and no gravity, which renders as an empty void
 * that never ends. Falling back keeps a mismatched peer playing Skirmish.
 *
 * `Object.hasOwn`, NOT a plain `MODES[id] || …`: MODES is an object literal, so
 * it inherits from Object.prototype and `MODES['constructor']` is the Object
 * function — truthy, so it sails through a naive guard and is returned AS a Mode
 * with every field undefined. That is the exact broken arena this function exists
 * to prevent, reached by the one input it exists to distrust. Same for
 * 'toString', 'valueOf' and friends. Pinned by tests/modes.test.ts.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id as ModeId];
  return MODES[DEFAULT_MODE];
}
