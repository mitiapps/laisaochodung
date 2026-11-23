/**
 * `horn-in-window`: the horn sounds inside a built-up zone between `fromMin` and `toMin`
 * (minutes of day, wrapping midnight).
 */

import { inClockWindow } from './common.js';

/** @typedef {Record<string, never>} State */
/** @typedef {{fromMin: number, toMin: number}} Params */

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
  const active = frame.ego.horn && ctx.builtUp && inClockWindow(frame.env.clockMin, params.fromMin, params.toMin);
  return { detectorState: state, active, tierInput: {} };
}
