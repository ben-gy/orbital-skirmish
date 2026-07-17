/**
 * sim.ts — the whole game, as a pure function of (seed, mode, inputs).
 *
 * No DOM, no rAF, no Math.random, no clock. Everything that happens here is
 * decided by the seed, the mode and the per-tick input bitmasks. That is not
 * tidiness for its own sake — three things depend on it:
 *
 *  1. The balance sim (tests/balance.test.ts) plays a few hundred bot-vs-bot
 *     rounds headless. It cannot do that if the game needs a canvas.
 *  2. The host-transfer test promotes a client core and drives it to game-over
 *     with no network in sight.
 *  3. P2P sync. Rock spawns, splits and respawn points come from the seeded rng,
 *     so a peer never has to be told what the arena did — only where things are.
 *
 * Coordinates are world units: a circle of radius ARENA_R centred on (0,0), with
 * the star at the origin. y is positive DOWN (screen convention), which matters
 * only for rendering — the physics is rotationally symmetric, so the sign never
 * shows up in a fairness question.
 *
 * THE ONE INVARIANT WORTH GUARDING: gravity applies to ships, bullets AND rocks,
 * identically. The moment bullets stop falling, aiming becomes point-and-click
 * and the game is gone. Every constant below was allowed to move during tuning
 * except that one.
 */

import { makeRng, randFloat, type Rng } from '../engine/rng';
import type { Mode } from '../modes';

// ── arena ────────────────────────────────────────────────────────────────────

export const ARENA_R = 500;
export const STAR_R = 26;
/** Touch this and you die. Swells during a Nova flare. */
export const STAR_KILL_R = 32;
/** How far the kill radius reaches at the peak of a flare. */
export const FLARE_KILL_R = 96;
/** Seconds for a flare to decay back to nothing. */
export const FLARE_DECAY = 1.4;
/** Outward impulse a flare imparts at the star's surface, falling off with r. */
export const FLARE_PUSH = 240_000;

export const SHIP_R = 9;
export const BULLET_R = 3;
export const ROCK_BIG_R = 26;
export const ROCK_SMALL_R = 14;

/** Fixed simulation step. Everything is expressed per-second and scaled by it. */
export const STEP = 1 / 60;

// ── ship ─────────────────────────────────────────────────────────────────────

export const ROT_SPEED = 3.2; // rad/s
export const THRUST = 260; // units/s²
export const MAX_SPEED = 420;
export const FIRE_COOL = 0.28; // s
export const RESPAWN_DELAY = 1.5; // s
export const INVULN = 2.0; // s
export const SPAWN_R = 340;
/** Rim restitution. Below 1 so slamming the wall costs you the orbit. */
export const RIM_BOUNCE = 0.6;

// ── bullet ───────────────────────────────────────────────────────────────────

export const MUZZLE_SPEED = 300;
export const BULLET_LIFE = 2.2; // s

// ── rock ─────────────────────────────────────────────────────────────────────

export const ROCK_MIN_DRIFT = 20;
export const ROCK_MAX_DRIFT = 70;
/** Rocks are topped back up to the mode's count on this cadence. */
export const ROCK_RESPAWN = 3.0; // s

// ── input ────────────────────────────────────────────────────────────────────

export const IN_LEFT = 1;
export const IN_RIGHT = 2;
export const IN_THRUST = 4;
export const IN_FIRE = 8;

// ── entities ─────────────────────────────────────────────────────────────────

export interface Ship {
  /** Seat index. Identical on every peer — it comes from the frozen roster. */
  seat: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ang: number;
  alive: boolean;
  /** Lives left. At 0 with alive=false the ship is `out`. */
  lives: number;
  out: boolean;
  cool: number;
  invuln: number;
  respawn: number;
  thrusting: boolean;
  // stats — the results screen shows every one of these, for every player
  kills: number;
  deaths: number;
  shots: number;
  /**
   * Bullets that hit a SHIP. Rocks are counted separately in `rocksBroken`, on
   * purpose: folding them in here would let a player pad their accuracy by
   * shooting the scenery, and accuracy is only interesting as a measure of
   * whether you can hit a thing that is dodging.
   */
  hits: number;
  rocksBroken: number;
  streak: number;
  bestStreak: number;
}

export interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  owner: number;
}

export interface Rock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  big: boolean;
}

export type EventKind = 'shot' | 'hit' | 'boom' | 'split' | 'flare' | 'spawn' | 'star';

export interface SimEvent {
  t: EventKind;
  x: number;
  y: number;
  /** Seat this concerns, where it means anything. */
  p: number;
}

export interface SimConfig {
  seed: number;
  mode: Mode;
  /** Number of seats. Ships are placed on a rotationally symmetric ring. */
  players: number;
  /** Lives override — survival gives its wave ships exactly 1. */
  livesOverride?: number;
  /**
   * Survival changes the terminal condition, and nothing else.
   *
   * Deathmatch ends when one ship is left standing. Survival cannot use that
   * rule: clearing a wave leaves exactly one ship alive — you — which would end
   * the run at the moment you won it. Here the run ends only when seat 0 is out,
   * and the round clock does not apply.
   */
  survival?: boolean;
}

// ── the sim ──────────────────────────────────────────────────────────────────

export class Sim {
  readonly mode: Mode;
  readonly seed: number;
  readonly survival: boolean;
  /**
   * How many respawn slots the ring is divided into. MUST be a multiple of the
   * seat count — see respawnShip(). Pinned by tests/sim.test.ts.
   */
  readonly slots: number;
  private rng: Rng;

  tick = 0;
  /** Round time in seconds. Host-authoritative; drives the clock and the flare. */
  time = 0;
  ships: Ship[] = [];
  bullets: Bullet[] = [];
  rocks: Rock[] = [];
  /** Drained every frame by the renderer / audio. Never gameplay-relevant. */
  events: SimEvent[] = [];
  over = false;
  /** Seat of the winner, or -1 for a draw / not yet decided. */
  winner = -1;
  /** 0..1 — how bright the star is flaring right now. */
  flare = 0;
  private pulseT = 0;
  private rockTimer = 0;

  constructor(cfg: SimConfig) {
    this.mode = cfg.mode;
    this.seed = cfg.seed;
    this.survival = cfg.survival ?? false;
    // ~8-9 slots, always an exact multiple of the seat count. See respawnShip():
    // the multiple is the fairness property, the count is the resolution, and
    // they are separate concerns. (2P→8, 3P→9, 4P→8.) Dropping 2P to a bare 4
    // satisfied the multiple and measurably hurt the duel — too few places to
    // respawn and the loser is predictable.
    this.slots = cfg.players * Math.max(2, Math.ceil(8 / cfg.players));
    this.rng = makeRng(cfg.seed);
    const lives = cfg.livesOverride ?? cfg.mode.lives;
    for (let i = 0; i < cfg.players; i++) this.ships.push(this.makeShip(i, cfg.players, lives));
    for (let i = 0; i < cfg.mode.rocks; i++) this.rocks.push(this.makeRock(true));
  }

  /**
   * Seat i sits at angle 2πi/n on the spawn ring, facing prograde.
   *
   * Rotational symmetry is not decoration — it is the seat-fairness guarantee.
   * Every seat starts the same distance from the star, the same distance from
   * the rim, and the same distance from both its neighbours. Hexbloom's 3P seats
   * shipped at 54/33/10 because nobody checked the opening geometry; here the
   * geometry makes it true by construction and balance.test.ts checks it anyway.
   */
  private makeShip(seat: number, players: number, lives: number): Ship {
    const a = (Math.PI * 2 * seat) / players;
    const v = this.orbitalV(SPAWN_R);
    return {
      seat,
      x: Math.cos(a) * SPAWN_R,
      y: Math.sin(a) * SPAWN_R,
      // Spawned INTO ORBIT, not at rest. See orbitalV().
      vx: -Math.sin(a) * v,
      vy: Math.cos(a) * v,
      ang: a + Math.PI / 2, // prograde — same relative heading for everyone
      alive: true,
      lives,
      out: false,
      cool: 0,
      invuln: INVULN,
      respawn: 0,
      thrusting: false,
      kills: 0,
      deaths: 0,
      shots: 0,
      hits: 0,
      rocksBroken: 0,
      streak: 0,
      bestStreak: 0,
    };
  }

