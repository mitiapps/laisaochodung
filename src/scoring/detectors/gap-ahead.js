/**
 * `gap-ahead`: above `minSpeedMps`, the time gap (bumper gap / speed) to the nearest active car
 * ahead in the ego's lane stays under `minTimeGapS` for `sustainS`. Below the speed a queue at a
 * light never counts.
 */

import { locate } from '../../map-query/index.js';
import { actorsAround, heldFor, holdSince } from './common.js';

/** @typedef {{since: number | null}} State */
/** @typedef {{minSpeedMps: number, minTimeGapS: number, sustainS: number}} Params */

/** @returns {State} Fresh state. */
export function init() {
  return { since: null };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  let cond = false;
  const laneId = ctx.loc.laneId;
  if (ctx.speed > params.minSpeedMps && laneId) {
    for (const a of actorsAround(frame, ctx, 'car')) {
      if (a.along <= 0) continue;
      if (locate(ctx.env.map, a.pose.pos, a.pose.heading).laneId !== laneId) continue;
      const gap = a.along - (ctx.env.vehicle.lengthM + a.info.lengthM) / 2;
      if (gap / ctx.speed < params.minTimeGapS) cond = true;
    }
  }
  const since = holdSince(state.since, cond, ctx.t);
  return { detectorState: { since }, active: cond && heldFor(since, ctx.t, params.sustainS), tierInput: {} };
}
