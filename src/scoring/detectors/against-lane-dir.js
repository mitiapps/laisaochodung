/**
 * `against-lane-dir`, two modes.
 *
 * `oneway` (wrong way): moving at `minSpeedMps` or more in a lane of a one-way road with the
 * heading more than `againstAngleDeg` off the lane's travel heading; or crossing a P.102 entry in
 * its banned heading, which stays active while the ego remains on the road behind it. Firing on
 * the entry crossing itself keeps this rule no later than `no-entry`, which it supersedes.
 *
 * `two-way` (wrong side): in an opposing lane of a two-way road. Lawful overtaking over a dashed
 * line is allowed; the rule fires only when the opposing lane was reached over a line not
 * crossable from that side, when the ego stays there longer than `maxOpposingS`, or when it
 * enters a junction from the opposing lane.
 */

import { angleDiff, projectOntoPolyline } from '../../geometry/index.js';
import { laneById, roadById, signById } from '../../map-query/index.js';
import { DEG, lawfulCross, NUMBER, OPTIONAL_NUMBER } from './common.js';

/**
 * @typedef {object} State
 * @property {{roadId: string | null} | null} p102 Past a P.102 entry in its banned heading: the
 *   road behind it, null until the ego reaches a lane of that road.
 * @property {{since: number, unlawful: boolean} | null} opposing Time in the opposing lane.
 */
/**
 * @typedef {object} Params
 * @property {'oneway' | 'two-way'} mode Mode.
 * @property {number} againstAngleDeg Heading off the lane direction that counts as against it.
 * @property {number} minSpeedMps Lowest speed that counts as travelling.
 * @property {number} [maxOpposingS] Two-way mode: longest lawful stay in the opposing lane.
 */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({
  mode: { type: 'enum', values: ['oneway', 'two-way'] },
  againstAngleDeg: NUMBER,
  minSpeedMps: NUMBER,
  maxOpposingS: OPTIONAL_NUMBER,
});

/** @returns {State} Fresh state. */
export function init() {
  return { p102: null, opposing: null };
}

/**
 * Whether the ego heads against its lane by more than the threshold.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {boolean} Against.
 */
function againstLane(ctx, params) {
  return ctx.laneHeading !== null && Math.abs(angleDiff(ctx.laneHeading, ctx.heading)) > params.againstAngleDeg * DEG;
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
  const road = ctx.loc.roadId ? roadById(map, ctx.loc.roadId) : null;
  const moving = ctx.speed >= params.minSpeedMps;

  if (params.mode === 'oneway') {
    let crossedP102 = false;
    for (const c of ctx.frontCrossings.entries) {
      const sign = signById(map, c.item.signId);
      if (sign?.code === 'P.102' && Math.abs(angleDiff(c.item.heading, ctx.heading)) < Math.PI / 2 && frame.ego.speed > 0) {
        crossedP102 = true;
      }
    }
    /** @type {State['p102']} */
    let p102 = state.p102;
    if (crossedP102) p102 = { roadId: ctx.loc.roadId };
    else if (p102 && ctx.loc.roadId !== null) {
      if (p102.roadId === null) p102 = { roadId: ctx.loc.roadId };
      else if (ctx.loc.roadId !== p102.roadId) p102 = null;
    }
    const onBannedRoad = p102 !== null && moving && (p102.roadId === null || p102.roadId === ctx.loc.roadId);
    const inOneway = road !== null && road.oneway && againstLane(ctx, params) && moving;
    return {
      detectorState: { p102, opposing: null },
      active: crossedP102 || onBannedRoad || inOneway,
      tierInput: {},
    };
  }

  // Two-way mode.
  let unlawfulEntry = false;
  for (const c of ctx.centerCrossings.laneLines) {
    const line = c.item;
    if (!line.left || !line.right) continue;
    const left = laneById(map, line.left);
    const right = laneById(map, line.right);
    if (!left || !right || left.lane.dir === right.lane.dir) continue;
    const intoLaneId = c.fromSide === 'right' ? line.left : line.right;
    const into = intoLaneId === line.left ? left : right;
    const intoHeading = projectOntoPolyline(c.point, into.lane.centerline).heading;
    const intoOpposing = Math.abs(angleDiff(intoHeading, ctx.heading)) > Math.PI / 2;
    if (intoOpposing && !lawfulCross(line, c.fromSide)) unlawfulEntry = true;
  }
  const inOpposing = road !== null && !road.oneway && againstLane(ctx, params);
  /** @type {State['opposing']} */
  let opposing = null;
  if (inOpposing && (state.opposing !== null || moving)) {
    opposing = { since: state.opposing?.since ?? ctx.t, unlawful: (state.opposing?.unlawful ?? false) || unlawfulEntry };
  }
  const intoJunction = ctx.junctionEntered && state.opposing !== null;
  const tooLong = opposing !== null && ctx.t - opposing.since > (params.maxOpposingS ?? Infinity);
  return {
    detectorState: { p102: null, opposing },
    active: intoJunction || (opposing !== null && (opposing.unlawful || tooLong)),
    tierInput: {},
  };
}
