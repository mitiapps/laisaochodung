/**
 * Where the pedestrian signal posts of a map stand: two per crosswalk with a `walkSignalId` whose
 * signal exists, one at each end. Each post stands on the landing beyond its end, just outside the
 * zebra on the side away from the nearest junction, stepped outwards until it clears every lane
 * and junction surface. A post still on the carriageway after `POST_MAX_EXTRA_M` of stepping is
 * dropped and reported, never placed on the road.
 *
 * Pure: the renderer draws a head on every post, and the map build keeps scenery off them.
 */

import { headingVector, leftVector, pointInPolygon, polygonCentroid, projectOntoPolyline } from '../geometry/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Pos2} Pos2 */
/** @typedef {[number, number]} Vec2 */

/** First distance of a post beyond the crosswalk end, across the road (m, design). */
export const POST_OUT_M = 0.6;
/** Distance of a post outside the zebra's side edge, along the road (m, design). */
export const POST_SIDE_M = 0.3;
/** Outward step tried when a post lands on a lane or junction (m, design). */
export const POST_STEP_M = 0.25;
/** Most extra outward distance tried before the post is dropped (m, design). */
export const POST_MAX_EXTRA_M = 3;

/**
 * One pedestrian signal post.
 * @typedef {object} PedestrianPost
 * @property {string} crosswalkId Crosswalk it stands at.
 * @property {string} walkSignalId The crosswalk's `walkSignalId`, which times its head.
 * @property {Pos2} pos Post base.
 * @property {Pos2} faces Ground point its head faces: the middle of the crosswalk's other end.
 */

/**
 * Whether a ground point lies on a lane or junction surface.
 * @param {GameMap} map Map.
 * @param {Vec2} p Point.
 * @returns {boolean} On the carriageway.
 */
function onCarriageway(map, p) {
  for (const road of map.roads) for (const lane of road.lanes) if (pointInPolygon(p, lane.polygon)) return true;
  return map.junctions.some((j) => pointInPolygon(p, j.polygon));
}

/**
 * Travel heading of the lane centreline nearest to a point, or null on a map with no lanes.
 * @param {GameMap} map Map.
 * @param {Vec2} point Point.
 * @returns {number | null} Heading.
 */
function nearestLaneHeading(map, point) {
  let best = Infinity;
  /** @type {number | null} */
  let heading = null;
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const q = projectOntoPolyline(point, lane.centerline);
      if (q.distance < best) {
        best = q.distance;
        heading = q.heading;
      }
    }
  }
  return heading;
}

/**
 * Every pedestrian signal post, in map order, the end on the crosswalk's right (seen along the
 * traffic) first. Crosswalks without a `walkSignalId`, whose signal is missing, or whose traffic
 * heading is unknown get none.
 * @param {GameMap} map Map.
 * @returns {{posts: PedestrianPost[], dropped: string[]}} Posts, and a note per post dropped for
 *   standing on the carriageway.
 */
export function pedestrianPostPlacements(map) {
  const signalIds = new Set(map.signals.map((s) => s.id));
  /** @type {PedestrianPost[]} */
  const posts = [];
  /** @type {string[]} */
  const dropped = [];
  for (const cw of map.crosswalks) {
    const walkSignalId = cw.walkSignalId;
    if (!walkSignalId || !signalIds.has(walkSignalId)) continue;
    const ring = /** @type {Vec2[]} */ (cw.polygon);
    const centre = polygonCentroid(ring);
    const heading = nearestLaneHeading(map, centre);
    if (heading === null) continue;
    // u along the traffic, v across it (the walking direction), as the zebra stripes are laid.
    const f = headingVector(heading);
    const l = leftVector(heading);
    const us = ring.map((p) => p[0] * f[0] + p[1] * f[1]);
    const vs = ring.map((p) => p[0] * l[0] + p[1] * l[1]);
    const [uMin, uMax, vMin, vMax] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    const uMid = (uMin + uMax) / 2;
    // The post stands on the side of the zebra away from the nearest junction, clear of the
    // turning traffic; with no junction, on the side the traffic comes from.
    let side = -1;
    let best = Infinity;
    for (const j of map.junctions) {
      const c = polygonCentroid(/** @type {Vec2[]} */ (j.polygon));
      const d = Math.hypot(c[0] - centre[0], c[1] - centre[1]);
      if (d < best) {
        best = d;
        side = (centre[0] - c[0]) * f[0] + (centre[1] - c[1]) * f[1] >= 0 ? 1 : -1;
      }
    }
    const uPost = side > 0 ? uMax + POST_SIDE_M : uMin - POST_SIDE_M;
    /**
     * @param {number} u Along.
     * @param {number} v Across.
     * @returns {Vec2} World point.
     */
    const toWorld = (u, v) => [u * f[0] + v * l[0], u * f[1] + v * l[1]];
    for (const [end, other, out] of /** @type {const} */ ([
      [vMin, vMax, -1],
      [vMax, vMin, 1],
    ])) {
      let extra = 0;
      let p = toWorld(uPost, end + out * POST_OUT_M);
      while (onCarriageway(map, p) && extra < POST_MAX_EXTRA_M - 1e-9) {
        extra += POST_STEP_M;
        p = toWorld(uPost, end + out * (POST_OUT_M + extra));
      }
      if (onCarriageway(map, p)) {
        dropped.push(`pedestrian post of crosswalk ${cw.id} still on the carriageway ${POST_OUT_M + extra} m out: dropped`);
        continue;
      }
      const faces = toWorld(uMid, other);
      posts.push({ crosswalkId: cw.id, walkSignalId, pos: { x: p[0], z: p[1] }, faces: { x: faces[0], z: faces[1] } });
    }
  }
  return { posts, dropped };
}
