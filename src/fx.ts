// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * fx.ts — particles, screen shake, hit-stop.
 *
 * Purely cosmetic and deliberately so: nothing here is ever read by the Sim, so
 * a client that drops a particle is not a client that disagrees about the world.
 *
 * Everything degrades to nothing under prefers-reduced-motion — shake to zero,
 * particles to a short-lived handful. The game stays legible either way, because
 * none of this carries information the HUD does not.
 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

export class Fx {
  particles: Particle[] = [];
  private shakeAmt = 0;
  private shakeT = 0;
  /** Seconds of frozen time remaining. Render still runs; the sim does not. */
  private stop = 0;
  private reduced: boolean;
  /** Hard cap — a 4-way brawl in Belt can otherwise out-particle a phone. */
  private static MAX = 320;

  constructor(reducedMotion: boolean) {
    this.reduced = reducedMotion;
  }

  burst(x: number, y: number, color: string, count: number, speed: number, life = 0.6): void {
    const n = this.reduced ? Math.min(count, 4) : count;
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= Fx.MAX) return;
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life,
        max: life,
        size: 1.5 + Math.random() * 2,
        color,
      });
    }
  }

  /** A single trail dot — cheap enough to emit every frame while thrusting. */
  trail(x: number, y: number, vx: number, vy: number, color: string): void {
    if (this.reduced || this.particles.length >= Fx.MAX) return;
    this.particles.push({
      x,
      y,
      vx: vx + (Math.random() - 0.5) * 30,
      vy: vy + (Math.random() - 0.5) * 30,
      life: 0.35,
      max: 0.35,
      size: 1 + Math.random() * 1.6,
      color,
    });
  }

  ring(x: number, y: number, color: string, count = 28): void {
    this.burst(x, y, color, count, 260, 0.5);
  }

  shake(amount: number, seconds = 0.25): void {
    if (this.reduced) return;
    this.shakeAmt = Math.max(this.shakeAmt, amount);
    this.shakeT = Math.max(this.shakeT, seconds);
  }

  hitStop(seconds: number): void {
    if (this.reduced) return;
    this.stop = Math.max(this.stop, seconds);
  }

  /** True while a hit-stop is swallowing sim time. */
  frozen(): boolean {
    return this.stop > 0;
  }

  update(dt: number): void {
    if (this.stop > 0) this.stop = Math.max(0, this.stop - dt);
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      if (this.shakeT === 0) this.shakeAmt = 0;
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.97;
      p.vy *= 0.97;
    }
  }

  /** Current camera offset, in world units. */
  offset(): { x: number; y: number } {
    if (this.shakeT <= 0) return { x: 0, y: 0 };
    const a = this.shakeAmt * (this.shakeT > 0 ? 1 : 0);
    return { x: (Math.random() - 0.5) * a, y: (Math.random() - 0.5) * a };
  }

  clear(): void {
    this.particles.length = 0;
    this.shakeAmt = 0;
    this.shakeT = 0;
    this.stop = 0;
  }
}
