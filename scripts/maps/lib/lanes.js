/**
 * Lane geometry: lane polygons and centrelines from a road's reference polyline, painted lane
 * lines by type, carriageway bands, and junction polygons from the road ends.
 */

import { offsetPolyline, polylineLength, slicePolyline } from '../../../src/geometry/index.js';
import { carriageway, laneSpan } from './graph.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('./graph.js').LineStretch} LineStretch */
/** @typedef {import('./graph.js').TopoRoad} TopoRoad */
/** @typedef {import('./graph.js').Topology} Topology */
/** @typedef {import('../../../src/contracts/map.js').Road} Road */

/** Car lane width (m). */
export const LANE_WIDTH_M = 3.5;

const LINE_TYPES = ['dashed', 'solid', 'double-solid', 'mixed'];
const CROSSABLE = ['both', 'left-to-right', 'right-to-left', 'none'];

/**
 * Normalises a line spec (a type, or a list of `{toS?, type, crossable?}` stretches in order).
 * Dashed lines are crossable both ways, solid and double-solid lines not at all; a mixed line
 * must name its `crossable` side.
 * @param {unknown} spec Spec from a source file.
 * @param {string} where Error context.
 * @returns {LineStretch[]} Stretches covering [0, ∞).
 */
export function parseLineSpec(spec, where) {
  const list = typeof spec === 'string' ? [{ type: spec }] : spec;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${where}: line spec must be a type or a list`);
  /** @type {LineStretch[]} */
  const out = [];
  let fromS = 0;
  list.forEach((item, i) => {
    const { type, toS, crossable } = /** @type {{type?: unknown, toS?: unknown, crossable?: unknown}} */ (item ?? {});
    if (typeof type !== 'string' || !LINE_TYPES.includes(type)) throw new Error(`${where}[${i}]: unknown line type ${String(type)}`);
    const last = i === list.length - 1;
    if (last ? toS !== undefined : typeof toS !== 'number' || !(toS > fromS)) {
      throw new Error(`${where}[${i}]: every stretch but the last needs an increasing toS; the last has none`);
    }
    let cross = crossable;
    if (cross === undefined) {
      if (type === 'mixed') throw new Error(`${where}[${i}]: a mixed line needs crossable`);
      cross = type === 'dashed' ? 'both' : 'none';
    }
    if (typeof cross !== 'string' || !CROSSABLE.includes(cross)) throw new Error(`${where}[${i}]: bad crossable ${String(cross)}`);
    const end = last ? Infinity : /** @type {number} */ (toS);
    out.push({
      fromS,
      toS: end,
      type: /** @type {LineStretch['type']} */ (type),
      crossable: /** @type {LineStretch['crossable']} */ (cross),
    });
    fromS = end;
  });
  return out;
}

/**
 * Ring between two lateral offsets of a polyline stretch.
 * @param {Vec2[]} points Reference polyline.
 * @param {number} s0 Start distance.
 * @param {number} s1 End distance.
 * @param {number} lo Right bound (lateral, positive left).
 * @param {number} hi Left bound.
 * @returns {Vec2[]} Polygon ring.
 */
export function band(points, s0, s1, lo, hi) {
  const piece = slicePolyline(points, s0, s1);
  const left = offsetPolyline(piece, hi);
  const right = offsetPolyline(piece, lo);
  return [...right, ...left.reverse()];
}

/**
 * Lane id.
 * @param {string} roadId Road id.
 * @param {'forward' | 'backward'} dir Direction.
 * @param {number} index Lane index.
 * @returns {string} Lane id.
 */
export function laneId(roadId, dir, index) {
  return `${roadId}-${dir === 'forward' ? 'f' : 'b'}${index}`;
}

/**
 * Lane ids of one direction of a road.
 * @param {TopoRoad} road Road.
 * @param {'forward' | 'backward'} dir Direction.
 * @returns {string[]} Lane ids.
 */
export function directionLaneIds(road, dir) {
  const n = dir === 'forward' ? road.way.forward : road.way.backward;
  return Array.from({ length: n }, (_, i) => laneId(road.id, dir, i));
}

/**
 * Line specs that replace a way's own for one road (way distances).
 * @typedef {object} RoadLines
 * @property {LineStretch[]} [forward] Lines between the forward lanes.
 * @property {LineStretch[]} [backward] Lines between the backward lanes.
 * @property {LineStretch[]} [center] Centre line.
 */

/**
 * Road contract object with lanes and lane lines.
 * @param {TopoRoad} road Topology road.
 * @param {RoadLines} [lines] Line specs replacing the way's own.
 * @returns {Road} Road.
 */
export function buildRoad(road, lines = {}) {
  const { way, points } = road;
  const len = polylineLength(points);
  /** @type {Road['lanes']} */
  const lanes = [];
  for (const dir of /** @type {const} */ (['forward', 'backward'])) {
    const n = dir === 'forward' ? way.forward : way.backward;
    for (let i = 0; i < n; i += 1) {
      const { lo, hi } = laneSpan(way, dir, i, LANE_WIDTH_M);
      const centre = offsetPolyline(points, (lo + hi) / 2);
      lanes.push({
        id: laneId(road.id, dir, i),
        dir,
        index: i,
        polygon: band(points, 0, len, lo, hi),
        centerline: dir === 'forward' ? centre : centre.reverse(),
      });
    }
  }

  /** @type {Road['laneLines']} */
  const laneLines = [];
  /**
   * @param {string} base Line id base.
   * @param {LineStretch[]} spec Stretches in way distances.
   * @param {number} lateral Lateral position.
   * @param {string} left Lane on the left.
   * @param {string} right Lane on the right.
   */
  const addLine = (base, spec, lateral, left, right) => {
    const parts = spec
      .map((st) => ({ st, a: Math.max(0, st.fromS - road.s0), b: Math.min(len, st.toS - road.s0) }))
      .filter((p) => p.b - p.a > 0.5);
    parts.forEach(({ st, a, b }, k) => {
      laneLines.push({
        id: parts.length === 1 ? base : `${base}-${k + 1}`,
        left,
        right,
        type: st.type,
        polyline: offsetPolyline(slicePolyline(points, a, b), lateral),
        crossable: st.crossable,
      });
    });
  };
  for (let i = 1; i < way.forward; i += 1) {
    const { lo } = laneSpan(way, 'forward', i, LANE_WIDTH_M);
    addLine(`${road.id}-lf${i}`, lines.forward ?? way.laneLine, lo, laneId(road.id, 'forward', i), laneId(road.id, 'forward', i - 1));
  }
  for (let i = 1; i < way.backward; i += 1) {
    const { hi } = laneSpan(way, 'backward', i, LANE_WIDTH_M);
    addLine(`${road.id}-lb${i}`, lines.backward ?? way.laneLine, hi, laneId(road.id, 'backward', i - 1), laneId(road.id, 'backward', i));
  }
  if (!way.oneway && way.backward > 0) {
    addLine(
      `${road.id}-lc`,
      lines.center ?? way.centerLine,
      0,
      laneId(road.id, 'backward', way.backward - 1),
      laneId(road.id, 'forward', way.forward - 1),
    );
  }

  /** @type {Road} */
  const out = { id: road.id, class: way.cls, divided: way.divided, oneway: way.oneway, lanes, laneLines };
  if (way.osmWayId !== undefined) out.osmWayId = way.osmWayId;
  return out;
}

/**
 * Convex hull (counter-clockwise seen from above in this x/z frame's math sense), collinear points dropped.
 * @param {Vec2[]} points Points.
 * @returns {Vec2[]} Hull ring.
 */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  /**
   * @param {Vec2} o Origin.
   * @param {Vec2} a Point.
   * @param {Vec2} b Point.
   * @returns {number} Cross product.
   */
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  /** @type {Vec2[]} */
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  /** @type {Vec2[]} */
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The two carriageway corners of a road end, and the travel heading into the junction.
 * @param {TopoRoad} road Road.
 * @param {'start' | 'end'} end Which end.
 * @returns {Vec2[]} Corners.
 */
export function roadEndCorners(road, end) {
  const { lo, hi } = carriageway(road.way, LANE_WIDTH_M);
  const len = polylineLength(road.points);
  const s = end === 'start' ? 0 : len;
  const piece = slicePolyline(road.points, Math.max(0, s - 0.5), Math.min(len, s + 0.5));
  const lft = offsetPolyline(piece, hi);
  const rgt = offsetPolyline(piece, lo);
  const i = end === 'start' ? 0 : piece.length - 1;
  return [lft[i], rgt[i]];
}

/**
 * Junction polygon: convex hull of the carriageway corners of every road end at the junction.
 * @param {Topology} topo Topology.
 * @param {string} junctionId Junction id.
 * @returns {Vec2[]} Polygon.
 */
export function junctionPolygon(topo, junctionId) {
  /** @type {Vec2[]} */
  const corners = [];
  for (const road of topo.roads) {
    if (road.startJunction === junctionId) corners.push(...roadEndCorners(road, 'start'));
    if (road.endJunction === junctionId) corners.push(...roadEndCorners(road, 'end'));
  }
  const hull = convexHull(corners);
  if (hull.length < 3) throw new Error(`junction ${junctionId}: fewer than 3 hull points; place its polygon by override`);
  return hull;
}

/**
 * Polygon grown outward by `d` metres (convex hull of the ring's vertices swept by a 16-gon).
 * @param {Vec2[]} polygon Ring.
 * @param {number} d Growth distance.
 * @returns {Vec2[]} Grown convex ring.
 */
export function growPolygon(polygon, d) {
  /** @type {Vec2[]} */
  const pts = [];
  for (const [x, z] of polygon) {
    for (let k = 0; k < 16; k += 1) {
      const a = (k * Math.PI) / 8;
      pts.push([x + d * Math.cos(a), z + d * Math.sin(a)]);
    }
  }
  return convexHull(pts);
}
