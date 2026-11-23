/**
 * Segment tests. Points are `[x, z]` tuples.
 */

/** @typedef {[number, number]} Vec2 */

const EPS = 1e-12;

/**
 * Side of point `p` relative to the directed line `a → b`, using the heading convention
 * (+X east, +Z south): negative cross product is left.
 * @param {Vec2} p Point.
 * @param {Vec2} a Line start.
 * @param {Vec2} b Line end.
 * @returns {'left' | 'right' | 'on'} Side.
 */
export function sideOf(p, a, b) {
  const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (c < -EPS) return 'left';
  if (c > EPS) return 'right';
  return 'on';
}

/**
 * Intersection of segments `p1–p2` and `q1–q2`, endpoints included.
 * Collinear overlaps return the first shared point found along `p1–p2`.
 * @param {Vec2} p1 First segment start.
 * @param {Vec2} p2 First segment end.
 * @param {Vec2} q1 Second segment start.
 * @param {Vec2} q2 Second segment end.
 * @returns {{point: Vec2, t: number, u: number} | null} Point with parameters along each segment.
 */
export function segmentIntersection(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0];
  const rz = p2[1] - p1[1];
  const sx = q2[0] - q1[0];
  const sz = q2[1] - q1[1];
  const denom = rx * sz - rz * sx;
  const qpx = q1[0] - p1[0];
  const qpz = q1[1] - p1[1];
  if (Math.abs(denom) < EPS) {
    // Parallel. Intersect only when collinear and overlapping.
    if (Math.abs(qpx * rz - qpz * rx) > EPS) return null;
    const rr = rx * rx + rz * rz;
    if (rr < EPS) {
      return pointOnSegment(p1, q1, q2) ? { point: [p1[0], p1[1]], t: 0, u: projectParam(p1, q1, q2) } : null;
    }
    const t0 = (qpx * rx + qpz * rz) / rr;
    const t1 = t0 + (sx * rx + sz * rz) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (lo > hi + EPS) return null;
    const point = /** @type {Vec2} */ ([p1[0] + rx * lo, p1[1] + rz * lo]);
    return { point, t: lo, u: projectParam(point, q1, q2) };
  }
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { point: [p1[0] + rx * t, p1[1] + rz * t], t, u };
}

/**
 * Whether segments `p1–p2` and `q1–q2` touch or cross.
 * @param {Vec2} p1 First segment start.
 * @param {Vec2} p2 First segment end.
 * @param {Vec2} q1 Second segment start.
 * @param {Vec2} q2 Second segment end.
 * @returns {boolean} True when they share a point.
 */
export function segmentsIntersect(p1, p2, q1, q2) {
  return segmentIntersection(p1, p2, q1, q2) !== null;
}

/**
 * First crossing of the move `from → to` over a polyline, in order along the move.
 * `fromSide` is the side of `from` relative to the crossed polyline segment's direction, so a
 * `crossable: 'left-to-right'` line is crossed lawfully when `fromSide` is `left`.
 * Sides are half-open: a point exactly on the line counts as `right`. A crossing split over two
 * moves (left → on → right) is therefore reported exactly once, by the move that leaves the left.
 * A touch from the left (left → on → left) reports one crossing each way: it is driving onto the
 * line. A move along the right side that merely ends on the line reports nothing.
 * @param {Vec2} from Previous position.
 * @param {Vec2} to Current position.
 * @param {Vec2[]} polyline Line.
 * @returns {{segmentIndex: number, point: Vec2, t: number, fromSide: 'left' | 'right'} | null} Crossing.
 */
export function segmentCrossesPolyline(from, to, polyline) {
  /** @type {{segmentIndex: number, point: Vec2, t: number, fromSide: 'left' | 'right'} | null} */
  let best = null;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const hit = segmentIntersection(from, to, a, b);
    if (!hit) continue;
    const s0 = halfOpenSide(from, a, b);
    const s1 = halfOpenSide(to, a, b);
    if (s0 === s1) continue;
    if (!best || hit.t < best.t) best = { segmentIndex: i, point: hit.point, t: hit.t, fromSide: s0 };
  }
  return best;
}

/**
 * Side with points on the line counted as `right`.
 * @param {Vec2} p Point.
 * @param {Vec2} a Line start.
 * @param {Vec2} b Line end.
 * @returns {'left' | 'right'} Side.
 */
function halfOpenSide(p, a, b) {
  return sideOf(p, a, b) === 'left' ? 'left' : 'right';
}

/**
 * @param {Vec2} p Point.
 * @param {Vec2} a Segment start.
 * @param {Vec2} b Segment end.
 * @returns {number} Parameter of the projection of `p` on the line `a–b`.
 */
function projectParam(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const dd = dx * dx + dz * dz;
  if (dd < EPS) return 0;
  return ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / dd;
}

/**
 * @param {Vec2} p Point.
 * @param {Vec2} a Segment start.
 * @param {Vec2} b Segment end.
 * @returns {boolean} `p` lies on the segment.
 */
function pointOnSegment(p, a, b) {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > EPS) return false;
  const u = projectParam(p, a, b);
  return u >= -EPS && u <= 1 + EPS;
}
