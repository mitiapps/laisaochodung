/**
 * French colonial civic buildings (also landmarks and fenced compounds): rendered walls, white
 * trim at every floor line, tall windows with green shutters, a hipped tile roof, and an optional
 * fence with a gate at the front setback.
 */

import { polygonCentroid } from '../../geometry/index.js';
import { outwardNormal } from '../triangle-soup.js';
import { CIVIC_COLORS, CIVIC_STOREY_M, edgeFrames, fromFrame } from './lots.js';
import { uniform } from '../../world/random.js';

/** @typedef {import('./lots.js').CivicLayout} CivicLayout */
/** @typedef {import('./chunks.js').ChunkedSoups} ChunkedSoups */
/** @typedef {import('../triangle-soup.js').TriangleSoup} TriangleSoup */
/** @typedef {[number, number]} Vec2 */
/** @typedef {[number, number, number]} Vec3 */

/** Window bay width along a civic wall. */
const BAY_M = 3.6;
/** Roof pitch as rise over half-span (about 30°, design). */
const ROOF_PITCH = 0.55;
/** Highest roof rise. */
const ROOF_MAX_RISE_M = 6;
/** Fence: pillar spacing, height and gate width. */
const FENCE = Object.freeze({ pillarEveryM: 2.5, heightM: 1.8, gateM: 4 });
const IRON = 0x262626;
const WINDOW = 0x2f3b44;

/**
 * Hipped roof over a footprint: a ridge roof over four-corner footprints, otherwise a pyramid
 * fanned to the centroid.
 * @param {TriangleSoup} soup Soup.
 * @param {Vec2[]} ring Footprint.
 * @param {number} y Eaves height.
 */
export function addHipRoof(soup, ring, y) {
  const c = polygonCentroid(ring);
  /**
   * @param {Vec2} a Corner.
   * @param {Vec2} b Corner.
   * @returns {number} Distance.
   */
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  /**
   * @param {Vec2} p Ground point.
   * @param {number} h Height.
   * @returns {Vec3} Point.
   */
  const at = (p, h) => [p[0], h, p[1]];
  /**
   * Up-and-out normal of a roof face over edge `i`.
   * @param {number} i Edge index.
   * @returns {Vec3} Normal.
   */
  const up = (i) => {
    const n = outwardNormal(ring, i) ?? [0, 0];
    return [n[0], 1, n[1]];
  };
  if (ring.length === 4) {
    // Start at a long edge: A-B and C-D long, B-C and D-A the hips.
    const k = len(ring[0], ring[1]) >= len(ring[1], ring[2]) ? 0 : 1;
    const [A, B, C, D] = [0, 1, 2, 3].map((i) => ring[(i + k) % 4]);
    const long = (len(A, B) + len(C, D)) / 2;
    const short = (len(B, C) + len(D, A)) / 2;
    const rise = Math.min(ROOF_MAX_RISE_M, (short / 2) * ROOF_PITCH);
    const half = Math.max(0, (long - short) / 2);
    const dir = /** @type {Vec2} */ ([(B[0] - A[0] + C[0] - D[0]) / 2, (B[1] - A[1] + C[1] - D[1]) / 2]);
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    /** @type {Vec2} */
    const r1 = [c[0] - (dir[0] / dl) * half, c[1] - (dir[1] / dl) * half];
    /** @type {Vec2} */
    const r2 = [c[0] + (dir[0] / dl) * half, c[1] + (dir[1] / dl) * half];
    const R1 = at(r1, y + rise);
    const R2 = at(r2, y + rise);
    soup.addQuad(at(A, y), at(B, y), R2, R1, up(k));
    soup.addTriangle(at(B, y), at(C, y), R2, up((k + 1) % 4));
    soup.addQuad(at(C, y), at(D, y), R1, R2, up((k + 2) % 4));
    soup.addTriangle(at(D, y), at(A, y), R1, up((k + 3) % 4));
    return;
  }
  let minR = Infinity;
  for (const p of ring) minR = Math.min(minR, len(p, c));
  const apex = at(c, y + Math.min(ROOF_MAX_RISE_M, minR * ROOF_PITCH));
  for (let i = 0; i < ring.length; i += 1) soup.addTriangle(at(ring[i], y), at(ring[(i + 1) % ring.length], y), apex, up(i));
}

/**
 * Builds one civic, landmark or compound building into the chunked soups.
 * @param {CivicLayout} layout Layout.
 * @param {ChunkedSoups} soups Scenery soups.
 */
