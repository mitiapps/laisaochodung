/**
 * Pure placement helpers that read the map: travel direction at a point and the finish arch.
 */

import { headingVector, leftVector, polygonCentroid, projectOntoPolyline } from '../geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */

/**
 * Travel heading of the lane whose centre line passes closest to a point.
 * @param {GameMap} map Map.
 * @param {Vec2} point Ground point.
 * @returns {number | null} Heading, or null when the map has no lanes.
 */
export function nearestLaneHeading(map, point) {
  let best = Infinity;
  /** @type {number | null} */
  let heading = null;
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const p = projectOntoPolyline(point, lane.centerline);
      if (p.distance < best) {
        best = p.distance;
        heading = p.heading;
      }
    }
  }
  return heading;
}

/**
 * Travel heading into the finish: the heading of the last checkpoint, else of the start.
 * @param {GameMap} map Map.
 * @returns {number} Heading.
 */
export function finishHeading(map) {
  const cps = map.route.checkpoints;
  return cps.length > 0 ? cps[cps.length - 1].heading : map.route.start.heading;
}

/**
 * Pose of the finish arch: centred on the finish polygon, spanning its extent across the travel
 * heading.
 * @param {Vec2[]} polygon Finish polygon.
 * @param {number} heading Travel heading through the finish.
 * @returns {{x: number, z: number, heading: number, width: number}} Arch pose and inner width.
 */
export function finishArchPose(polygon, heading) {
  const [cx, cz] = polygonCentroid(polygon);
  const [lx, lz] = leftVector(heading);
  const across = polygon.map((p) => (p[0] - cx) * lx + (p[1] - cz) * lz);
  const width = Math.max(...across) - Math.min(...across);
  // Shift the centre onto the middle of the across extent (the centroid may sit off it).
  const mid = (Math.max(...across) + Math.min(...across)) / 2;
  return { x: cx + lx * mid, z: cz + lz * mid, heading, width };
}

/**
 * Point `distance` metres ahead of a pose.
 * @param {{x: number, z: number}} pos Position.
 * @param {number} heading Heading.
 * @param {number} distance Metres ahead (negative: behind).
 * @returns {Vec2} Point.
 */
export function ahead(pos, heading, distance) {
  const [fx, fz] = headingVector(heading);
  return [pos.x + fx * distance, pos.z + fz * distance];
}