  /**
   * A rock from the outer field, never within CLEARANCE of a living ship.
   *
   * The clearance is not politeness, it is the opening-fairness rule. Rocks are
   * seeded across a radial band that CONTAINS the spawn ring, so the naive
   * version happily placed a 26-unit boulder on top of a ship before the round
   * began — measured at 29.6 units centre-to-centre against a 35-unit contact
   * distance, i.e. already overlapping. The victim spawns with 2s of
   * invulnerability, so it does not read as a bug; it reads as "I got unlucky",
   * which is worse. Same rule for the mid-round top-up, where there is no
   * invulnerability to hide behind and a rock materialising on your nose is
   * simply an unearned death.
   *
   * Rejection sampling, bounded and seeded: deterministic across peers, and it
   * terminates whatever the arena looks like.
   */
  private makeRock(big: boolean): Rock {
    const radius = big ? ROCK_BIG_R : ROCK_SMALL_R;
    const clearance = radius + SHIP_R + 40;
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = randFloat(this.rng, 0, Math.PI * 2);
      const r = randFloat(this.rng, ARENA_R * 0.62, ARENA_R * 0.94);
      x = Math.cos(a) * r;
      y = Math.sin(a) * r;
      const clash = this.ships.some((s) => s.alive && !s.out && Math.hypot(s.x - x, s.y - y) < clearance);
      if (!clash) break;
    }
    const dir = randFloat(this.rng, 0, Math.PI * 2);
    const spd = randFloat(this.rng, ROCK_MIN_DRIFT, ROCK_MAX_DRIFT);
    return {
      x,
      y,
      vx: Math.cos(dir) * spd,
      vy: Math.sin(dir) * spd,
      r: radius,
      big,
    };
  }

  /** Add a seat mid-round. Survival's waves use this; deathmatch never does. */
  addShip(seat: number, players: number, lives: number): Ship {
    const s = this.makeShip(seat, players, lives);
    this.ships.push(s);
    return s;
  }

  /**
   * Tangential speed for a circular orbit at radius r: v = sqrt(G/r).
   *
   * Ships spawn ON this, prograde. It sounds like flavour and it is not — it is
   * the fix for a measured dead start. Spawning at rest in a gravity well meant
   * the opening state of every round was "everyone is falling into the star":
   * the first death landed at 2.8s (the instant spawn invulnerability expired)
   * and 3 of every 11 deaths were the star eating someone who never chose to go
   * near it. A round lasted 21 seconds, so the game had no middle, let alone an
   * end. Now the arena holds you and the well is something you SPEND, by
   * thrusting out of a stable orbit to go and pick a fight.
   *
   * Every seat gets the identical speed in the identical relative direction, so
   * the rotational symmetry that guarantees seat fairness is untouched — which
   * the seat-rate assertions in balance.test.ts check rather than assume.
   */
  private orbitalV(r: number): number {
    return Math.sqrt(this.mode.gravity / Math.max(r, STAR_R));
  }

  private grav(x: number, y: number): { ax: number; ay: number } {
    const r2 = Math.max(x * x + y * y, STAR_R * STAR_R);
    const r = Math.sqrt(r2);
    const a = this.mode.gravity / r2;
    return { ax: (-x / r) * a, ay: (-y / r) * a };
  }

  /** Current lethal radius of the star, including any live flare. */
  killRadius(): number {
    return STAR_KILL_R + this.flare * FLARE_KILL_R;
  }

  private shockwave(): void {
    const push = (e: { x: number; y: number; vx: number; vy: number }): void => {
      const r2 = Math.max(e.x * e.x + e.y * e.y, STAR_R * STAR_R);
      const r = Math.sqrt(r2);
      const imp = FLARE_PUSH / r2;
      e.vx += (e.x / r) * imp;
      e.vy += (e.y / r) * imp;
    };
    for (const s of this.ships) if (s.alive) push(s);
    for (const b of this.bullets) push(b);
    for (const r of this.rocks) push(r);
  }

  /**
   * Advance exactly one STEP.
   *
   * `inputs[i]` is seat i's bitmask this tick. A missing entry is 0 — that is
   * deliberate and load-bearing: a peer whose input packet was dropped, or who
   * closed their tab, coasts rather than freezing the round for everyone else.
   */
  step(inputs: readonly number[]): void {
    if (this.over) return;
    this.tick++;
    this.time += STEP;

    // ── star ──
    if (this.mode.pulse) {
      this.pulseT += STEP;
      if (this.pulseT >= this.mode.pulsePeriod) {
        this.pulseT = 0;
        this.flare = 1;
        this.events.push({ t: 'flare', x: 0, y: 0, p: -1 });
        this.shockwave();
      }
    }
    if (this.flare > 0) this.flare = Math.max(0, this.flare - STEP / FLARE_DECAY);

    const kr = this.killRadius();

    // ── ships ──
    for (const s of this.ships) {
      if (s.out) continue;
      if (!s.alive) {
        s.respawn -= STEP;
        if (s.respawn <= 0) this.respawnShip(s);
        continue;
      }
      const inp = inputs[s.seat] ?? 0;
      if (inp & IN_LEFT) s.ang -= ROT_SPEED * STEP;
      if (inp & IN_RIGHT) s.ang += ROT_SPEED * STEP;
      s.thrusting = (inp & IN_THRUST) !== 0;
      if (s.thrusting) {
        s.vx += Math.cos(s.ang) * THRUST * STEP;
        s.vy += Math.sin(s.ang) * THRUST * STEP;
      }
      const g = this.grav(s.x, s.y);
      s.vx += g.ax * STEP;
      s.vy += g.ay * STEP;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > MAX_SPEED) {
        s.vx = (s.vx / sp) * MAX_SPEED;
        s.vy = (s.vy / sp) * MAX_SPEED;
      }
      s.x += s.vx * STEP;
      s.y += s.vy * STEP;
      this.rimBounce(s, SHIP_R);

      if (s.cool > 0) s.cool -= STEP;
      if (s.invuln > 0) s.invuln -= STEP;

      if (Math.hypot(s.x, s.y) < kr + SHIP_R && s.invuln <= 0) {
        this.events.push({ t: 'star', x: s.x, y: s.y, p: s.seat });
        this.killShip(s, -1);
        continue;
      }
      if (inp & IN_FIRE && s.cool <= 0) this.fire(s);
    }

    // ── bullets ──
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const g = this.grav(b.x, b.y);
      b.vx += g.ax * STEP;
      b.vy += g.ay * STEP;
      b.x += b.vx * STEP;
      b.y += b.vy * STEP;
      b.life -= STEP;
      const d = Math.hypot(b.x, b.y);
      // The rim absorbs; the star eats. Neither bounces a bullet — a ricocheting
      // bullet field reads as noise and you stop being able to tell whose shot
      // is whose, which is the one thing a 4-way dogfight cannot afford.
      if (b.life <= 0 || d > ARENA_R || d < kr) {
        this.bullets.splice(i, 1);
      }
    }

    // ── rocks ──
    for (const r of this.rocks) {
      const g = this.grav(r.x, r.y);
      r.vx += g.ax * STEP;
      r.vy += g.ay * STEP;
      r.x += r.vx * STEP;
      r.y += r.vy * STEP;
      this.rimBounce(r, r.r);
    }
    // A rock that falls into the star is gone — that is the well doing its job.
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      if (Math.hypot(this.rocks[i].x, this.rocks[i].y) < kr + this.rocks[i].r) {
        this.events.push({ t: 'split', x: this.rocks[i].x, y: this.rocks[i].y, p: -1 });
        this.rocks.splice(i, 1);
      }
    }
    this.rockTimer += STEP;
    if (this.rockTimer >= ROCK_RESPAWN) {
      this.rockTimer = 0;
      if (this.rocks.filter((r) => r.big).length < this.mode.rocks) this.rocks.push(this.makeRock(true));
    }

    this.collide();
    this.checkOver();
  }

  private rimBounce(e: { x: number; y: number; vx: number; vy: number }, r: number): void {
    const d = Math.hypot(e.x, e.y);
    const lim = ARENA_R - r;
    if (d <= lim) return;
    const nx = e.x / d;
    const ny = e.y / d;
    e.x = nx * lim;
    e.y = ny * lim;
    const dot = e.vx * nx + e.vy * ny;
    e.vx = (e.vx - 2 * dot * nx) * RIM_BOUNCE;
    e.vy = (e.vy - 2 * dot * ny) * RIM_BOUNCE;
  }

  private fire(s: Ship): void {
    s.cool = FIRE_COOL;
    s.shots++;
    this.bullets.push({
      x: s.x + Math.cos(s.ang) * (SHIP_R + 2),
      y: s.y + Math.sin(s.ang) * (SHIP_R + 2),
      // Inheriting ship velocity is what makes a fleeing shot weak and a charging
      // shot brutal — the trade that keeps thrusting a decision.
      vx: s.vx + Math.cos(s.ang) * MUZZLE_SPEED,
      vy: s.vy + Math.sin(s.ang) * MUZZLE_SPEED,
      life: BULLET_LIFE,
      owner: s.seat,
    });
    this.events.push({ t: 'shot', x: s.x, y: s.y, p: s.seat });
  }

  private collide(): void {
    // bullets → ships
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      let consumed = false;
      for (const s of this.ships) {
        if (!s.alive || s.out || s.invuln > 0) continue;
        if (s.seat === b.owner) continue;
        if (Math.hypot(s.x - b.x, s.y - b.y) > SHIP_R + BULLET_R) continue;
        const killer = this.ships.find((k) => k.seat === b.owner);
        if (killer) {
          killer.hits++;
          killer.kills++;
          killer.streak++;
          killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
        }
        this.events.push({ t: 'hit', x: b.x, y: b.y, p: s.seat });
        this.killShip(s, b.owner);
        consumed = true;
        break;
      }
      if (consumed) {
        this.bullets.splice(i, 1);
        continue;
      }
      // bullets → rocks
      for (let j = this.rocks.length - 1; j >= 0; j--) {
        const r = this.rocks[j];
        if (Math.hypot(r.x - b.x, r.y - b.y) > r.r + BULLET_R) continue;
        this.splitRock(j);
        const owner = this.ships.find((k) => k.seat === b.owner);
        if (owner) owner.rocksBroken++;
        this.bullets.splice(i, 1);
        break;
      }
    }
    // rocks → ships
    for (const s of this.ships) {
      if (!s.alive || s.out || s.invuln > 0) continue;
      for (const r of this.rocks) {
        if (Math.hypot(s.x - r.x, s.y - r.y) > SHIP_R + r.r) continue;
        this.events.push({ t: 'hit', x: s.x, y: s.y, p: s.seat });
        this.killShip(s, -1);
        break;
      }
    }
  }

  private splitRock(idx: number): void {
    const r = this.rocks[idx];
    this.events.push({ t: 'split', x: r.x, y: r.y, p: -1 });
    this.rocks.splice(idx, 1);
    if (!r.big) return;
    for (let k = 0; k < 2; k++) {
      const a = randFloat(this.rng, 0, Math.PI * 2);
      const spd = randFloat(this.rng, ROCK_MIN_DRIFT, ROCK_MAX_DRIFT * 1.4);
      this.rocks.push({
        x: r.x + Math.cos(a) * ROCK_SMALL_R,
        y: r.y + Math.sin(a) * ROCK_SMALL_R,
        vx: r.vx + Math.cos(a) * spd,
        vy: r.vy + Math.sin(a) * spd,
        r: ROCK_SMALL_R,
        big: false,
      });
    }
  }

  /** `by` is the killer's seat, or -1 for the star / a rock / the rim. */
  private killShip(s: Ship, by: number): void {
    s.alive = false;
    s.deaths++;
    s.streak = 0;
    s.lives--;
    s.thrusting = false;
    this.events.push({ t: 'boom', x: s.x, y: s.y, p: s.seat });
    if (by === -1) {
      // Killing yourself on the scenery must cost the same as being shot, or the
      // star stops being scary and the arena becomes a place you park.
      s.streak = 0;
    }
    if (s.lives <= 0) {
      s.out = true;
      return;
    }
    s.respawn = RESPAWN_DELAY;
  }

  /**
   * Respawn at whichever ring slot is furthest from trouble.
   *
   * Deterministic: it scans a fixed candidate set and scores it, so every peer
   * (and every replay of a seed) picks the same slot. A random respawn would be
   * a desync waiting to happen AND would occasionally drop you on the nose of
   * the person who just killed you.
   *
   * THE SLOT COUNT IS A FAIRNESS CONSTANT, not a resolution knob.
   *
   * It was 8, hard-coded, and that was a measured seat bug. Eight slots sit at
   * 45°, which is 4-fold symmetric — fine for four seats (0/90/180/270), where
   * every home is a slot and the grid maps onto itself under a quarter turn.
   * With THREE seats (0/120/240) it is not commensurate at all: seat 0's home is
   * a slot and seats 1 and 2's homes fall between them, so the respawn grid
   * quietly broke the arena's 3-fold symmetry. Over 800 games the 3P seats read
   * 36.8 / 28.8 / 34.5 against a 33.3 chance (χ²≈8.2, p≈0.017) while 4P and Belt
   * sat dead level — which is exactly the shape of a bug you cannot see by
   * playing, and exactly what hexbloom's 54/33/10 was.
   *
   * `players * 2` is n-fold symmetric by construction at every table size, so
   * every seat sees an identical arena under rotation. Pinned by a test, because
   * "8" looks like a harmless magic number and would be reintroduced by anyone
   * tidying up.
   */
  private respawnShip(s: Ship): void {
    let best = 0;
    let bestScore = -Infinity;
    for (let k = 0; k < this.slots; k++) {
      const a = (Math.PI * 2 * k) / this.slots;
      const x = Math.cos(a) * SPAWN_R;
      const y = Math.sin(a) * SPAWN_R;
      let score = Infinity;
      for (const o of this.ships) {
        if (o.seat === s.seat || !o.alive || o.out) continue;
        score = Math.min(score, Math.hypot(o.x - x, o.y - y));
      }
      for (const r of this.rocks) score = Math.min(score, Math.hypot(r.x - x, r.y - y) - r.r);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    const a = (Math.PI * 2 * best) / this.slots;
    const v = this.orbitalV(SPAWN_R);
    s.x = Math.cos(a) * SPAWN_R;
    s.y = Math.sin(a) * SPAWN_R;
    // Back into orbit, exactly as at spawn — a respawn at rest would drop you
    // straight back down the well you just died in.
    s.vx = -Math.sin(a) * v;
    s.vy = Math.cos(a) * v;
    s.ang = a + Math.PI / 2;
    s.alive = true;
    s.invuln = INVULN;
    s.respawn = 0;
    this.events.push({ t: 'spawn', x: s.x, y: s.y, p: s.seat });
  }

  private checkOver(): void {
    if (this.survival) {
      // Clearing a wave leaves you as the only ship alive. Under the deathmatch
      // rule that would end the run at the exact moment you won it.
      if (this.ships[0]?.out) {
        this.over = true;
        this.winner = -1;
      }
      return;
    }
    const live = this.ships.filter((s) => !s.out);
    if (live.length <= 1 && this.ships.length > 1) {
      this.over = true;
      this.winner = live.length === 1 ? live[0].seat : -1;
      return;
    }
    if (this.time >= this.mode.roundSeconds) {
      this.over = true;
      this.winner = this.leader();
    }
  }

  /**
   * Seat currently ahead, or -1 if tied. Kills first, then fewest deaths — the
   * tiebreak matters because the clock expiring on a level score is common.
   */
  leader(): number {
    let best: Ship | null = null;
    let tied = false;
    for (const s of this.ships) {
      if (!best) {
        best = s;
        continue;
      }
      const c = s.kills - best.kills || best.deaths - s.deaths;
      if (c > 0) {
        best = s;
        tied = false;
      } else if (c === 0) tied = true;
    }
    return !best || tied ? -1 : best.seat;
  }

  /** Everyone still holding a life. Used by survival's wave check. */
  aliveCount(): number {
    return this.ships.filter((s) => !s.out).length;
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
