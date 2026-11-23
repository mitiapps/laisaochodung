/**
 * `stop-line-no-stop`: the front crosses a `stop-sign` line bound to the ego lane, moving
 * forward, and the speed never fell to `stopSpeedMps` over the last `withinM` of travel. Right
 * after a reset the trace is shorter than the window and nothing is judged.
 */

import { stopLineCrossed } from './stop-line-common.js';

/** @typedef {Record<string, never>} State */
/** @typedef {{stopSpeedMps: number, withinM: number}} Params */

/** @returns {State} Fresh state. */
export function init() {
  return {};
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  if (!stopLineCrossed(frame, ctx, 'stop-sign')) return { detectorState: state, active: false, tierInput: {} };
  const minSpeed = ctx.minSpeedWithin(params.withinM);
  return { detectorState: state, active: Number.isFinite(minSpeed) && minSpeed > params.stopSpeedMps, tierInput: {} };
}
