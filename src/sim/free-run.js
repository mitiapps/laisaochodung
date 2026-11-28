/**
 * Placement helpers of a run with the route off (`SimOptions.route: 'off'`, a free run). Such a
 * run has no checkpoints to fall back to, so a reset puts the ego on the nearest lane centreline
 * point to where it was that is clear of obstacles and scripted actors, facing along that lane; and
 * an ego that strays far outside the lanes is
 * reset the same way, since the ground box reaches far past the map with nothing on it.
 */

import { footprint, pointAtDistance, polygonsIntersect, polylineLength, projectOntoPolyline } from '../geometry/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */

/**
 * Distance outside the bounding box of the lane polygons beyond which the sim resets the ego in a
 * free run, in metres (paramBasis: design).
 */
export const MAP_EDGE_RESET_M = 60;

/**
 * @typedef {object} Bounds
 * @property {number} minX Smallest x.
 * @property {number} minZ Smallest z.
 * @property {number} maxX Largest x.
 * @property {number} maxZ Largest z.
 */

/**
 * Bounding box of every lane polygon of the map.
 * @param {GameMap} map Map.
 * @returns {Bounds} Box.
 */
export function laneBounds(map) {
  const b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      for (const [x, z] of lane.polygon) {
        b.minX = Math.min(b.minX, x);
        b.minZ = Math.min(b.minZ, z);
        b.maxX = Math.max(b.maxX, x);
        b.maxZ = Math.max(b.maxZ, z);
      }
    }
  }
  if (!Number.isFinite(b.minX)) throw new Error(`Map ${map.id} has no lanes`);
  return b;
}

/**
 * Distance from a point to a box: 0 inside.
 * @param {Bounds} b Box.
 * @param {{x: number, z: number}} p Point.
 * @returns {number} Distance in metres.
 */
export function distanceOutside(b, p) {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Clearance kept between the ego footprint and an obstacle or scripted actor at a free-run reset
 * pose, in metres: more than an obstacle wall box is thick (paramBasis: design).
 */
export const RESET_CLEARANCE_M = 0.5;
/** Step along a lane between reset candidates, in metres (paramBasis: design). */
export const RESET_SLIDE_STEP_M = 0.5;

/** @typedef {import('../contracts/map.js').Pos2} Pos2 */
/** @typedef {{pos: Pos2, heading: number}} Pose */
/** @typedef {[number, number]} Vec2 */

/**
 * What a reset pose must keep clear of.
 * @typedef {object} ResetClearance
 * @property {number} lengthM Ego length.
 * @property {number} widthM Ego width.
 * @property {ReadonlyArray<{pos: Pos2, heading: number, lengthM: number, widthM: number}>} actors
 *   Scripted actor poses now.
 */

/**
 * A blocker ring with a bounding circle for a cheap far-away test.
 * @typedef {{ring: Vec2[], cx: number, cz: number, r: number}} Blocker
 */

/**
 * @param {Vec2[]} ring Ring.
 * @returns {Blocker} Ring with its bounding circle.
 */
function blockerOf(ring) {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of ring) {
    cx += x / ring.length;
    cz += z / ring.length;
  }
  let r = 0;
  for (const [x, z] of ring) r = Math.max(r, Math.hypot(x - cx, z - cz));
  return { ring, cx, cz, r };
}

/**
 * The lane centreline point nearest to `p`, with the lane's travel heading there. With
 * `clearance`, a point where the ego footprint (grown by `RESET_CLEARANCE_M`) would overlap an
 * obstacle or a scripted actor is skipped: the pose slides along that lane, alternately ahead and
 * behind in `RESET_SLIDE_STEP_M` steps, until it is clear; failing that the next nearest lanes are
 * tried the same way, and failing every lane the route start.
 * @param {GameMap} map Map.
 * @param {{x: number, z: number}} p Point.
 * @param {ResetClearance} [clearance] Ego size and scripted actor poses to keep clear of.
 * @returns {Pose} Pose.
 */
export function nearestLanePose(map, p, clearance) {
  /** @type {{centerline: Vec2[], s: number, distance: number}[]} */
  const lanes = [];
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const q = projectOntoPolyline([p.x, p.z], lane.centerline);
      lanes.push({ centerline: /** @type {Vec2[]} */ (lane.centerline), s: q.s, distance: q.distance });
    }
  }
  if (lanes.length === 0) throw new Error(`Map ${map.id} has no lanes`);
  // Stable sort: equal distances keep map order, as the first-found nearest lane did.
  lanes.sort((a, b) => a.distance - b.distance);
  /**
   * @param {Vec2[]} centerline Centreline.
   * @param {number} s Distance along it.
   * @returns {Pose} Pose there.
   */
  const poseAt = (centerline, s) => {
    const q = pointAtDistance(centerline, s);
    return { pos: { x: q.point[0], z: q.point[1] }, heading: q.heading };
  };
  if (!clearance) {
    const nearest = projectOntoPolyline([p.x, p.z], lanes[0].centerline);
    return { pos: { x: nearest.point[0], z: nearest.point[1] }, heading: nearest.heading };
  }

  const blockers = [
    ...map.obstacles.map((o) => blockerOf(/** @type {Vec2[]} */ (o.footprint))),
    ...clearance.actors.map((a) => blockerOf(footprint(a.pos, a.heading, a.lengthM, a.widthM))),
  ];
  const len = clearance.lengthM + 2 * RESET_CLEARANCE_M;
  const wid = clearance.widthM + 2 * RESET_CLEARANCE_M;
  const reach = Math.hypot(len, wid) / 2;
  /**
   * @param {Pose} pose Candidate.
   * @returns {boolean} The grown ego footprint there overlaps no blocker.
   */
  const clear = (pose) => {
    const ring = footprint(pose.pos, pose.heading, len, wid);
    return blockers.every((b) => Math.hypot(b.cx - pose.pos.x, b.cz - pose.pos.z) > b.r + reach || !polygonsIntersect(ring, b.ring));
  };
  for (const lane of lanes) {
    const total = polylineLength(lane.centerline);
    // The projection, then alternately ahead and behind it along the lane.
    for (let k = 0; k * RESET_SLIDE_STEP_M <= total; k += 1) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const s = lane.s + sign * k * RESET_SLIDE_STEP_M;
        if (s < 0 || s > total) continue;
        const pose = poseAt(lane.centerline, s);
        if (clear(pose)) return pose;
      }
    }
  }
  return { pos: { ...map.route.start.pos }, heading: map.route.start.heading };
}
