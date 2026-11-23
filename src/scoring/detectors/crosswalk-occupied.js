/**
 * `crosswalk-occupied`: the footprint enters a crosswalk, moving at `minSpeedMps` or more, while
 * an active pedestrian's centre is on it. `turning` is true inside a junction with the heading
 * `turnMinDeg` or more off the entry heading, or within `turnWindowS` after a junction pass that
 * turned that much.
 */

import { angleDiff, pointInPolygon } from '../../geometry/index.js';
import { crosswalksOverlapping } from '../../map-query/index.js';
import { DEG } from './common.js';

/** @typedef {{onIds: string[]}} State */
/** @typedef {{minSpeedMps: number, turnMinDeg: number, turnWindowS: number}} Params */

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
  const onIds = on.map((c) => c.id);
  const entered = ctx.prev === null ? [] : on.filter((c) => !state.onIds.includes(c.id));
  const occupied =
    ctx.speed >= params.minSpeedMps &&
    entered.some((c) =>
      frame.actors.some((a) => a.kind === 'pedestrian' && a.active && pointInPolygon([a.pos.x, a.pos.z], c.polygon)),
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
