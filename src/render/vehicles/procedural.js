/**
 * Building blocks for the procedural models (motorbikes, bus, wheels, helmet). Every part is a
 * non-indexed geometry in the Kenney frame (front +Z, left +X, up +Y) with `position`, `normal`,
 * `uv` and a `paint` attribute:
 *
 * - `uv` points at one cell of the Kenney Mini Characters colour map (`PALETTE_TEXTURE`), so a
 *   procedural model shares one material, and one draw call, with a baked rider;
 * - `paint` is 0 for fixed colours, 1 for the body paint and 2 for the second paint (helmet),
 *   which the look material replaces with the instance colours (`look-material.js`).
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Colour map the procedural models sample, relative to `public/`. */
export const PALETTE_TEXTURE = 'models/mini-characters/Textures/colormap.png';

/**
 * Cells of the Mini Characters colour map (8 columns × 4 rows of 64 × 128 px), by the colour
 * they show. Measured on the shipped `colormap.png`.
 */
export const CELL = Object.freeze({
  black: [0, 0],
  blue: [0, 1],
  green: [4, 2],
  yellow: [5, 2],
  orange: [6, 2],
  red: [7, 2],
  tan: [0, 3],
  nearBlack: [3, 3],
  grey: [4, 3],
  darkSlate: [5, 3],
  paleGrey: [6, 3],
  white: [7, 3],
});

/** @typedef {readonly number[]} Cell Column and row in the colour map grid. */

/**
 * Paint channel of a part.
 * @typedef {0 | 1 | 2} PaintChannel
 */

/** Fixed colour, never tinted. */
export const FIXED = 0;
/** Body paint, tinted by the instance's first colour. */
export const PAINT_BODY = 1;
/** Second paint (helmet), tinted by the instance's second colour. */
export const PAINT_ACCENT = 2;

/**
 * UV of a cell: the centre of its left half, `shade` from the top (0, lighter) to the bottom (1).
 * @param {Cell} cell Cell.
 * @param {number} [shade] Vertical position inside the cell, 0..1.
 * @returns {[number, number]} UV in glTF orientation (v down; the texture is not flipped).
 */
export function cellUv(cell, shade = 0.5) {
  const [col, row] = cell;
  return [(col * 64 + 16) / 512, (row * 128 + 8 + shade * 112) / 512];
}

/**
 * Gives a geometry its part attributes: one UV for every vertex and a constant paint channel.
 * Drops any other attribute but position and normal, and the index.
 * @param {BufferGeometry} geometry Geometry (consumed).
 * @param {Cell} cell Colour cell.
 * @param {PaintChannel} paint Paint channel.
 * @param {number} [shade] Shade inside the cell.
 * @returns {BufferGeometry} Non-indexed part.
 */
export function asPart(geometry, cell, paint, shade) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  const out = new BufferGeometry();
  const pos = flat.getAttribute('position');
  out.setAttribute('position', pos);
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  out.setAttribute('normal', flat.getAttribute('normal'));
  const n = pos.count;
  const [u, v] = cellUv(cell, shade);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setAttribute('paint', new BufferAttribute(new Float32Array(n).fill(paint), 1));
  return out;
}

/**
 * Extrudes a side profile across the vehicle. The profile is drawn in the side view as
 * `[forward, up]` points (metres, +forward towards the front) and extruded symmetrically along X.
 * @param {readonly (readonly number[])[]} profile Closed outline, at least 3 points.
 * @param {number} width Extrusion width across X.
 * @param {object} look Look.
 * @param {Cell} look.cell Colour cell.
 * @param {PaintChannel} look.paint Paint channel.
 * @param {number} [look.bevel] Edge rounding in metres (0 for sharp edges).
 * @param {number} [look.x] Centre on X (left positive).
 * @returns {BufferGeometry} Part.
 */
export function profilePart(profile, width, look) {
  if (profile.length < 3) throw new Error('A profile needs at least 3 points');
  const shape = new Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i += 1) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();
  const bevel = look.bevel ?? 0;
  const depth = Math.max(0.001, width - 2 * bevel);
  const g = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // Shape X is forward and the extrusion runs along Z: centre it, then turn forward to +Z.
  g.translate(0, 0, -depth / 2);
  g.applyMatrix4(new Matrix4().makeRotationY(-Math.PI / 2));
  if (look.x) g.translate(look.x, 0, 0);
  return asPart(g, look.cell, look.paint);
}

/**
 * Box part.
 * @param {[number, number, number]} size Width (X), height, length (Z).
 * @param {[number, number, number]} at Centre.
 * @param {Cell} cell Colour cell.
 * @param {PaintChannel} paint Paint channel.
 * @param {number} [pitch] Rotation about X in radians (positive tips the top forward).
 * @returns {BufferGeometry} Part.
 */
export function boxPart(size, at, cell, paint, pitch = 0) {
  const g = new BoxGeometry(size[0], size[1], size[2]);
  if (pitch) g.applyMatrix4(new Matrix4().makeRotationX(pitch));
  g.translate(at[0], at[1], at[2]);
  return asPart(g, cell, paint);
}

/**
 * Cylinder part whose axis runs from `a` to `b`.
 * @param {[number, number, number]} a One end.
 * @param {[number, number, number]} b Other end.
 * @param {number} radius Radius.
 * @param {number} segments Radial segments.
 * @param {Cell} cell Colour cell.
 * @param {PaintChannel} paint Paint channel.
 * @returns {BufferGeometry} Part.
 */
export function rodPart(a, b, radius, segments, cell, paint) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) throw new Error('A rod needs two distinct ends');
  const g = new CylinderGeometry(radius, radius, len, segments, 1, false);
  // Cylinder axis is +Y; turn it onto the rod direction.
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(dx / len, dy / len, dz / len));
  const m = new Matrix4().makeRotationFromQuaternion(q);
  g.applyMatrix4(m);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return asPart(g, cell, paint);
}

/**
 * Half-sphere shell part (helmet), open at the bottom.
 * @param {number} radius Radius.
 * @param {[number, number, number]} at Centre of the sphere.
 * @param {Cell} cell Colour cell.
 * @param {PaintChannel} paint Paint channel.
 * @returns {BufferGeometry} Part.
 */
export function domePart(radius, at, cell, paint) {
  const g = new SphereGeometry(radius, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.6);
  g.translate(at[0], at[1], at[2]);
  return asPart(g, cell, paint);
}

/**
 * Unit wheel in the Kenney frame: radius 1 and width 1 across X, axle on X through the origin.
 * Instance matrices scale it to the real radius (Y, Z) and tyre width (X). A light rim band and
 * spoke bar make the spin visible.
 * @returns {BufferGeometry} Wheel.
 */
export function unitWheel() {
  const tyre = new CylinderGeometry(1, 1, 1, 12, 1, false);
  tyre.applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 2));
  const rim = new CylinderGeometry(0.62, 0.62, 1.06, 8, 1, false);
  rim.applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 2));
  const spoke = new BoxGeometry(1.1, 1.05, 0.16);
  return merge([asPart(tyre, CELL.nearBlack, FIXED), asPart(rim, CELL.grey, FIXED), asPart(spoke, CELL.paleGrey, FIXED)]);
}

/**
 * Merges parts into one geometry; throws when the parts' attributes differ.
 * @param {BufferGeometry[]} parts Parts (consumed).
 * @returns {BufferGeometry} Merged geometry.
 */
export function merge(parts) {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Parts could not be merged: their attributes differ');
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Triangle count of a non-indexed or indexed geometry.
 * @param {BufferGeometry} geometry Geometry.
 * @returns {number} Triangles.
 */
export function triangles(geometry) {
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}
