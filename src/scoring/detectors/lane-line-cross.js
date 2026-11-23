/**
 * `lane-line-cross`: the body centre crosses a lane line between two lanes of the same travel
 * direction. A fault (tier input `fault`) is: no indicator toward the new lane held for
 * `signalLeadS` before the crossing, a line not crossable from this side, or a second crossing
 * toward the same side within `skipWindowS` (two lanes at once). `unsafeGap` is a car in the
 * target lane closer than `gapAheadM` ahead or `gapBehindM` behind, bumper to bumper.
 * Lines between opposite-direction lanes belong to `against-lane-dir`.
 */

import { angleDiff, pointInPolygon, projectOntoPolyline } from '../../geometry/index.js';
import { laneById } from '../../map-query/index.js';
import { actorsAround, lawfulCross } from './common.js';

/** @typedef {{last: {t: number, side: 'left' | 'right'} | null}} State */
/**
 * @typedef {object} Params
 * @property {number} signalLeadS Indicator lead time.
 * @property {number} skipWindowS Window for a second crossing to count as two lanes at once.
 * @property {number} gapAheadM Smallest safe gap to a car ahead in the target lane.
 * @property {number} gapBehindM Smallest safe gap to a car behind in the target lane.
 */

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
    for (const a of actorsAround(frame, ctx, 'car')) {
      if (!pointInPolygon([a.pose.pos.x, a.pose.pos.z], target.lane.polygon)) continue;
      const gap = Math.abs(a.along) - (vehicle.lengthM + a.info.lengthM) / 2;
      if ((a.along >= 0 && gap < params.gapAheadM) || (a.along < 0 && gap < params.gapBehindM)) unsafeGap = true;
    }
    last = { t: ctx.t, side };
  }
  return {
    detectorState: { last },
    active: crossed && (fault || unsafeGap),
    tierInput: { fault, unsafeGap },
  };
}
