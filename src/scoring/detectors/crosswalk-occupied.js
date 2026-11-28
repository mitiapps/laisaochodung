/**
 * `crosswalk-occupied`: the footprint enters a crosswalk, moving at `minSpeedMps` or more, while
 * an active pedestrian's centre is on it. A crosswalk counts as entered only once the footprint is
 * on it at that speed: creeping onto it below `minSpeedMps` and then driving across while a
 * pedestrian is on it is still an entry. `turning` is true inside a junction with the heading
 * `turnMinDeg` or more off the entry heading, or within `turnWindowS` after a junction pass that
 * turned that much.
 */

import { angleDiff, pointInPolygon } from '../../geometry/index.js';
import { crosswalksOverlapping } from '../../map-query/index.js';
import { actorsAround, DEG, NUMBER } from './common.js';

/** @typedef {{onIds: string[]}} State Crosswalks the footprint is on and entered at speed. */
/** @typedef {{minSpeedMps: number, turnMinDeg: number, turnWindowS: number}} Params */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({ minSpeedMps: NUMBER, turnMinDeg: NUMBER, turnWindowS: NUMBER });

/** @returns {State} Fresh state. */
export function init() {
  return { onIds: [] };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const on = crosswalksOverlapping(ctx.env.map, frame.ego.footprint);
  const moving = ctx.speed >= params.minSpeedMps;
  // A crosswalk the footprint reached below minSpeedMps is not yet entered; it is entered on the
  // first step on it at speed. The first step after a discontinuity enters nothing and counts the
  // crosswalks it starts on as already entered.
  const onIds = on.filter((c) => state.onIds.includes(c.id) || moving || ctx.prev === null).map((c) => c.id);
  const entered = ctx.prev === null ? [] : on.filter((c) => !state.onIds.includes(c.id) && onIds.includes(c.id));
  const occupied =
    moving &&
    entered.some((c) =>
      actorsAround(ctx, 'pedestrian').some((a) => pointInPolygon([a.pose.pos.x, a.pose.pos.z], c.polygon)),
    );
  const turnMin = params.turnMinDeg * DEG;
  const inTurn = ctx.junction !== null && Math.abs(angleDiff(ctx.junction.entryHeading, ctx.heading)) >= turnMin;
  const last = ctx.lastExit;
  const afterTurn =
    last !== null &&
    last.exitT !== undefined &&
    ctx.t - last.exitT <= params.turnWindowS + 1e-9 &&
    Math.abs(angleDiff(last.entryHeading, last.exitHeading ?? last.entryHeading)) >= turnMin;
  return { detectorState: { onIds }, active: occupied, tierInput: { turning: inTurn || afterTurn } };
}
