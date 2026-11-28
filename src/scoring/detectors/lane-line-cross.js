/**
 * `lane-line-cross`: the body centre crosses a lane line between two lanes of the same travel
 * direction. A fault (tier input `fault`) is: no indicator toward the new lane held for
 * `signalLeadS` before the crossing, a line not crossable from this side, or a second crossing
 * toward the same side within `skipWindowS` (two lanes at once).
 *
 * `unsafeGap`: a vehicle the ego moves in front of or behind too closely, bumper to bumper. A car
 * counts when its centre is in the target lane; a motorbike only when its footprint overlaps the
 * strip the ego moves into (from the line to one ego width past it), so a motorbike riding along
 * the far side of a wide kerb lane does not block a lawful merge. A vehicle below
 * `stoppedSpeedMps` (a wreck always) is too close under `gapAheadM` ahead or `gapBehindM` behind.
 * A moving one is too close under a floor, or when the follower's time gap after the change is
 * under `gapTimeS` (the ego's speed for a vehicle ahead, the vehicle's own speed for one behind),
 * whichever is larger. The floor is `gapMotorbikeMinM` for a motorbike, so a merge into dense
 * motorbike traffic stays possible, and `gapAheadM` or `gapBehindM` for a car.
 * Lines between opposite-direction lanes belong to `against-lane-dir`.
 */

import { angleDiff, pointInPolygon, projectOntoPolyline } from '../../geometry/index.js';
import { laneById } from '../../map-query/index.js';
import { actorsAround, lawfulCross, NUMBER, VEHICLE_KINDS } from './common.js';

/** @typedef {{last: {t: number, side: 'left' | 'right'} | null}} State */
/**
 * @typedef {object} Params
 * @property {number} signalLeadS Indicator lead time.
 * @property {number} skipWindowS Window for a second crossing to count as two lanes at once.
 * @property {number} gapAheadM Smallest safe gap to a car ahead in the target lane.
 * @property {number} gapBehindM Smallest safe gap to a car behind in the target lane.
 * @property {number} gapTimeS Smallest safe time gap to a moving vehicle.
 * @property {number} gapMotorbikeMinM Smallest safe gap to a moving motorbike, ahead or behind.
 * @property {number} stoppedSpeedMps Below this speed a vehicle counts as stopped for the gap test.
 */

/**
 * Whether a vehicle near a lane change is too close.
 * @param {import('../context.js').NearActor} a Vehicle.
 * @param {number} egoLength Ego length.
 * @param {number} egoSpeed Ego speed.
 * @param {Params} params Params.
 * @returns {boolean} Too close.
 */
function tooClose(a, egoLength, egoSpeed, params) {
  const gap = Math.abs(a.along) - (egoLength + a.lengthM) / 2;
  const ahead = a.along >= 0;
  if (a.speed < params.stoppedSpeedMps) return gap < (ahead ? params.gapAheadM : params.gapBehindM);
  const floor = a.pose.kind === 'motorbike' ? params.gapMotorbikeMinM : ahead ? params.gapAheadM : params.gapBehindM;
  return gap < Math.max(floor, params.gapTimeS * (ahead ? egoSpeed : a.speed));
}

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({
  signalLeadS: NUMBER,
  skipWindowS: NUMBER,
  gapAheadM: NUMBER,
  gapBehindM: NUMBER,
  gapTimeS: NUMBER,
  gapMotorbikeMinM: NUMBER,
  stoppedSpeedMps: NUMBER,
});

/** @returns {State} Fresh state. */
export function init() {
  return { last: null };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const { map, vehicle } = ctx.env;
  let last = state.last;
  let fault = false;
  let unsafeGap = false;
  let crossed = false;
  for (const c of ctx.centerCrossings.laneLines) {
    const line = c.item;
    if (!line.left || !line.right) continue;
    const left = laneById(map, line.left);
    const right = laneById(map, line.right);
    if (!left || !right || left.lane.dir !== right.lane.dir) continue;
    crossed = true;
    const lineHeading = projectOntoPolyline(c.point, line.polyline).heading;
    const aligned = Math.abs(angleDiff(lineHeading, ctx.heading)) < Math.PI / 2;
    /** @type {'left' | 'right'} */
    const side = (c.fromSide === 'right') === aligned ? 'left' : 'right';
    const signalled = ctx.indicator.state === side && ctx.t - ctx.indicator.sinceT >= params.signalLeadS - 1e-9;
    const skipped = last !== null && last.side === side && ctx.t - last.t <= params.skipWindowS + 1e-9;
    if (!signalled || !lawfulCross(line, c.fromSide) || skipped) fault = true;

    const target = c.fromSide === 'right' ? left : right;
    // Lateral coordinate toward the target lane, from the ego centre (on the line this step).
    const toward = side === 'left' ? 1 : -1;
    for (const a of actorsAround(ctx, VEHICLE_KINDS)) {
      if (a.pose.kind === 'motorbike') {
        const s = a.lateral * toward;
        if (s + a.widthM / 2 < 0 || s - a.widthM / 2 > vehicle.widthM) continue;
      } else if (!pointInPolygon([a.pose.pos.x, a.pose.pos.z], target.lane.polygon)) continue;
      if (tooClose(a, vehicle.lengthM, ctx.speed, params)) unsafeGap = true;
    }
    last = { t: ctx.t, side };
  }
  return {
    detectorState: { last },
    active: crossed && (fault || unsafeGap),
    tierInput: { fault, unsafeGap },
  };
}
