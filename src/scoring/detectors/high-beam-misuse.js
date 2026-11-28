/**
 * `high-beam-misuse`: high beam (a held flash counts) for `sustainS` while any of these holds:
 * the ego is in a lit zone of a built-up area; an oncoming car (heading more than 135° off the
 * ego's) or a pedestrian crossing the road is ahead within `rangeM` and `lateralM` to the side;
 * or the ego is turning in a junction (heading `turnMinDeg` or more off its entry heading).
 *
 * ND 168 fines high beam "khi gặp người đi bộ qua đường", so a pedestrian counts only on a
 * crosswalk, a lane or a junction, not on the pavement. It excepts oncoming cars behind "dải
 * phân cách có khả năng chống chói"; maps record only whether a road is divided, not whether its
 * median blocks glare, so on a divided road oncoming cars never count. That is a game choice: it
 * misses a breach behind a median that does not block glare rather than cite one the law excepts.
 */

import { angleDiff } from '../../geometry/index.js';
import { crosswalksAt, locate, roadById } from '../../map-query/index.js';
import { actorsAround, DEG, heldFor, holdSince, NUMBER } from './common.js';

/**
 * Whether a pedestrian stands where it is crossing the road: on a crosswalk, a lane or a junction.
 * @param {import('../../contracts/index.js').GameMap} map Map.
 * @param {import('../../contracts/index.js').ActorPose} pose Pedestrian pose.
 * @returns {boolean} Crossing.
 */
function crossingRoad(map, pose) {
  const loc = locate(map, pose.pos, pose.heading);
  return loc.laneId !== null || loc.junctionId !== null || crosswalksAt(map, pose.pos).length > 0;
}

/** @typedef {{since: number | null}} State */
/**
 * @typedef {object} Params
 * @property {number} rangeM Distance ahead within which an actor counts.
 * @property {number} lateralM Distance to the side within which an actor counts.
 * @property {number} sustainS Seconds the high beam must stay on (a short flash is a lawful signal).
 * @property {number} turnMinDeg Heading change in a junction that counts as turning.
 */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({ rangeM: NUMBER, lateralM: NUMBER, sustainS: NUMBER, turnMinDeg: NUMBER });

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
    const { map } = ctx.env;
    const litStreet = ctx.builtUp && ctx.lit;
    const road = ctx.loc.roadId === null ? null : roadById(map, ctx.loc.roadId);
    const divided = road !== null && road.divided;
    const facing = actorsAround(ctx, null).some(
      (a) =>
        a.along > 0 &&
        a.along <= params.rangeM &&
        Math.abs(a.lateral) <= params.lateralM &&
        (a.pose.kind === 'pedestrian'
          ? crossingRoad(map, a.pose)
          : !divided && Math.abs(angleDiff(a.pose.heading, ctx.heading)) > 0.75 * Math.PI),
    );
    const turning = ctx.junction !== null && Math.abs(angleDiff(ctx.junction.entryHeading, ctx.heading)) >= params.turnMinDeg * DEG;
    cond = litStreet || facing || turning;
  }
  const since = holdSince(state.since, cond, ctx.t);
  return { detectorState: { since }, active: cond && heldFor(since, ctx.t, params.sustainS), tierInput: {} };
}
