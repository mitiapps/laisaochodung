/**
 * `footprint-in-polygon`: the body centre inside a pavement polygon while moving at
 * `minSpeedMps` or more, held for `sustainS`. A wheel brushing the kerb does not count.
 */

import { pavementsAt } from '../../map-query/index.js';
import { heldFor, holdSince } from './common.js';

/** @typedef {{since: number | null}} State */
/** @typedef {{minSpeedMps: number, sustainS: number}} Params */

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
  const cond = ctx.speed >= params.minSpeedMps && pavementsAt(ctx.env.map, ctx.pos).length > 0;
  const since = holdSince(state.since, cond, ctx.t);
  return { detectorState: { since }, active: cond && heldFor(since, ctx.t, params.sustainS), tierInput: {} };
}
