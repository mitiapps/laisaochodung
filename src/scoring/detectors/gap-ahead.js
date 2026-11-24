/**
 * `gap-ahead`: above `minSpeedMps`, the time gap (bumper gap / speed) to the leader stays under
 * `minTimeGapS` for `sustainS`. Below the speed a queue at a light never counts.
 *
 * The leader is the nearest active vehicle (car or motorbike, a wreck included) ahead in the
 * ego's lane, skipping one with a latched `unsafe-lane-change`: a vehicle that just cut in closes
 * the gap through no fault of the player. A new leader restarts the sustain timer, so motorbikes
 * filtering in and out ahead do not add up to one sustained tailgate. Vehicles beyond the time gap
 * are never leaders: they cannot breach, and skipping them saves the lane test.
 */

import { locate } from '../../map-query/index.js';
import { actorsAround, heldFor, holdSince, VEHICLE_KINDS } from './common.js';

/** @typedef {{since: number | null, leaderId?: string | null}} State */
/** @typedef {{minSpeedMps: number, minTimeGapS: number, sustainS: number}} Params */

/** Half width of the strip ahead searched before the lane test, in metres (wider than any lane). */
const CORRIDOR_HALF_M = 6;

/** @returns {State} Fresh state. */
export function init() {
  return { since: null, leaderId: null };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const laneId = ctx.loc.laneId;
  /** @type {import('../context.js').NearActor | null} */
  let leader = null;
  if (ctx.speed > params.minSpeedMps && laneId) {
    for (const a of actorsAround(ctx, VEHICLE_KINDS)) {
      if (a.along <= 0 || Math.abs(a.lateral) > CORRIDOR_HALF_M) continue;
      if (leader && a.along >= leader.along) continue;
      // A vehicle beyond the time gap cannot make the condition true, so it never needs a lane test.
      if (a.along - (ctx.env.vehicle.lengthM + a.lengthM) / 2 >= params.minTimeGapS * ctx.speed) continue;
      if ((a.pose.violations ?? []).includes('unsafe-lane-change')) continue;
      if (locate(ctx.env.map, a.pose.pos, a.pose.heading).laneId !== laneId) continue;
      leader = a;
    }
  }
  const leaderId = leader ? leader.pose.id : null;
  let cond = false;
  if (leader) {
    const gap = leader.along - (ctx.env.vehicle.lengthM + leader.lengthM) / 2;
    cond = gap / ctx.speed < params.minTimeGapS;
  }
  const prevSince = leaderId === (state.leaderId ?? null) ? state.since : null;
  const since = holdSince(prevSince, cond, ctx.t);
  return { detectorState: { since, leaderId }, active: cond && heldFor(since, ctx.t, params.sustainS), tierInput: {} };
}
