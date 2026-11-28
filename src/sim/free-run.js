/**
 * Placement helpers of a run with the route off (`SimOptions.route: 'off'`, a free run). Such a
 * run has no checkpoints to fall back to, so a reset puts the ego on the nearest lane centreline
 * point to where it was, facing along that lane; and an ego that strays far outside the lanes is
 * reset the same way, since the ground box reaches far past the map with nothing on it.
 */

import { projectOntoPolyline } from '../geometry/index.js';

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
 * The lane centreline point nearest to `p`, with the lane's travel heading there.
 * @param {GameMap} map Map.
 * @param {{x: number, z: number}} p Point.
 * @returns {{pos: {x: number, z: number}, heading: number}} Pose.
 */
export function nearestLanePose(map, p) {
  /** @type {{pos: {x: number, z: number}, heading: number} | null} */
  let best = null;
  let bestDistance = Infinity;
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const q = projectOntoPolyline([p.x, p.z], lane.centerline);
      if (q.distance < bestDistance) {
        bestDistance = q.distance;
        best = { pos: { x: q.point[0], z: q.point[1] }, heading: q.heading };
      }
    }
  }
  if (best === null) throw new Error(`Map ${map.id} has no lanes`);
  return best;
}
