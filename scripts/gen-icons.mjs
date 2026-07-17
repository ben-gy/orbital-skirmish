/**
 * gen-icons.mjs — rasterise public/favicon.svg into the PNGs a home-screen
 * install needs. Run: `node scripts/gen-icons.mjs`. Outputs to public/icons/.
 *
 * Why a hand-rolled rasteriser: the repo has no image dependency (no sharp, no
 * resvg) and a PWA icon is not worth adding one for. This is not a general SVG
 * renderer — it encodes the SHAPES of favicon.svg (the same rounded panel, amber
 * star and corona, dashed cyan orbit and white ship, in the same 64-unit
 * coordinate space and the same palette) so the icons stay the game's existing
 * identity rather than a second, drifting one. Change favicon.svg and change
 * this too; tests/manifest.test.ts checks the outputs exist and are real PNGs.
 *
 * Coverage is 4x4 supersampled signed distance, which is why the edges are clean
 * at 192px without a font/AA engine.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── palette (src/styles/main.css) ────────────────────────────────────────────
const BG = [0x0a, 0x0e, 0x1a]; // --void
const AMBER = [0xff, 0xb0, 0x3a]; // --star
const AMBER_RING = [0xff, 0xd9, 0xa8];
const CYAN = [0x56, 0xb4, 0xe9]; // --cyan
const SHIP = [0xea, 0xf6, 0xff];

// ── geometry helpers, all in favicon.svg's 0..64 space ───────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (a) => Math.hypot(a[0], a[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

const sdCircle = (p, c, r) => len(sub(p, c)) - r;
/** A stroked circle: the band of half-width w/2 either side of the radius. */
const sdRing = (p, c, r, w) => Math.abs(len(sub(p, c)) - r) - w / 2;

function sdRoundRect(p, x, y, w, h, r) {
  const cx = Math.abs(p[0] - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(p[1] - (y + h / 2)) - (h / 2 - r);
  const ox = Math.max(cx, 0);
  const oy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.hypot(ox, oy) - r;
}

/** Distance to the segment a→b, i.e. a capsule's spine. */
function sdSegment(p, a, b, w) {
  const pa = sub(p, a);
  const ba = sub(b, a);
  const h = Math.min(1, Math.max(0, dot(pa, ba) / Math.max(dot(ba, ba), 1e-9)));
  return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h]) - w / 2;
}

/**
 * Exact SDF for the filled triangle a,b,c (Inigo Quilez's formulation).
 *
 * The ship is the one shape here that is not a circle or a capsule, and it has
 * to be: a dot on an orbit could be any game, whereas a hull pointing prograde
 * is this one. At 32px the silhouette is all that survives, so it is worth the
 * fifteen lines.
 */
function sdTriangle(p, a, b, c) {
  const e0 = sub(b, a);
  const e1 = sub(c, b);
  const e2 = sub(a, c);
  const v0 = sub(p, a);
  const v1 = sub(p, b);
  const v2 = sub(p, c);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const pq0 = sub(v0, [e0[0] * clamp01(dot(v0, e0) / dot(e0, e0)), e0[1] * clamp01(dot(v0, e0) / dot(e0, e0))]);
  const pq1 = sub(v1, [e1[0] * clamp01(dot(v1, e1) / dot(e1, e1)), e1[1] * clamp01(dot(v1, e1) / dot(e1, e1))]);
  const pq2 = sub(v2, [e2[0] * clamp01(dot(v2, e2) / dot(e2, e2)), e2[1] * clamp01(dot(v2, e2) / dot(e2, e2))]);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const dx = Math.min(
    Math.min(dot(pq0, pq0), dot(pq1, pq1)),
    dot(pq2, pq2),
  );
  const dy = Math.min(
    Math.min(s * (v0[0] * e0[1] - v0[1] * e0[0]), s * (v1[0] * e1[1] - v1[1] * e1[0])),
    s * (v2[0] * e2[1] - v2[1] * e2[0]),
  );
  return -Math.sqrt(dx) * Math.sign(dy);
}

/**
 * favicon.svg's dashed orbit: `<circle r="20" stroke-dasharray="1 5">` with round
 * caps. Walk the circumference and emit a capsule per "on" run — round caps are
 * what make each 1-unit dash read as a dot rather than a tick.
 */
