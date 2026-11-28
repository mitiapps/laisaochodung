/**
 * Pure interpolation between two consecutive frames. `reset` and `fall` are discontinuities
 * (`DISCONTINUITY_EVENTS`): across them the renderer draws the newer frame as is.
 */

import { DISCONTINUITY_EVENTS } from '../contracts/telemetry.js';
import { lerp, lerpAngle } from './math.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */

/**
 * @typedef {object} DrawPose
 * @property {number} x X in metres.
 * @property {number} y Height in metres.
 * @property {number} z Z in metres.
 * @property {number} heading Heading θ.
 */

/**
 * Whether a frame starts after a discontinuity.
 * @param {Frame} frame Frame.
 * @returns {boolean} True when it carries a `reset` or `fall` event.
 */
export function isDiscontinuity(frame) {
  return frame.events.some((e) => DISCONTINUITY_EVENTS.includes(e.type));
}

/**
 * Whether `prev` may be blended into `frame`: it exists, is older, and no discontinuity starts
 * the newer frame.
 * @param {Frame | null} prev Previous frame.
 * @param {Frame} frame Current frame.
 * @returns {boolean} Interpolate.
 */
export function canInterpolate(prev, frame) {
  return prev !== null && prev.tick < frame.tick && !isDiscontinuity(frame);
}

/**
 * Clamps alpha to 0..1; NaN becomes 1 (draw the newest frame).
 * @param {number} alpha Raw alpha.
 * @returns {number} Alpha.
 */
function clampAlpha(alpha) {
  if (!Number.isFinite(alpha)) return 1;
  return Math.max(0, Math.min(1, alpha));
}

/**
 * Ego pose drawn between two frames.
 * @param {Frame | null} prev Previous frame.
 * @param {Frame} frame Current frame.
 * @param {number} alpha 0 draws `prev`, 1 draws `frame`.
 * @returns {DrawPose} Pose.
 */
export function interpolateEgo(prev, frame, alpha) {
  const b = frame.ego;
  if (!prev || !canInterpolate(prev, frame)) return { x: b.pos.x, y: b.pos.y, z: b.pos.z, heading: b.heading };
  const a = prev.ego;
  const t = clampAlpha(alpha);
  return {
    x: lerp(a.pos.x, b.pos.x, t),
    y: lerp(a.pos.y, b.pos.y, t),
    z: lerp(a.pos.z, b.pos.z, t),
    heading: lerpAngle(a.heading, b.heading, t),
  };
}

/**
 * Actor pose drawn between two frames; the actor is matched by id.
 * @param {Frame | null} prev Previous frame.
 * @param {Frame} frame Current frame.
 * @param {ActorPose} pose Actor pose in `frame`.
 * @param {number} alpha 0 draws `prev`, 1 draws `frame`.
 * @param {DrawPose} [out] Pose to write into, so a per-frame caller allocates nothing; a new one
 *   when omitted.
 * @returns {DrawPose} Pose on the ground (`out` when given).
 */
export function interpolateActor(prev, frame, pose, alpha, out = { x: 0, y: 0, z: 0, heading: 0 }) {
  const old = prev && canInterpolate(prev, frame) ? prev.actors.find((a) => a.id === pose.id) : undefined;
  const t = old ? clampAlpha(alpha) : 1;
  out.x = old ? lerp(old.pos.x, pose.pos.x, t) : pose.pos.x;
  out.y = 0;
  out.z = old ? lerp(old.pos.z, pose.pos.z, t) : pose.pos.z;
  out.heading = old ? lerpAngle(old.heading, pose.heading, t) : pose.heading;
  return out;
}
