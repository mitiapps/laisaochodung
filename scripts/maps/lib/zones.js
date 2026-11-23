/**
 * Zones. Speed-limit zones come only from placed P.127 signs and end at the next junction or a
 * DP.134 (QCVN 41 Điều 26.8); no-stopping zones from P.130, to the next junction; the built-up zone
 * from R.420 (R.421 is not in the sign set, so the zone covers the whole map); `junction-buffer`
 * zones grow each junction polygon by 5 m; `lit` zones cover the whole map when the source says so.
 * OSM `maxspeed` is never a zone source.
 */

import { normalizeAngle, polylineLength } from '../../../src/geometry/index.js';
import { continuation, directionSpan } from './graph.js';
import { LANE_WIDTH_M, band, directionLaneIds, growPolygon } from './lanes.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('./graph.js').Topology} Topology */
/** @typedef {import('./graph.js').TopoRoad} TopoRoad */
/** @typedef {import('../../../src/contracts/map.js').Zone} Zone */

/** Junction buffer distance: no stopping within 5 m of a junction (m). */
export const JUNCTION_BUFFER_M = 5;

/**
 * A position on a road with a travel direction.
 * @typedef {object} Placement
 * @property {TopoRoad} road Road.
 * @property {number} s Distance along the road's reference polyline.
 * @property {'forward' | 'backward'} dir Travel direction relative to the road reference.
 */

/**
 * @typedef {object} Piece
 * @property {TopoRoad} road Road.
 * @property {'forward' | 'backward'} dir Direction.
 * @property {number} a Lower road distance.
 * @property {number} b Upper road distance.
 */

/**
 * @typedef {object} Extent
 * @property {Piece[]} pieces Covered stretches in travel order.
 * @property {string | null} junction Junction the extent runs into, if it ended at one.
 * @property {Placement | null} approach Last road and direction when it ended at a junction.
 */

/**
 * Walks from a placement in its direction, across non-junction road joins, until a stop
 * position, the next junction or a dead end.
 * @param {Topology} topo Topology.
 * @param {Placement} from Start.
 * @param {(road: TopoRoad, dir: 'forward' | 'backward', s: number) => number | null} stopAt Road distance of
 *   the first stop strictly ahead of `s` on this road, or null.
 * @returns {Extent} Extent.
 */
export function walkExtent(topo, from, stopAt) {
  /** @type {Piece[]} */
  const pieces = [];
  let { road, dir, s } = from;
  for (let guard = 0; guard < topo.roads.length + 1; guard += 1) {
    const len = polylineLength(road.points);
    const stop = stopAt(road, dir, s);
    if (dir === 'forward') pieces.push({ road, dir, a: s, b: stop ?? len });
    else pieces.push({ road, dir, a: stop ?? 0, b: s });
    if (stop !== null) return { pieces, junction: null, approach: null };
    const junction = dir === 'forward' ? road.endJunction : road.startJunction;
    if (junction) return { pieces, junction, approach: { road, dir, s: dir === 'forward' ? len : 0 } };
    const next = continuation(topo, road, dir);
    if (!next) return { pieces, junction: null, approach: null };
    road = next.road;
    dir = next.dir;
    s = dir === 'forward' ? 0 : polylineLength(road.points);
  }
  throw new Error('zone walk did not terminate (road loop without a junction)');
}

/**
 * Stop function for signs of `codes` facing the same direction, strictly ahead.
 * @param {Array<{placement: Placement, code: string}>} signs Placed signs.
 * @param {string[]} codes End-sign codes.
 * @param {Placement} origin Walk origin (signs behind it on its own road are ignored).
 * @returns {(road: TopoRoad, dir: 'forward' | 'backward', s: number) => number | null} Stop function.
 */
export function endSignStop(signs, codes, origin) {
  return (road, dir, s) => {
    const ahead = signs
      .filter((x) => codes.includes(x.code) && x.placement.road === road && x.placement.dir === dir)
      .map((x) => x.placement.s)
      .filter((v) => (dir === 'forward' ? v > s + 1e-6 : v < s - 1e-6))
      .filter((v) => road !== origin.road || (dir === 'forward' ? v > origin.s : v < origin.s));
    if (ahead.length === 0) return null;
    return dir === 'forward' ? Math.min(...ahead) : Math.max(...ahead);
  };
}

/**
 * Zones covering an extent: one zone per road piece, binding the lanes of the travel direction.
 * @param {Extent} extent Extent.
 * @param {{id: string, type: Zone['type'], signIds: string[], source: Zone['source'], valueKmh?: number}} base Shared fields.
 * @returns {Zone[]} Zones.
 */
export function zonesForExtent(extent, base) {
  const pieces = extent.pieces.filter((p) => p.b - p.a > 0.5);
  return pieces.map((p, k) => {
    const { lo, hi } = directionSpan(p.road.way, p.dir, LANE_WIDTH_M);
    /** @type {Zone} */
    const zone = {
      id: pieces.length === 1 ? base.id : `${base.id}-${k + 1}`,
      type: base.type,
      polygon: band(p.road.points, p.a, p.b, lo, hi),
      laneIds: directionLaneIds(p.road, p.dir),
      signIds: base.signIds,
      source: base.source,
    };
    if (base.valueKmh !== undefined) zone.valueKmh = base.valueKmh;
    return zone;
  });
}

/**
 * Axis-aligned ring around every given polygon, grown by a margin.
 * @param {Vec2[][]} polygons Polygons.
 * @param {number} margin Margin.
 * @returns {Vec2[]} Rectangle ring.
 */
export function boundingRing(polygons, margin) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const poly of polygons) {
    for (const [x, z] of poly) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
  }
  if (!Number.isFinite(minX)) throw new Error('bounding ring of nothing');
  return [
    [minX - margin, minZ - margin],
    [maxX + margin, minZ - margin],
    [maxX + margin, maxZ + margin],
    [minX - margin, maxZ + margin],
  ];
}

/**
 * Junction-buffer zones: each junction polygon grown by `JUNCTION_BUFFER_M`, binding the lanes of
 * every road that meets it. Source `default`: the 5 m range is statutory, not signed.
 * @param {Topology} topo Topology.
 * @param {Map<string, Vec2[]>} junctionPolygons Polygon per junction id.
 * @returns {Zone[]} Zones.
 */
export function junctionBufferZones(topo, junctionPolygons) {
  return topo.junctions.map((j) => {
    const roads = topo.roads.filter((r) => r.startJunction === j.id || r.endJunction === j.id);
    const laneIds = roads.flatMap((r) => [...directionLaneIds(r, 'forward'), ...directionLaneIds(r, 'backward')]);
    return {
      id: `z-buffer-${j.id}`,
      type: /** @type {const} */ ('junction-buffer'),
      polygon: growPolygon(/** @type {Vec2[]} */ (junctionPolygons.get(j.id)), JUNCTION_BUFFER_M),
      laneIds,
      signIds: [],
      source: /** @type {const} */ ('default'),
    };
  });
}

/**
 * Travel heading on a road at a distance.
 * @param {number} referenceHeading Heading of the road reference direction.
 * @param {'forward' | 'backward'} dir Direction.
 * @returns {number} Travel heading.
 */
export function travelHeading(referenceHeading, dir) {
  return dir === 'forward' ? normalizeAngle(referenceHeading) : normalizeAngle(referenceHeading + Math.PI);
}
