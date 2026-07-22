// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * render.ts — draw the arena.
 *
 * Reads the Sim, never writes it. The Sim does not know this file exists.
 *
 * Two things here are accessibility, not styling:
 *
 *  - Ships are told apart by SILHOUETTE as well as colour (a dart, a wedge, a
 *    delta, a needle). The Okabe–Ito palette already survives the common colour
 *    vision deficiencies, but four glowing triangles in a dark arena at speed is
 *    a hard read for anyone, and shape works at a glance where hue does not.
 *  - The player's own ship carries a ring. In a 4-way brawl "which one is me" is
 *    the question that actually costs you the round.
 */

import { ARENA_R, SHIP_R, STAR_R, Sim, type Ship } from './game/sim';
import type { Fx } from './fx';

/** Okabe–Ito — distinguishable under deuteranopia, protanopia and tritanopia. */
export const SEAT_COLORS = ['#56b4e9', '#e69f00', '#009e73', '#cc79a7'];
export const SEAT_NAMES = ['Sky', 'Amber', 'Jade', 'Rose'];

export function seatColor(seat: number): string {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}

/** Hull outlines in local space, nose along +x. One per seat, so shape reads. */
const HULLS: number[][][] = [
  [[13, 0], [-8, 7], [-4, 0], [-8, -7]], // dart
  [[12, 0], [-7, 9], [-9, 0], [-7, -9]], // wedge
  [[13, 0], [-9, 6], [-9, -6]], // delta
  [[15, 0], [-6, 4], [-9, 0], [-6, -4]], // needle
];

export interface View {
  /** Canvas px per world unit. */
  scale: number;
  cx: number;
  cy: number;
}

/** Fit the arena to the viewport with a small margin. */
export function computeView(w: number, h: number): View {
  // Guard against a transient 0-size measurement: a scale computed from a 0×0
  // rect is Infinity, and every world coordinate downstream becomes NaN — which
  // does not throw, it just silently draws nothing and drops every tap.
  const safeW = Math.max(w, 1);
  const safeH = Math.max(h, 1);
  const scale = Math.min(safeW, safeH) / (ARENA_R * 2 + 24);
  return { scale, cx: safeW / 2, cy: safeH / 2 };
}

function hull(ctx: CanvasRenderingContext2D, s: Ship, v: View, off: { x: number; y: number }): void {
  const pts = HULLS[s.seat % HULLS.length];
  ctx.save();
  ctx.translate(v.cx + (s.x + off.x) * v.scale, v.cy + (s.y + off.y) * v.scale);
  ctx.rotate(s.ang);
  ctx.scale(v.scale, v.scale);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.restore();
}

export interface RenderOpts {
  sim: Sim;
  fx: Fx;
  view: View;
  /** The local player's seat, or -1 when spectating. */
  selfSeat: number;
  /** Extrapolation, in seconds, since the last authoritative state. */
  lead: number;
  reduced: boolean;
}

export function render(ctx: CanvasRenderingContext2D, w: number, h: number, o: RenderOpts): void {
  const { sim, fx, view: v } = o;
  const off = fx.offset();

  ctx.clearRect(0, 0, w, h);

  // ── the void + rim ──
  ctx.save();
  ctx.beginPath();
  ctx.arc(v.cx + off.x * v.scale, v.cy + off.y * v.scale, ARENA_R * v.scale, 0, Math.PI * 2);
  ctx.fillStyle = '#070a14';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,150,200,0.35)';
  ctx.lineWidth = Math.max(1, 2 * v.scale);
  ctx.stroke();
  ctx.clip();

  // ── the star ──
  const sx = v.cx + off.x * v.scale;
  const sy = v.cy + off.y * v.scale;
  const kr = sim.killRadius() * v.scale;
  const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(kr * 2.4, STAR_R * v.scale * 3));
  g.addColorStop(0, '#fff4d6');
  g.addColorStop(0.25, '#ffb03a');
  g.addColorStop(0.6, `rgba(255,120,40,${0.28 + sim.flare * 0.5})`);
  g.addColorStop(1, 'rgba(255,80,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(kr * 2.4, STAR_R * v.scale * 3), 0, Math.PI * 2);
  ctx.fill();

  // The lethal edge, drawn honestly — this is the line that kills you, so it is
  // never decorative and never softer than the thing it represents.
  ctx.beginPath();
  ctx.arc(sx, sy, kr, 0, Math.PI * 2);
  ctx.fillStyle = '#fff1cc';
  ctx.fill();
  if (sim.flare > 0.02) {
    ctx.beginPath();
    ctx.arc(sx, sy, kr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,220,150,${sim.flare})`;
    ctx.lineWidth = Math.max(1, 3 * v.scale);
    ctx.stroke();
  }

  // ── rocks ──
  ctx.lineWidth = Math.max(1, 1.6 * v.scale);
  ctx.strokeStyle = 'rgba(190,200,220,0.85)';
  ctx.fillStyle = 'rgba(60,70,95,0.9)';
  for (const r of sim.rocks) {
    const x = v.cx + (r.x + r.vx * o.lead + off.x) * v.scale;
    const y = v.cy + (r.y + r.vy * o.lead + off.y) * v.scale;
    ctx.beginPath();
    // A fixed lumpy outline keyed off position — deterministic per rock without
    // needing per-rock state on the wire.
    for (let i = 0; i < 7; i++) {
      const a = (Math.PI * 2 * i) / 7;
      const wobble = 0.82 + 0.3 * Math.abs(Math.sin(i * 2.4 + r.r));
      const px = x + Math.cos(a) * r.r * v.scale * wobble;
      const py = y + Math.sin(a) * r.r * v.scale * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // ── particles ──
  for (const p of fx.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(v.cx + (p.x + off.x) * v.scale, v.cy + (p.y + off.y) * v.scale, p.size * v.scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ── bullets ──
  for (const b of sim.bullets) {
    const x = v.cx + (b.x + b.vx * o.lead + off.x) * v.scale;
    const y = v.cy + (b.y + b.vy * o.lead + off.y) * v.scale;
    const c = seatColor(b.owner);
    ctx.beginPath();
    ctx.arc(x, y, 3 * v.scale, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    if (!o.reduced) {
      ctx.beginPath();
      ctx.arc(x, y, 6 * v.scale, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ── ships ──
  for (const s of sim.ships) {
    if (!s.alive || s.out) continue;
    const lead = { ...s, x: s.x + s.vx * o.lead, y: s.y + s.vy * o.lead };
    const c = seatColor(s.seat);
    // Invulnerable ships blink. Blinking, not fading: a half-transparent ship in
    // a glow-heavy scene just reads as a rendering artefact.
    const blink = s.invuln > 0 && Math.floor(s.invuln * 8) % 2 === 0;
    if (blink) ctx.globalAlpha = 0.35;

    if (s.seat === o.selfSeat) {
      ctx.beginPath();
      ctx.arc(
        v.cx + (lead.x + off.x) * v.scale,
        v.cy + (lead.y + off.y) * v.scale,
        (SHIP_R + 9) * v.scale,
        0,
        Math.PI * 2,
      );
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = Math.max(1, 1.5 * v.scale);
      ctx.stroke();
    }

    hull(ctx, lead, v, off);
    ctx.fillStyle = c;
    ctx.globalAlpha = blink ? 0.35 : 0.9;
    ctx.fill();
    ctx.globalAlpha = blink ? 0.5 : 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 1.2 * v.scale);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
