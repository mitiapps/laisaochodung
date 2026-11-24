/**
 * Overhead power and telecom cables between power-pole tops, drawn as merged sagging line strips.
 * Tutorial streets only: the OSM district has its cables underground ("Đường Lê Duẩn (quận 1) đã
 * được ngầm hóa lưới điện và cáp viễn thông", SGGP, 2021-01-15,
 * https://www.sggp.org.vn/195-tuyen-duong-tai-tphcm-da-duoc-ngam-hoa-luoi-dien-cap-vien-thong-post581616.html).
 * Poles are linked along a minimum spanning tree, keeping spans up to `MAX_SPAN_M`.
 */

import { BufferGeometry, Float32BufferAttribute, LineSegments } from 'three';
import { range, uniform } from '../../world/random.js';
import { POLE_ATTACH } from './props.js';
import { localToWorld } from '../triangle-soup.js';
import { headingToYaw } from '../math.js';

/** @typedef {import('../../contracts/map.js').Prop} Prop */
/** @typedef {import('../../world/random.js').RandomStream} RandomStream */
/** @typedef {[number, number, number]} Vec3 */

/** Longest pole-to-pole span drawn (design; poles stand every 30–40 m). */
export const MAX_SPAN_M = 50;
/** Points per cable. */
const SEGMENTS = 12;

/**
 * Pole pairs to link: the minimum spanning tree of the poles, without spans over `MAX_SPAN_M`.
 * @param {{x: number, z: number}[]} poles Pole positions.
 * @returns {[number, number][]} Index pairs `[i, j]` with `i < j`, in a fixed order.
 */
export function cableSpans(poles) {
  /** @type {[number, number, number][]} */
  const edges = [];
  for (let i = 0; i < poles.length; i += 1) {
    for (let j = i + 1; j < poles.length; j += 1) {
      const d = Math.hypot(poles[j].x - poles[i].x, poles[j].z - poles[i].z);
      if (d <= MAX_SPAN_M) edges.push([d, i, j]);
    }
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const parent = poles.map((_, i) => i);
  /**
   * @param {number} i Index.
   * @returns {number} Root.
   */
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  /** @type {[number, number][]} */
  const out = [];
  for (const [, i, j] of edges) {
    const a = find(i);
    const b = find(j);
    if (a === b) continue;
    parent[a] = b;
    out.push([i, j]);
  }
  return out;
}

/**
 * Points of a cable hanging between two points: a parabola close to a catenary for small sag.
 * @param {Vec3} a Start.
 * @param {Vec3} b End.
 * @param {number} sag Drop at mid-span below the chord.
 * @param {number} segments Segments.
 * @returns {Vec3[]} `segments + 1` points.
 */
export function cablePoints(a, b, sag, segments = SEGMENTS) {
  return Array.from({ length: segments + 1 }, (_, k) => {
    const t = k / segments;
    return /** @type {Vec3} */ ([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t - 4 * sag * t * (1 - t),
      a[2] + (b[2] - a[2]) * t,
    ]);
  });
}

/**
 * Line-segment positions of every cable between the power poles.
 * @param {Prop[]} poles Power-pole props.
 * @param {RandomStream} rng Stream for sags and extra strands.
 * @returns {number[]} Pairs of points, flattened.
 */
export function cablePositions(poles, rng) {
  /** @type {number[]} */
  const out = [];
  /**
   * @param {Prop} p Pole.
   * @param {readonly number[]} local Local attach point.
   * @returns {Vec3} World point.
   */
  const attach = (p, local) => localToWorld(p.pos, headingToYaw(p.heading), /** @type {Vec3} */ ([...local]));
  /** @param {Vec3[]} pts Points. */
  const strip = (pts) => {
    for (let k = 0; k + 1 < pts.length; k += 1) out.push(...pts[k], ...pts[k + 1]);
  };
  for (const [i, j] of cableSpans(poles.map((p) => p.pos))) {
    const a = poles[i];
    const b = poles[j];
    // Pair each attach point with the one on the same side of the span on the far pole.
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    /**
     * @param {Prop} p Pole.
     * @returns {(readonly number[])[]} Attach points ordered left to right across the span.
     */
    const ordered = (p) =>
      [...POLE_ATTACH].sort((u, v) => {
        const pu = attach(p, u);
        const pv = attach(p, v);
        return pu[1] - pv[1] || ((pu[0] - pv[0]) * -dz + (pu[2] - pv[2]) * dx);
      });
    const from = ordered(a);
    const to = ordered(b);
    for (let k = 0; k < from.length; k += 1) strip(cablePoints(attach(a, from[k]), attach(b, to[k]), range(rng, 0.4, 1.3)));
    if (uniform(rng) < 0.4) strip(cablePoints(attach(a, from[0]), attach(b, to[0]), range(rng, 1.8, 2.6)));
  }
  return out;
}

/**
 * The cable mesh, or null when there is nothing to link.
 * @param {Prop[]} poles Power-pole props.
 * @param {RandomStream} rng Stream.
 * @param {import('three').LineBasicMaterial} material Cable material.
 * @returns {LineSegments | null} Cables.
 */
export function buildCables(poles, rng, material) {
  const positions = cablePositions(poles, rng);
  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const lines = new LineSegments(geometry, material);
  lines.name = 'scenery-cables';
  lines.castShadow = false;
  lines.matrixAutoUpdate = false;
  return lines;
}
