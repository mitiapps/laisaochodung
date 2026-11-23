/**
 * Frame-driven effects: skid marks from `wheels[].skid`, a camera shake on collision events and a
 * tip-over ghost on `fall`. Effects are fed once per new tick (the renderer dedupes by
 * `frame.tick`), so drawing a frame twice never doubles a mark or a shake.
 */

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Mesh, MeshBasicMaterial } from 'three';
import { bodyToWorld } from './math.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {[number, number]} Vec2 */

/** Skid value above which a wheel leaves a mark (a drawing choice). */
export const SKID_MARK_THRESHOLD = 0.3;
/** Skid mark segments kept; older ones are overwritten. */
export const MAX_SKID_SEGMENTS = 3000;
const SKID_Y = 0.02;

/**
 * Pure: the skid-mark segments one tick adds. A wheel leaves a segment from its last marked
 * contact point to the current one while it touches the ground and slides above the threshold.
 * @param {(Vec2 | null)[]} last Last marked point per wheel (mutated: updated or cleared).
 * @param {Frame} frame Frame.
 * @param {[number, number][]} offsets Wheel offsets `[along, left]` in `WheelState` order.
 * @param {boolean} discontinuity The frame follows a reset or fall.
 * @returns {{from: Vec2, to: Vec2}[]} New segments.
 */
export function skidSegments(last, frame, offsets, discontinuity) {
  /** @type {{from: Vec2, to: Vec2}[]} */
  const out = [];
  const { ego } = frame;
  for (let i = 0; i < offsets.length; i += 1) {
    const wheel = ego.wheels[i];
    const marking = Boolean(wheel && wheel.contact && wheel.skid > SKID_MARK_THRESHOLD) && !discontinuity;
    if (!marking) {
      last[i] = null;
      continue;
    }
    const p = bodyToWorld(ego.pos, ego.heading, offsets[i]);
    const prev = last[i];
    if (!prev) {
      last[i] = p;
    } else if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 0.01) {
      out.push({ from: prev, to: p });
      last[i] = p;
    }
  }
  return out;
}

/**
 * Pure: camera shake amplitude in metres for a collision, from the closing speed.
 * @param {number} relSpeed Closing speed in m/s.
 * @returns {number} Amplitude 0.05..0.5.
 */
export function shakeAmplitude(relSpeed) {
  return Math.max(0.05, Math.min(0.5, 0.04 * Math.abs(relSpeed)));
}

/**
 * Skid-mark ring buffer drawn as one mesh.
 * @param {number} widthM Mark width.
 * @returns {{mesh: Mesh, add: (from: Vec2, to: Vec2) => void, clear: () => void, dispose: () => void}} Marks.
 */
export function createSkidMarks(widthM) {
  const positions = new Float32Array(MAX_SKID_SEGMENTS * 6 * 3);
  const geometry = new BufferGeometry();
  const attr = new BufferAttribute(positions, 3);
  attr.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  geometry.setDrawRange(0, 0);
  const material = new MeshBasicMaterial({
    color: 0x111111,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'skid-marks';
  mesh.frustumCulled = false;
  let next = 0;
  let count = 0;
  return {
    mesh,
    add(from, to) {
      const dx = to[0] - from[0];
      const dz = to[1] - from[1];
      const len = Math.hypot(dx, dz);
      if (len === 0) return;
      // Left normal of the stroke; triangles wound to face up.
      const nx = (dz / len) * (widthM / 2);
      const nz = (-dx / len) * (widthM / 2);
      const a = [from[0] + nx, SKID_Y, from[1] + nz];
      const b = [from[0] - nx, SKID_Y, from[1] - nz];
      const c = [to[0] - nx, SKID_Y, to[1] - nz];
      const d = [to[0] + nx, SKID_Y, to[1] + nz];
      // Upward normal needs (e1 × e2).y > 0, i.e. counter-clockwise seen from +Y.
      const cross = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      const tris = cross > 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
      positions.set(tris.flat(), next * 18);
      next = (next + 1) % MAX_SKID_SEGMENTS;
      count = Math.min(MAX_SKID_SEGMENTS, count + 1);
      geometry.setDrawRange(0, count * 6);
      attr.needsUpdate = true;
    },
    clear() {
      next = 0;
      count = 0;
      geometry.setDrawRange(0, 0);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Decaying camera shake.
 * @returns {{kick: (amplitude: number, nowS: number) => void, offset: (nowS: number) => [number, number, number]}} Shake.
 */
export function createShake() {
  let amp = 0;
  let start = 0;
  const DURATION_S = 0.5;
  return {
    kick(amplitude, nowS) {
      const current = amp * Math.max(0, 1 - (nowS - start) / DURATION_S);
      amp = Math.max(current, amplitude);
      start = nowS;
    },
    offset(nowS) {
      const k = amp * Math.max(0, 1 - (nowS - start) / DURATION_S);
      if (k <= 0) return [0, 0, 0];
      const t = nowS * 60;
      return [Math.sin(t * 1.7) * k, Math.sin(t * 2.3 + 1) * k * 0.6, Math.sin(t * 1.3 + 2) * k];
    },
  };
}

/**
 * Tip-over ghosts: a static copy of the bike at the fall pose rolls onto its side over 0.6 s and
 * disappears after 2 s, while the live vehicle is already back at the checkpoint.
 * @returns {{group: Group, spawn: (ghost: Group, nowS: number, leftSide: boolean) => void, update: (nowS: number) => void, clear: () => void}} Ghosts.
 */
export function createFallGhosts() {
  const group = new Group();
  group.name = 'fall-ghosts';
  /** @type {{node: Group, start: number, dir: number}[]} */
  const live = [];
  return {
    group,
    spawn(ghost, nowS, leftSide) {
      group.add(ghost);
      live.push({ node: ghost, start: nowS, dir: leftSide ? -1 : 1 });
    },
    update(nowS) {
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const g = live[i];
        const age = nowS - g.start;
        if (age > 2) {
          group.remove(g.node);
          live.splice(i, 1);
          continue;
        }
        const lean = g.node.children[0];
        if (lean) lean.rotation.x = g.dir * (Math.PI / 2) * Math.min(1, age / 0.6) ** 2;
      }
    },
    clear() {
      for (const g of live) group.remove(g.node);
      live.length = 0;
    },
  };
}
