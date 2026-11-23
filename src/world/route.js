/**
 * Route progress: checkpoints in order, then the finish polygon, with a time limit.
 *
 * A checkpoint counts when the ego centre lies inside its gate box: within `CHECKPOINT_DEPTH_M`
 * along the checkpoint heading and `CHECKPOINT_HALF_WIDTH_M` across it. At 60 Hz a 6 m deep box
 * cannot be skipped below 360 m/s. The finish counts only after every checkpoint. `timeout` fires
 * once when `t ≥ timeLimitS` and the finish was not reached in the same call. After `finish` or
 * `timeout` no further events are emitted. Progress survives `reset` events.
 */

import { headingOf, headingVector, pointInPolygon, polygonCentroid, segmentIntersection } from '../geometry/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').RouteNav} RouteNav */
/** @typedef {import('../contracts/telemetry.js').FrameEvent} FrameEvent */

/** Half depth of a checkpoint gate along its heading, in metres. */
export const CHECKPOINT_DEPTH_M = 3;

/** Half width of a checkpoint gate across its heading, in metres. */
export const CHECKPOINT_HALF_WIDTH_M = 8;

/** How far ahead of the last checkpoint the finish band is searched for, in metres. */
const FINISH_RAY_M = 2000;

/**
 * Navigation target inside the finish area: the middle of the stretch of the finish polygon
 * straight ahead of the last checkpoint (of the start with no checkpoint), so the target stays in
 * the lane the route arrives in. On a road with several lanes per direction the polygon's centroid
 * can sit on a lane line. Falls back to the centroid when that ray misses the polygon.
 * @param {GameMap} map Map.
 * @returns {import('../contracts/map.js').Vec2} Target point.
 */
export function finishTarget(map) {
  const { checkpoints, finish, start } = map.route;
  const from = checkpoints.at(-1) ?? start;
  const p = /** @type {import('../contracts/map.js').Vec2} */ ([from.pos.x, from.pos.z]);
  const [fx, fz] = headingVector(from.heading);
  const far = /** @type {import('../contracts/map.js').Vec2} */ ([p[0] + fx * FINISH_RAY_M, p[1] + fz * FINISH_RAY_M]);
  const poly = finish.polygon;
  /** @type {number[]} */
  const hits = [];
  for (let i = 0; i < poly.length; i += 1) {
    const hit = segmentIntersection(p, far, poly[i], poly[(i + 1) % poly.length]);
    if (hit) hits.push(hit.t);
  }
  hits.sort((a, b) => a - b);
  if (hits.length < 2) return polygonCentroid(poly);
  const t = (hits[0] + hits[1]) / 2;
  const target = /** @type {import('../contracts/map.js').Vec2} */ ([p[0] + (far[0] - p[0]) * t, p[1] + (far[1] - p[1]) * t]);
  return pointInPolygon(target, poly) ? target : polygonCentroid(poly);
}

/**
 * @typedef {object} RouteState
 * @property {number} next Index of the next checkpoint.
 * @property {boolean} finished Finish reached.
 * @property {boolean} timedOut Time limit reached first.
 */

/**
 * Initial route state.
 * @returns {RouteState} State.
 */
export function createRouteState() {
  return { next: 0, finished: false, timedOut: false };
}

/**
 * Whether a point is inside a checkpoint gate.
 * @param {{pos: {x: number, z: number}, heading: number}} checkpoint Checkpoint.
 * @param {{x: number, z: number}} p Point.
 * @returns {boolean} Inside the gate box.
 */
export function insideCheckpoint(checkpoint, p) {
  const [fx, fz] = headingVector(checkpoint.heading);
  const dx = p.x - checkpoint.pos.x;
  const dz = p.z - checkpoint.pos.z;
  const along = dx * fx + dz * fz;
  const across = -dx * fz + dz * fx;
  return Math.abs(along) <= CHECKPOINT_DEPTH_M && Math.abs(across) <= CHECKPOINT_HALF_WIDTH_M;
}

/**
 * Advances route progress for the ego position at time `t`.
 * @param {RouteState} routeState Current state.
 * @param {GameMap} map Map.
 * @param {{x: number, z: number}} egoPos Ego centre.
 * @param {number} t Run time in seconds.
 * @returns {{state: RouteState, events: FrameEvent[], nav: RouteNav}} Next state, events and nav.
 */
export function stepRoute(routeState, map, egoPos, t) {
  const { checkpoints, finish, timeLimitS } = map.route;
  /** @type {FrameEvent[]} */
  const events = [];
  let { next, finished, timedOut } = routeState;
  if (!finished && !timedOut) {
    if (next < checkpoints.length && insideCheckpoint(checkpoints[next], egoPos)) {
      events.push({ type: 'checkpoint', index: next });
      next += 1;
    }
    if (next >= checkpoints.length && pointInPolygon([egoPos.x, egoPos.z], finish.polygon)) {
      events.push({ type: 'finish' });
      finished = true;
    } else if (t >= timeLimitS) {
      events.push({ type: 'timeout' });
      timedOut = true;
    }
  }
  const target = next < checkpoints.length ? [checkpoints[next].pos.x, checkpoints[next].pos.z] : finishTarget(map);
  const dx = target[0] - egoPos.x;
  const dz = target[1] - egoPos.z;
  return {
    state: { next, finished, timedOut },
    events,
    nav: { nextCheckpoint: next, distanceM: Math.hypot(dx, dz), bearingRad: headingOf(dx, dz) },
  };
}