export function buildCivic(layout, soups) {
  const [cx, cz] = polygonCentroid(layout.footprint);
  const facade = soups.at(cx, cz, 'facade');
  // Iron, shutters and trims share the facade soup: one fewer draw call per chunk.
  const metal = facade;
  const glass = soups.at(cx, cz, 'glass');
  const lit = soups.at(cx, cz, 'glass-lit');
  const H = layout.heightM;

  for (const e of edgeFrames(layout.footprint, outwardNormal)) {
    facade.setColor(layout.render);
    facade.addStandingRect(e.origin, e.yaw, [0, 0, e.length, H], 0, 1);
    // Trim bands at every floor line and the cornice.
    facade.setColor(CIVIC_COLORS.trim);
    for (let k = 1; k <= layout.storeys; k += 1) {
      const y = k * CIVIC_STOREY_M;
      facade.addBox(e.origin, e.yaw, [e.length / 2, y - 0.15, 0.06], [e.length + 0.12, 0.3, 0.12]);
    }
    const bays = Math.floor(e.length / BAY_M);
    if (bays < 1) continue;
    const pad = (e.length - bays * BAY_M) / 2;
    for (let k = 0; k < layout.storeys; k += 1) {
      const y = k * CIVIC_STOREY_M;
      for (let b = 0; b < bays; b += 1) {
        const x = pad + (b + 0.5) * BAY_M;
        const win = uniform(layout.rng) < 0.3 ? lit : glass;
        win.setColor(WINDOW);
        win.addStandingRect(e.origin, e.yaw, [x - 0.6, y + 0.9, x + 0.6, y + 3.4], 0.03, 1);
        metal.setColor(CIVIC_COLORS.shutter);
        metal.addStandingRect(e.origin, e.yaw, [x - 1.25, y + 0.9, x - 0.65, y + 3.4], 0.04, 1);
        metal.addStandingRect(e.origin, e.yaw, [x + 0.65, y + 0.9, x + 1.25, y + 3.4], 0.04, 1);
        facade.setColor(CIVIC_COLORS.trim);
        facade.addBox(e.origin, e.yaw, [x, y + 3.55, 0.05], [1.5, 0.25, 0.1]);
      }
    }
  }
  facade.setColor(CIVIC_COLORS.roof);
  addHipRoof(facade, layout.footprint, H);

  if (layout.fenceM !== null) buildFence(layout, facade, metal);
}

/**
 * A fence with a closed gate along the front, `fenceM` ahead of the facade, closed back to the
 * facade at both ends.
 * @param {CivicLayout} layout Layout.
 * @param {TriangleSoup} facade Rendered pieces (base wall, pillars).
 * @param {TriangleSoup} metal Iron pieces (railings, gate).
 */
function buildFence(layout, facade, metal) {
  const f = layout.frame;
  const [ox, oz] = fromFrame(f, 0, 0);
  const origin = { x: ox, z: oz };
  const L = f.length;
  const gate0 = L / 2 - FENCE.gateM / 2;
  const gate1 = L / 2 + FENCE.gateM / 2;
  const out = layout.fenceM ?? 0;
  // Front run (local z = out) in two pieces around the gate, and the two side runs.
  /** @type {[number, number, number, number][]} x0, z0, x1, z1 */
  const runs = [
    [0, out, gate0, out],
    [gate1, out, L, out],
    [0, 0, 0, out],
    [L, 0, L, out],
  ];
  for (const [x0, z0, x1, z1] of runs) {
    const runLen = Math.hypot(x1 - x0, z1 - z0);
    if (runLen < 0.3) continue;
    const alongX = x1 !== x0;
    /** @type {[number, number, number]} */
    const mid = [(x0 + x1) / 2, 0, (z0 + z1) / 2];
    /**
     * @param {number} along Length along the run.
     * @param {number} h Height.
     * @param {number} thick Thickness across.
     * @returns {[number, number, number]} Box size.
     */
    const size = (along, h, thick) => (alongX ? [along, h, thick] : [thick, h, along]);
    facade.setColor(CIVIC_COLORS.trim);
    facade.addBox(origin, f.yaw, [mid[0], 0.25, mid[2]], size(runLen, 0.5, 0.3));
    metal.setColor(IRON);
    metal.addBox(origin, f.yaw, [mid[0], 0.5 + (FENCE.heightM - 0.5) / 2, mid[2]], size(runLen, FENCE.heightM - 0.5, 0.04));
    const pillars = Math.max(1, Math.round(runLen / FENCE.pillarEveryM));
    facade.setColor(layout.render);
    for (let p = 0; p <= pillars; p += 1) {
      const t = p / pillars;
      facade.addBox(origin, f.yaw, [x0 + (x1 - x0) * t, FENCE.heightM / 2 + 0.1, z0 + (z1 - z0) * t], [0.4, FENCE.heightM + 0.2, 0.4]);
    }
  }
  metal.setColor(IRON);
  metal.addBox(origin, f.yaw, [L / 2, FENCE.heightM / 2, out - 0.1], [FENCE.gateM, FENCE.heightM, 0.06]);
}
