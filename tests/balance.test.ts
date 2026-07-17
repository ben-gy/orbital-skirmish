/**
 * balance.test.ts — is it still a game on second five?
 *
 * The other suites prove the rules WORK. None of them can tell you the winner is
 * already decided. Hexbloom shipped 34 green tests and a clean production check
 * while whoever led after 3 moves won 64% of the time — a snowball is invisible
 * to unit tests and to a 90-second playtest. This is the file that asks whether
 * the round is a contest, and it referees every balance constant in the game.
 *
 * It plays fixed-seed bot-vs-bot rounds headless on sim.ts and asserts the SHAPE
 * of the outcome: P(leader at t=N eventually wins) flat and near chance early and
 * rising only late; seat win rate level at 2P/3P/4P; blowouts and round length
 * bounded.
 *
 * TWO THINGS THIS FILE LEARNED THE HARD WAY, both worth keeping:
 *
 *  1. POOL THE SEED SETS. An earlier version of this test ran one seed sequence
 *     (1000 + 37g) and reported seat 0 winning 31% of 4P rounds against a 25%
 *     chance — stable across four separate sweeps, which made it look like a real
 *     geometric edge worth "fixing". It was not. It was that seed set. Pooled over
 *     five independent bases (n=750) the seats read 25.2/23.3/25.2/26.4. A fix
 *     shipped against that phantom would have introduced a real asymmetry to
 *     cancel an imaginary one. So: every seat assertion below pools bases.
 *
 *  2. BUCKET AGAINST THE REAL ROUND. The first version sampled at 45s and 60s of
 *     a round that ends at 28s, so those buckets had n=0, and "the leader at 60s
 *     never wins" is not a balance finding — it is arithmetic on an empty set.
 *     Hence the `late.n` assertion below: a bucket has to have samples before its
 *     percentage means anything.
 *
 *  3. THE PILOT IS PART OF THE INSTRUMENT. This suite measures the game THROUGH
 *     tests/bot.ts, so a flaw in the bot reads as a flaw in the game. Two were
 *     found that way. Its target scan resolved exact ties by array index, which
 *     on a symmetric ring meant the whole table opened on seat 0 — that produced
 *     a "3P seat bias" (χ²≈8.2, p≈0.017) that was never in the game at all. And
 *     its aim ignored that bullets inherit ship momentum, holding it to a 5% hit
 *     rate: combat was so ineffective that the STAR was deciding rounds, and
 *     every number here was really a measurement of the environment. Fixing that
 *     took accuracy to 20% and halved the round. If these numbers move, suspect
 *     the pilot before the game.
 *
 * Deterministic and seeded: no Math.random, same numbers on every machine.
 * Run `BALANCE_REPORT=1 npx vitest run tests/balance.test.ts` to print the curves.
 */

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/game/bot';
import { Sim } from '../src/game/sim';
import { MODES, type Mode } from '../src/modes';

/**
 * Sampled at FRACTIONS of each round's own duration, not at fixed seconds.
 *
 * Absolute buckets cannot answer this question. Rounds here run ~28s, so a "30s"
 * bucket samples only the rounds that lasted longer than average — the close,
 * grinding ones — and reports a number conditioned on the very thing being
 * measured. Push the bucket earlier to fix the sample and it stops being late
 * enough to be an endgame: at 25s the 4P curve read +1 point, at 30s it read
 * +10, and neither is the truth. Both are artefacts of asking a fixed clock
 * about a variable-length round.
 *
 * By fraction, every round contributes to every bucket exactly once, so "the
 * leader at the 85% mark" means the same thing in a 16s round and a 50s one.
 */
const BUCKETS = [0.15, 0.35, 0.6, 0.85] as const;
/** How often the leader is sampled while a round plays out, in seconds. */
const SAMPLE_EVERY = 0.5;

/** Five independent seed sequences. See note 1 in the header — this matters. */
const SEED_SETS: readonly [number, number][] = [
  [1000, 37],
  [50_000, 91],
  [777_777, 13],
  [31_337, 211],
  [9_000_001, 53],
];

const REPORT = !!process.env.BALANCE_REPORT;

interface Round {
  winner: number;
  seconds: number;
  leaderAt: number[];
  margin: number;
}

/**
 * Who is actually WINNING right now: most lives, then most kills. -1 if tied.
 *
 * Not Sim.leader(), which ranks by kills — that is the right rule for the round
 * clock (a timeout should reward aggression) and the wrong question here. This
 * round is won by being the last ship alive, so lives are the currency and kills
 * are the tiebreak. Measuring the kill leader instead produced a flat curve that
 * bottomed out at 39% conversion at the 85% mark: it was faithfully reporting
 * that the top scorer often loses, which is true, and not what "is the winner
 * already decided" is asking.
 */
