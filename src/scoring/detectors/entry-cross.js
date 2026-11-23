/**
 * `entry-cross`: the front crosses a no-entry line with a heading within `headingToleranceDeg`
 * of the banned heading, and the ego's class is banned there (or the line bans `all`).
 */

import { angleDiff } from '../../geometry/index.js';
import { DEG } from './common.js';

/** @typedef {Record<string, never>} State */
/** @typedef {{headingToleranceDeg: number}} Params */

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
  const cls = ctx.env.vehicle.legalClass;
  const active =
    frame.ego.speed > 0 &&
    ctx.frontCrossings.entries.some(
      (c) =>
        Math.abs(angleDiff(c.item.heading, ctx.heading)) < params.headingToleranceDeg * DEG &&
        (c.item.bannedClasses.includes('all') || c.item.bannedClasses.includes(cls)),
    );
  return { detectorState: state, active, tierInput: {} };
}
