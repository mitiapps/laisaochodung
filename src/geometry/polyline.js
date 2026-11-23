/**
 * Polyline helpers. Points are `[x, z]`; positive lateral offsets are to the left of the
 * polyline direction (heading convention, see units.js).
 */

import { headingOf } from './pose.js';
import { sideOf } from './segment.js';

/** @typedef {[number, number]} Vec2 */

/** Miter length cap, in multiples of the offset, at sharp joints. */
const MITER_LIMIT = 4;

/**
 * Total length.
 * @param {Vec2[]} polyline Points.
 * @returns {number} Length in metres.
 */
export function polylineLength(polyline) {
  let len = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    len += Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1]);
  }
  return len;
}

/**
 * Cumulative distance at each vertex.
 * @param {Vec2[]} polyline Points.
 * @returns {number[]} Distances, first is 0.
 */
export function cumulativeLengths(polyline) {
  const out = [0];
  for (let i = 1; i < polyline.length; i += 1) {
    out.push(out[i - 1] + Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1]));
  }
  return out;
}

/**
 * Point and travel heading at distance `s` along the polyline; `s` is clamped to [0, length].
 * @param {Vec2[]} polyline At least 2 points.
 * @param {number} s Distance from the first point.
 * @returns {{point: Vec2, heading: number, segmentIndex: number}} Point on the line.
 */
export function pointAtDistance(polyline, s) {
  if (polyline.length < 2) throw new RangeError('pointAtDistance needs at least 2 points');
  let remaining = Math.max(0, s);
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const last = i === polyline.length - 2;
    if (remaining <= seg || last) {
      const f = seg > 0 ? Math.min(1, remaining / seg) : 0;
      return {
        point: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
        heading: headingOf(b[0] - a[0], b[1] - a[1]),
        segmentIndex: i,
      };
    }
    remaining -= seg;
  }
  // Unreachable: the loop returns on the last segment.
  throw new RangeError('pointAtDistance: empty polyline');
}

/**
 * Sub-polyline between distances `s0 < s1` (clamped to the line).
 * @param {Vec2[]} polyline At least 2 points.
 * @param {number} s0 Start distance.
 * @param {number} s1 End distance.
 * @returns {Vec2[]} Points from `s0` to `s1`, at least 2 (equal when the range is empty).
 */
export function slicePolyline(polyline, s0, s1) {
  const total = polylineLength(polyline);
  const a = Math.max(0, Math.min(total, s0));
  const b = Math.max(a, Math.min(total, s1));
  const cum = cumulativeLengths(polyline);
  /** @type {Vec2[]} */
  const out = [pointAtDistance(polyline, a).point];
  for (let i = 1; i < polyline.length - 1; i += 1) {
    if (cum[i] > a && cum[i] < b) out.push([polyline[i][0], polyline[i][1]]);
  }
  out.push(pointAtDistance(polyline, b).point);
  return out;
}

/**
 * Parallel polyline at lateral distance `d` (positive left), with mitred joints capped at
 * `MITER_LIMIT · |d|`. Zero-length segments are dropped first.
 * @param {Vec2[]} polyline At least 2 distinct points.
 * @param {number} d Offset in metres, positive to the left.
 * @returns {Vec2[]} Offset points, one per kept vertex.
 */
export function offsetPolyline(polyline, d) {
  /** @type {Vec2[]} */
  const pts = [];
  for (const p of polyline) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-9) pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) throw new RangeError('offsetPolyline needs at least 2 distinct points');
  /** @type {Vec2[]} */
  const normals = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dz);
    // Left normal of direction (dx, dz) in the heading convention.
    normals.push([dz / len, -dx / len]);
  }
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    let nx;
    let nz;
    let scale = 1;
    if (i === 0) [nx, nz] = normals[0];
    else if (i === pts.length - 1) [nx, nz] = normals[normals.length - 1];
    else {
      const [ax, az] = normals[i - 1];
      const [bx, bz] = normals[i];
      const mx = ax + bx;
      const mz = az + bz;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-9) {
        // A full reversal: fall back to the incoming normal.
        [nx, nz] = normals[i - 1];
      } else {
        nx = mx / ml;
        nz = mz / ml;
        const cosHalf = nx * ax + nz * az;
        scale = Math.min(MITER_LIMIT, 1 / Math.max(cosHalf, 1e-9));
      }
    }
    out.push([pts[i][0] + nx * d * scale, pts[i][1] + nz * d * scale]);
  }
  return out;
}

/**
 * Closest point of the polyline to `p`.
 * @param {Vec2} p Point.
 * @param {Vec2[]} polyline At least 2 points.
 * @returns {{s: number, point: Vec2, distance: number, lateral: number, heading: number}}
 *   Distance along the line, closest point, distance to it, signed lateral offset (positive left)
 *   and the line heading there.
 */
export function projectOntoPolyline(p, polyline) {
  if (polyline.length < 2) throw new RangeError('projectOntoPolyline needs at least 2 points');
  let best = { s: 0, point: /** @type {Vec2} */ ([polyline[0][0], polyline[0][1]]), distance: Infinity, lateral: 0, heading: 0 };
  let acc = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const seg2 = dx * dx + dz * dz;
    const seg = Math.sqrt(seg2);
    const f = seg2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / seg2)) : 0;
    /** @type {Vec2} */
    const q = [a[0] + dx * f, a[1] + dz * f];
    const dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (dist < best.distance) {
      const side = sideOf(p, a, b);
      best = {
        s: acc + seg * f,
        point: q,
        distance: dist,
        lateral: side === 'left' ? dist : side === 'right' ? -dist : 0,
        heading: headingOf(dx, dz),
      };
    }
    acc += seg;
  }
  return best;
}