function dashedCircle(c, r, width, dash, gap) {
  const total = Math.PI * 2 * r;
  const at = (s) => [c[0] + Math.cos(s / r) * r, c[1] + Math.sin(s / r) * r];
  const caps = [];
  for (let s = 0; s < total; s += dash + gap) caps.push([at(s), at(Math.min(s + dash, total))]);
  return (p) => caps.reduce((m, [a, b]) => Math.min(m, sdSegment(p, a, b, width)), Infinity);
}

const orbit = dashedCircle([32, 32], 20, 2.5, 1, 5);
/** The hull from favicon.svg's `M40 12 L28 18 L31 12 L28 6 Z`, as two triangles. */
const shipA = (p) => sdTriangle(p, [40, 12], [28, 18], [31, 12]);
const shipB = (p) => sdTriangle(p, [40, 12], [31, 12], [28, 6]);
const ship = (p) => Math.min(shipA(p), shipB(p));

/**
 * The icon artwork, as (point in 0..64 space) -> layers to composite in order.
 * `rounded` is false for the iOS icon: iOS applies its own mask, so baking our
 * corners in would show a dark ring inside the system's rounded square.
 */
function layers(rounded) {
  return [
    { sd: (p) => sdRoundRect(p, 0, 0, 64, 64, rounded ? 14 : 0), color: BG, alpha: 1 },
    // corona, star, rim — the same three circles favicon.svg draws
    { sd: (p) => sdCircle(p, [32, 32], 12), color: AMBER, alpha: 0.18 },
    { sd: (p) => sdCircle(p, [32, 32], 6.5), color: AMBER, alpha: 1 },
    { sd: (p) => sdRing(p, [32, 32], 6.5, 1.5), color: AMBER_RING, alpha: 0.5 },
    { sd: orbit, color: CYAN, alpha: 0.85 },
    { sd: ship, color: SHIP, alpha: 1 },
  ];
}

/**
 * `inset` shrinks the artwork toward the centre for the maskable icon: Android
 * crops adaptive icons to a circle/squircle of ~80% of the canvas, so anything
 * outside that safe zone is cut. The BACKGROUND still goes full-bleed, which is
 * the whole point of a separate maskable file.
 */
function render(size, { rounded = true, inset = 0 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersamples per pixel
  const art = layers(rounded);
  const bg = art[0];
  const fg = art.slice(1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((x + (sx + 0.5) / SS) / size) * 64;
          const uy = ((y + (sy + 0.5) / SS) / size) * 64;
          // Background always fills the frame; only the artwork is inset.
          const p = [ux, uy];
          const q = [(ux - 32) / (1 - inset) + 32, (uy - 32) / (1 - inset) + 32];

          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const layer of [{ ...bg, p }, ...fg.map((l) => ({ ...l, p: q }))]) {
            // Distance -> coverage across roughly one supersample of width.
            const cov = Math.min(1, Math.max(0, 0.5 - layer.sd(layer.p) * (size / 64) * SS)) * layer.alpha;
            if (cov <= 0) continue;
            cr = layer.color[0] * cov + cr * (1 - cov);
            cg = layer.color[1] * cov + cg * (1 - cov);
            cb = layer.color[2] * cov + cb * (1 - cov);
            ca = cov + ca * (1 - cov);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// ── minimal PNG encoder (RGBA8, one IDAT) ────────────────────────────────────
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) | 0, 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12: deflate / adaptive filtering / no interlace — all zero.

  // Every scanline gets filter byte 0 (None); the image is tiny and zlib does
  // the work.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── go ───────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  // Android crops adaptive icons hard; 20% inset keeps the ball and the planet
  // inside the safe zone whatever mask the launcher picks.
  { file: 'icon-512-maskable.png', size: 512, opts: { rounded: false, inset: 0.2 } },
  // iOS ignores the manifest entirely and composites transparency on BLACK, so
  // this one is deliberately full-bleed and fully opaque.
  { file: 'apple-touch-icon.png', size: 180, opts: { rounded: false } },
];

for (const { file, size, opts } of targets) {
  const png = encodePng(render(size, opts), size);
  writeFileSync(join(OUT, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}
