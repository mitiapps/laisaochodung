/**
 * `lights-required`: headlights off while moving at `minSpeedMps` or more, from `nightFromMin`
 * to `nightToMin` (minutes of day, wrapping midnight) or in rain, held for `sustainS`.
 */

import { heldFor, holdSince, inClockWindow, NUMBER } from './common.js';

/** @typedef {{since: number | null}} State */
/**
 * @typedef {object} Params
 * @property {number} nightFromMin Start of the night window, minute of day.
 * @property {number} nightToMin End of the night window, minute of day.
 * @property {number} minSpeedMps Lowest speed that counts as moving.
 * @property {number} sustainS Seconds the condition must hold.
 */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({ nightFromMin: NUMBER, nightToMin: NUMBER, minSpeedMps: NUMBER, sustainS: NUMBER });

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
  const required = inClockWindow(frame.env.clockMin, params.nightFromMin, params.nightToMin) || frame.env.weather === 'rain';
  const cond = required && frame.ego.lights === 'off' && ctx.speed >= params.minSpeedMps;
  const since = holdSince(state.since, cond, ctx.t);
  return { detectorState: { since }, active: cond && heldFor(since, ctx.t, params.sustainS), tierInput: {} };
}
