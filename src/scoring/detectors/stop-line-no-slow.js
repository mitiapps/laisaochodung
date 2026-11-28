/**
 * `stop-line-no-slow`: the front crosses a `give-way` line bound to the ego lane, or enters an
 * unsignalised junction from a road that is not one of its priority roads (the W.208 case), and
 * the speed never fell to `slowSpeedMps` over the last `withinM` of travel. An approach with its
 * own STOP or give-way line is judged at that line only.
 */

import { locate, stopLinesForLane } from '../../map-query/index.js';
import { NUMBER } from './common.js';
import { givesWayAt, stopLineCrossed } from './stop-line-common.js';

/** @typedef {{frontJunctionId: string | null}} State */
/** @typedef {{slowSpeedMps: number, withinM: number}} Params */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({ slowSpeedMps: NUMBER, withinM: NUMBER });

/** @returns {State} Fresh state. */
export function init() {
  return { frontJunctionId: null };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const { map } = ctx.env;
  const frontJunctionId = locate(map, ctx.front, ctx.heading).junctionId;
  const enteredJunction =
    frontJunctionId !== null &&
    frontJunctionId !== state.frontJunctionId &&
    ctx.prev !== null &&
    frame.ego.speed > 0 &&
    givesWayAt(map, frontJunctionId, ctx.loc.roadId) &&
    // A STOP or give-way line on the approach is judged at the line, not again at the junction.
    !(ctx.loc.laneId !== null && stopLinesForLane(map, ctx.loc.laneId).some((s) => s.control !== 'signal'));
  const judged = stopLineCrossed(frame, ctx, 'give-way') || enteredJunction;
  const minSpeed = judged ? ctx.minSpeedWithin(params.withinM) : Infinity;
  return {
    detectorState: { frontJunctionId },
    active: judged && Number.isFinite(minSpeed) && minSpeed > params.slowSpeedMps,
    tierInput: {},
  };
}
