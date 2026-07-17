/**
 * bot.test.ts — the pilot, and the one property the balance sim depends on.
 *
 * The bot is not just Survival's opposition; it is the instrument
 * tests/balance.test.ts measures the game with. So an asymmetry in the BOT reads
 * as an asymmetry in the GAME, and every conclusion drawn from it is about the
 * wrong system. That is not hypothetical — it happened here, and the "seat 0 wins
 * 3P too often" finding it produced survived two rounds of investigation before
 * the sim traced it home.
 */

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/game/bot';
import { IN_FIRE, IN_THRUST, Sim, STAR_KILL_R } from '../src/game/sim';
import { MODES } from '../src/modes';

const mk = (seed = 1, players = 4) => new Sim({ seed, mode: MODES.skirmish, players });

describe('the pilot is rotationally symmetric, like the arena', () => {
  /**
   * Which seat does the bot at `seat` fly at? Read off its steering: it turns
   * toward its target, so the sign of the turn identifies the pick. Placing the
   * ships by hand is the point — the ring built from cos/sin lands ties a few
   * ULPs apart, and this asks what happens on a REAL tie.
   */
  function pickOf(sim: Sim, seat: number): number {
    const me = sim.ships[seat];
    const bot = new Bot(1, seat, { skill: 1 });
    const mask = bot.input(sim);
    // Turn direction toward each candidate; the one it turns toward is the pick.
    let best = -1;
    let bestErr = Infinity;
    for (const s of sim.ships) {
      if (s.seat === seat) continue;
      const want = Math.atan2(s.y - me.y, s.x - me.x);
      let d = (want - me.ang) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const turningLeft = (mask & 1) !== 0;
      const turningRight = (mask & 2) !== 0;
      const consistent = (d < 0 && turningLeft) || (d > 0 && turningRight);
      const err = consistent ? Math.abs(d) : Math.abs(d) + 10;
      if (err < bestErr) {
        bestErr = err;
        best = s.seat;
      }
    }
    return best;
  }

  it('breaks an EXACT tie away from seat 0, so the ring opens as a cycle', () => {
    // Four ships on the axes: every diagonal distance is hypot(340,340),
    // computed identically, so these ties are exact rather than nearly so. On a
    // symmetric ring ties are not a curiosity, they are the opening position.
    //
    // Scanning sim.ships in seat order resolves all of them to the lowest seat:
    // picks become 0→1, 1→0, 2→1, 3→0, and the round starts as a dogpile on
    // seats 0 and 1, chosen by array index. No human tie-break resembles that,
    // so the balance sim was measuring the BOT. Scanning from the seat AFTER
    // self makes the picks a rotation: every ship targeted exactly once.
    const sim = mk(1, 4);
    const P: [number, number][] = [
      [340, 0],
      [0, 340],
      [-340, 0],
      [0, -340],
    ];
    sim.ships.forEach((s, i) => {
      s.x = P[i][0];
      s.y = P[i][1];
      s.vx = 0;
      s.vy = 0;
      s.invuln = 0;
    });
    const picks = sim.ships.map((s) => pickOf(sim, s.seat));
    expect(new Set(picks).size, `picks were ${picks.join(',')}`).toBe(4);
    expect(picks).not.toContain(-1);
  });

  it('nobody targets themselves', () => {
    const sim = mk(1, 4);
    for (const s of sim.ships) expect(pickOf(sim, s.seat)).not.toBe(s.seat);
  });
});

describe('the pilot flies competently enough to measure the game with', () => {
  it('is deterministic — same seed, same seat, same flight', () => {
    const runOne = (): number[] => {
      const sim = mk(9, 2);
      const bots = [new Bot(9, 0), new Bot(9, 1)];
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        const inp = bots.map((b) => b.input(sim));
        out.push(...inp);
        sim.step(inp);
      }
      return out;
    };
    expect(runOne()).toEqual(runOne());
  });

  it('never returns a bitmask with junk in it', () => {
    const sim = mk(2, 4);
    const bots = sim.ships.map((s) => new Bot(2, s.seat));
    for (let i = 0; i < 400; i++) {
      const inp = bots.map((b) => b.input(sim));
      for (const m of inp) {
        expect(Number.isInteger(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(15);
      }
      sim.step(inp);
    }
  });

  it('returns nothing for a dead or eliminated ship', () => {
    const sim = mk(2, 2);
    sim.ships[0].alive = false;
    expect(new Bot(2, 0).input(sim)).toBe(0);
    sim.ships[0].alive = true;
    sim.ships[0].out = true;
    expect(new Bot(2, 0).input(sim)).toBe(0);
  });

  it('burns away from the star when the well is winning', () => {
    const sim = mk(2, 2);
    const me = sim.ships[0];
    // Dropped just outside the kill radius, drifting in.
    me.x = STAR_KILL_R + 40;
    me.y = 0;
    me.vx = 0;
    me.vy = 0;
    me.ang = 0; // already pointing outward (+x)
    const mask = new Bot(2, 0).input(sim);
    expect(mask & IN_THRUST).toBeTruthy();
  });

  it('does not fire at nothing', () => {
    const sim = mk(2, 1); // no enemies at all
    let fired = 0;
    const bot = new Bot(2, 0);
    for (let i = 0; i < 200; i++) {
      if (bot.input(sim) & IN_FIRE) fired++;
      sim.step([bot.input(sim)]);
    }
    expect(fired).toBe(0);
  });

  it('actually gets kills — a bot that cannot shoot measures nothing', () => {
    // If this ever reads 0, the balance suite is measuring an empty arena and
    // every number in it is meaningless.
    let kills = 0;
    for (let seed = 0; seed < 12; seed++) {
      const sim = new Sim({ seed, mode: MODES.skirmish, players: 4 });
      const bots = sim.ships.map((s) => new Bot(seed, s.seat));
      for (let i = 0; i < 60 * 40 && !sim.over; i++) sim.step(bots.map((b) => b.input(sim)));
      kills += sim.ships.reduce((a, s) => a + s.kills, 0);
    }
    expect(kills).toBeGreaterThan(12 * 3);
  });

  it('a better pilot beats a worse one — which is what Survival`s ramp sells', () => {
    // Asserted head-to-head, not on accuracy. Accuracy is hits/shots, and a
    // jittery pilot ALSO fires less (it rarely settles inside the firing cone),
    // so the ratio moves for two reasons at once and the comparison says nothing.
    // Winning is the property the wave ramp actually promises.
    let expertWins = 0;
    let noviceWins = 0;
    for (let seed = 0; seed < 40; seed++) {
      const sim = new Sim({ seed, mode: MODES.skirmish, players: 2 });
      // Alternate seats so the (small) seat effect cannot decide this.
      const expertSeat = seed % 2;
      const bots = [
        new Bot(seed, 0, { skill: expertSeat === 0 ? 1 : 0.3 }),
        new Bot(seed, 1, { skill: expertSeat === 1 ? 1 : 0.3 }),
      ];
      for (let i = 0; i < 60 * (MODES.skirmish.roundSeconds + 2) && !sim.over; i++) {
        sim.step(bots.map((b) => b.input(sim)));
      }
      if (sim.winner < 0) continue;
      if (sim.winner === expertSeat) expertWins++;
      else noviceWins++;
    }
    expect(expertWins).toBeGreaterThan(noviceWins);
  });
});
