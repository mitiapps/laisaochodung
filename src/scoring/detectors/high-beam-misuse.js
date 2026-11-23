/**
 * `high-beam-misuse`: high beam (a held flash counts) for `sustainS` while any of these holds:
 * the ego is in a lit zone of a built-up area; an oncoming car (heading more than 135° off the
 * ego's) or an active pedestrian is ahead within `rangeM` and `lateralM` to the side; or the ego
 * is turning in a junction (heading `turnMinDeg` or more off its entry heading).
 */

import { angleDiff } from '../../geometry/index.js';
import { actorsAround, DEG, heldFor, holdSince } from './common.js';

/** @typedef {{since: number | null}} State */
/**
 * @typedef {object} Params
 * @property {number} rangeM Distance ahead within which an actor counts.
 * @property {number} lateralM Distance to the side within which an actor counts.
 * @property {number} sustainS Seconds the high beam must stay on (a short flash is a lawful signal).
 * @property {number} turnMinDeg Heading change in a junction that counts as turning.
 */

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
  if (frame.ego.lights === 'high') {
    const litStreet = ctx.builtUp && ctx.lit;
    const facing = actorsAround(frame, ctx, null).some(
      (a) =>
        a.along > 0 &&
        a.along <= params.rangeM &&
        Math.abs(a.lateral) <= params.lateralM &&
        (a.pose.kind === 'pedestrian' || Math.abs(angleDiff(a.pose.heading, ctx.heading)) > 0.75 * Math.PI),
    );
    const turning = ctx.junction !== null && Math.abs(angleDiff(ctx.junction.entryHeading, ctx.heading)) >= params.turnMinDeg * DEG;
    cond = litStreet || facing || turning;
  }
  const since = holdSince(state.since, cond, ctx.t);
  return { detectorState: { since }, active: cond && heldFor(since, ctx.t, params.sustainS), tierInput: {} };
}