function leading(sim: Sim): number {
  let best = -1;
  let bestKey = [-1, -1];
  let tied = false;
  for (const s of sim.ships) {
    const key = [s.out ? -1 : s.lives, s.kills];
    const c = key[0] - bestKey[0] || key[1] - bestKey[1];
    if (c > 0) {
      best = s.seat;
      bestKey = key;
      tied = false;
    } else if (c === 0) tied = true;
  }
  return tied ? -1 : best;
}

function playRound(seed: number, mode: Mode, players: number): Round {
  const sim = new Sim({ seed, mode, players });
  const bots = Array.from({ length: players }, (_, i) => new Bot(seed, i));
  /** Who led at each half-second. Post-processed into fractions once we know how long the round was. */
  const timeline: number[] = [];
  let nextSample = 0;

  // Hard step ceiling. A round that cannot end is itself a finding, and an
  // unbounded loop in a test hangs CI instead of failing it.
  const maxSteps = Math.ceil((mode.roundSeconds + 2) * 60);
  for (let i = 0; i < maxSteps && !sim.over; i++) {
    sim.step(bots.map((b) => b.input(sim)));
    while (sim.time >= nextSample) {
      timeline.push(leading(sim));
      nextSample += SAMPLE_EVERY;
    }
  }

  const leaderAt = BUCKETS.map((f) =>
    timeline.length ? timeline[Math.min(timeline.length - 1, Math.floor(f * (timeline.length - 1)))] : -1,
  );
  const k = sim.ships.map((s) => s.kills).sort((a, b) => b - a);
  return { winner: sim.winner, seconds: sim.time, leaderAt, margin: k[0] - (k[1] ?? 0) };
}

/** `perSet` rounds from EACH seed base — never one sequence. */
function runSet(mode: Mode, players: number, perSet: number): Round[] {
  const out: Round[] = [];
  for (const [base, stride] of SEED_SETS)
    for (let g = 0; g < perSet; g++) out.push(playRound(base + g * stride, mode, players));
  return out;
}

/** P(the seat leading at bucket i went on to win), ignoring ties at that bucket. */
function leaderConversion(rounds: Round[], i: number): { p: number; n: number } {
  let n = 0;
  let won = 0;
  for (const r of rounds) {
    if (r.leaderAt[i] < 0) continue;
    n++;
    if (r.leaderAt[i] === r.winner) won++;
  }
  return { p: n ? won / n : 0, n };
}

function seatRates(rounds: Round[], players: number): number[] {
  const c: number[] = new Array(players).fill(0);
  let decided = 0;
  for (const r of rounds) {
    if (r.winner < 0) continue;
    decided++;
    c[r.winner]++;
  }
  return c.map((x) => (decided ? (x / decided) * 100 : 0));
}

function report(label: string, rounds: Round[], players: number): void {
  if (!REPORT) return;
  const curve = BUCKETS.map((b, i) => {
    const { p, n } = leaderConversion(rounds, i);
    return `${(b * 100).toFixed(0)}%in:${n >= 20 ? (p * 100).toFixed(0) + '%' : '·'}`;
  }).join('  ');
  const secs = rounds.reduce((a, r) => a + r.seconds, 0) / rounds.length;
  // eslint-disable-next-line no-console
  console.log(
    `[${label}] n=${rounds.length} chance=${(100 / players).toFixed(0)}%  ` +
      `seats ${seatRates(rounds, players).map((r) => r.toFixed(0)).join('/')}  ` +
      `avg ${secs.toFixed(0)}s  blow ${((rounds.filter((r) => r.margin >= 6).length / rounds.length) * 100).toFixed(0)}%\n` +
      `  leader→win ${curve}`,
  );
}

