/**
 * `speed-over-limit`: speed above the limit in force by at least `minOverKmh`, held for
 * `sustainS`. The over-speed is rounded to 1e-6 km/h so a speed built as limit + 20 km/h lands on
 * 20, not 20.000000000004, at the band edges. A breach against an unverified TT 38 default limit
 * carries `basisVerified: false`.
 */

import { heldFor, holdSince, NUMBER } from './common.js';

/** @typedef {{overSince: number | null}} State */
/** @typedef {{minOverKmh: number, sustainS: number}} Params */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({ minOverKmh: NUMBER, sustainS: NUMBER });

/** @returns {State} Fresh state. */
export function init() {
  return { overSince: null };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const over = ctx.limit ? Math.round((ctx.speedKmh - ctx.limit.kmh) * 1e6) / 1e6 : null;
  const cond = over !== null && over >= params.minOverKmh;
  const overSince = holdSince(state.overSince, cond, ctx.t);
  return {
    detectorState: { overSince },
    active: cond && heldFor(overSince, ctx.t, params.sustainS),
    tierInput: { overKmh: over },
    basisVerified: ctx.limit ? ctx.limit.verified : true,
  };
}
