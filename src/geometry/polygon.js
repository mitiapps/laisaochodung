/**
 * Polygon tests. A polygon is a ring of `[x, z]` points listed once; the closing edge is implied.
 */

import { segmentsIntersect } from './segment.js';

/** @typedef {[number, number]} Vec2 */

/**
 * Point-in-polygon by ray casting. Points exactly on an edge may fall either way.
 * @param {Vec2} p Point.
 * @param {Vec2[]} polygon Ring.
 * @returns {boolean} Inside.
 */
export function pointInPolygon(p, polygon) {
  const [x, z] = p;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Signed area; positive when the ring runs counter-clockwise seen from above (+Y).
 * @param {Vec2[]} polygon Ring.
 * @returns {number} Signed area in m².
 */
export function polygonSignedArea(polygon) {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    // Seen from +Y with +X east and +Z south, counter-clockwise has negative x·z shoelace.
    sum += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  return -sum / 2;
}

/**
 * Area centroid of a simple polygon (vertex mean for degenerate rings).
 * @param {Vec2[]} polygon Ring.
 * @returns {Vec2} Centroid.
 */
export function polygonCentroid(polygon) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const f = polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
    a += f;
    cx += (polygon[j][0] + polygon[i][0]) * f;
    cz += (polygon[j][1] + polygon[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = polygon.length;
    return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

/**
 * Whether two simple polygons overlap or touch (edge crossing or containment).
 * @param {Vec2[]} a Ring.
 * @param {Vec2[]} b Ring.
 * @returns {boolean} True when they share any point.
 */
export function polygonsIntersect(a, b) {
  for (let i = 0, j = a.length - 1; i < a.length; j = i, i += 1) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k, k += 1) {
      if (segmentsIntersect(a[j], a[i], b[l], b[k])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}