describe('balance: the round is still a contest', () => {
  /**
   * 80 per base × 5 bases = 400 rounds per table size. The whole file is ~7s.
   *
   * That n is not padding, it is the price of the test meaning anything. At 250
   * the seat rates swing ±8 points on noise alone, which is the same size as the
   * real bias this suite found — so the referee could not tell its own signal
   * from its own error, and both a false alarm and a miss were one reseed away.
   *
   * The 8-point tolerances below are ~3σ at n=400 (the standard error on a 4-way
   * seat rate here is ~2.2 points). Tight enough to catch a real bias — the two
   * this suite actually found had 8-point spreads, and hexbloom's shipped
   * disaster was a 44-point one — and loose enough that noise cannot redden the
   * suite on an unrelated change. Do not tighten them without raising n to match,
   * or you are pinning the noise instead of the game.
   */
  const PER_SET = 80;

  describe('Skirmish 4P', () => {
    const rounds = runSet(MODES.skirmish, 4, PER_SET);
    it('baseline', () => {
      report('skirmish 4P', rounds, 4);
      expect(rounds.length).toBe(PER_SET * SEED_SETS.length);
    });

    it('every round terminates, and not all of them on the buzzer', () => {
      for (const r of rounds) expect(r.seconds).toBeLessThanOrEqual(MODES.skirmish.roundSeconds + 0.5);
      // If they ALL run to the clock, nobody is dying and the fight is decorative.
      expect(rounds.filter((r) => r.seconds >= MODES.skirmish.roundSeconds).length / rounds.length).toBeLessThan(0.2);
    });

    it('an early lead is not a prophecy', () => {
      // Chance is 25%. Leading a sixth of the way in should be worth something —
      // you are, after all, ahead — but it must not be the whole round.
      expect(leaderConversion(rounds, 0).p).toBeLessThan(0.5);
      expect(leaderConversion(rounds, 1).p).toBeLessThan(0.6);
    });

    it('the lead means MORE late than early — that curve is the drama', () => {
      const early = leaderConversion(rounds, 0);
      const late = leaderConversion(rounds, BUCKETS.length - 1);
      // Every round contributes to every fractional bucket, so a thin `n` here
      // would mean the rounds themselves are missing, not the bucket.
      expect(late.n).toBeGreaterThan(rounds.length / 2);
      expect(late.p).toBeGreaterThan(early.p + 0.08);
    });

    it('no seat is privileged by the spawn ring', () => {
      for (const r of seatRates(rounds, 4)) expect(Math.abs(r - 25)).toBeLessThan(8);
    });

    it('blowouts are the exception', () => {
      expect(rounds.filter((r) => r.margin >= 6).length / rounds.length).toBeLessThan(0.25);
    });
  });

  describe('seat fairness at every table size', () => {
    it('2P seats are level, and the duel is not decided by first blood', () => {
      const rounds = runSet(MODES.skirmish, 2, PER_SET);
      report('skirmish 2P', rounds, 2);
      for (const r of seatRates(rounds, 2)) expect(Math.abs(r - 50)).toBeLessThan(8);
      // At 3 lives this read 61% and first blood effectively won the duel.
      expect(leaderConversion(rounds, 0).p).toBeLessThan(0.66);
    });

    it('3P seats are level — the count hexbloom never did', () => {
      const rounds = runSet(MODES.skirmish, 3, PER_SET);
      report('skirmish 3P', rounds, 3);
      for (const r of seatRates(rounds, 3)) expect(Math.abs(r - 33.3)).toBeLessThan(8);
    });
  });

  describe('the other two modes are contests too', () => {
    it('Nova: the flare does not decide the round', () => {
      const rounds = runSet(MODES.nova, 4, 60);
      report('nova 4P', rounds, 4);
      for (const r of seatRates(rounds, 4)) expect(Math.abs(r - 25)).toBeLessThan(10);
      expect(leaderConversion(rounds, 0).p).toBeLessThan(0.55);
    });

    it('Belt: crowded, but still winnable from behind', () => {
      const rounds = runSet(MODES.belt, 4, 60);
      report('belt 4P', rounds, 4);
      for (const r of seatRates(rounds, 4)) expect(Math.abs(r - 25)).toBeLessThan(10);
      expect(leaderConversion(rounds, 0).p).toBeLessThan(0.55);
    });
  });

  describe('the constants the fairness depends on are pinned', () => {
    it('lives is 5 — measured, not chosen (see modes.ts)', () => {
      // At 3 this game is a 23-second scramble whose duel is decided by first
      // blood. If someone "simplifies" it back to 3, this fails and says why.
      for (const m of [MODES.skirmish, MODES.nova, MODES.belt]) expect(m.lives).toBe(5);
    });

    it('lives is not a mode knob — every mode agrees', () => {
      const uniq = new Set([MODES.skirmish.lives, MODES.nova.lives, MODES.belt.lives]);
      expect(uniq.size).toBe(1);
    });

    it('the respawn grid is an exact multiple of the seat count', () => {
      // It was a hard-coded 8, which is 4-fold symmetric: fine at 4 seats, and
      // NOT commensurate with 3, where it broke the arena's rotational symmetry.
      // "8" looks like a harmless magic number, which is exactly why it needs a
      // test rather than a comment.
      for (const players of [2, 3, 4]) {
        const sim = new Sim({ seed: 1, mode: MODES.skirmish, players });
        expect(sim.slots % players, `${players}P`).toBe(0);
        expect(sim.slots).toBeGreaterThanOrEqual(players * 2);
      }
    });
  });
});
