/**
 * `stopped-in-zone`: speed below `stoppedSpeedMps` for `minStopS` in a forbidden place, by
 * precedence: in a junction (body centre), within `junctionBufferM` of one (footprint; only for
 * the decree groups in `bufferDecreeGroups`), on a crosswalk (footprint), or in a `no-stopping`
 * zone bound to the ego lane (centre).
 *
 * Exempt (the stop timer restarts): a red or yellow light on a signal stop line of the ego lane
 * ahead within `lineAheadM` (or overshot by up to one body length); a STOP or give-way line
 * likewise; a junction ahead within `lineAheadM` where the ego must give way; an active
 * pedestrian on a crosswalk ahead within `lineAheadM` (anywhere across it); an active actor
 * ahead in the ego's path within `actorAheadM` (bumper gap) and `corridorHalfWidthM` plus the
 * actor's half width; and, inside a junction, any moving actor within `yieldRadiusM` (waiting to
 * turn across traffic or for a pedestrian).
 */

import { distance, pointInPolygon, polygonCentroid } from '../../geometry/index.js';
import { crosswalksNear, crosswalksOverlapping, junctionsNear, stopLinesForLane } from '../../map-query/index.js';
import { actorsAround, distanceAlong, egoFrame, heldFor, holdSince } from './common.js';
import { givesWayAt } from './stop-line-common.js';

/** @typedef {{since: number | null}} State */
/**
 * @typedef {object} Params
 * @property {number} stoppedSpeedMps Below this the ego counts as stopped.
 * @property {number} minStopS Stop duration that is a breach.
 * @property {number} junctionBufferM Range from the junction edge.
 * @property {('D6' | 'D7')[]} bufferDecreeGroups Groups the buffer applies to.
 * @property {number} actorAheadM Gap to an actor ahead that exempts the stop.
 * @property {number} corridorHalfWidthM Half width of the ego's path for that test.
 * @property {number} lineAheadM Distance to a line or junction ahead that exempts the stop.
 * @property {number} yieldRadiusM In a junction, a moving actor this close exempts the stop.
 */

/** @returns {State} Fresh state. */
export function init() {
  return { since: null };
}

/**
 * Forbidden place under the ego, or null.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {'junction' | 'buffer' | 'crosswalk' | 'no-stopping' | null} Place.
 */
function placeOf(ctx, params) {
  const { map, group } = ctx.env;
  const fp = ctx.frame.ego.footprint;
  if (ctx.loc.junctionId) return 'junction';
  if (params.bufferDecreeGroups.includes(group) && junctionsNear(map, fp, params.junctionBufferM).length > 0) return 'buffer';
  if (crosswalksOverlapping(map, fp).length > 0) return 'crosswalk';
  if (ctx.loc.laneId && ctx.zones.some((z) => z.type === 'no-stopping')) return 'no-stopping';
  return null;
}

/**
 * Whether a lawful reason explains the stop.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {boolean} Exempt.
 */
function exempt(frame, ctx, params) {
  const { map, vehicle } = ctx.env;
  const laneId = ctx.loc.laneId;
  if (laneId) {
    for (const line of stopLinesForLane(map, laneId)) {
      const d = distanceAlong(ctx.front, ctx.heading, line.segment);
      if (d === null || d > params.lineAheadM || d < -vehicle.lengthM) continue;
      if (line.control !== 'signal') return true;
      const light = line.signalId ? frame.trafficLights[line.signalId] : undefined;
      if (light === 'red' || light === 'yellow') return true;
    }
  }
  if (!ctx.loc.junctionId) {
    const ahead = junctionsNear(map, [ctx.front], params.lineAheadM);
    if (ahead.some((j) => givesWayAt(map, j.id, ctx.loc.roadId))) return true;
  }
  const walking = frame.actors.filter((a) => a.kind === 'pedestrian' && a.active);
  if (walking.length > 0) {
    for (const cw of crosswalksNear(map, ctx.front, params.lineAheadM)) {
      if (egoFrame(ctx.front, ctx.heading, polygonCentroid(cw.polygon)).along <= 0) continue;
      if (walking.some((a) => pointInPolygon([a.pos.x, a.pos.z], cw.polygon))) return true;
    }
  }
  for (const a of actorsAround(frame, ctx, null)) {
    const gap = a.along - (vehicle.lengthM + a.info.lengthM) / 2;
    if (a.along > 0 && gap <= params.actorAheadM && Math.abs(a.lateral) <= params.corridorHalfWidthM + a.info.widthM / 2) {
      return true;
    }
    if (ctx.loc.junctionId && a.pose.speed > 0 && distance(ctx.pos, [a.pose.pos.x, a.pose.pos.z]) <= params.yieldRadiusM) {
      return true;
    }
  }
  return false;
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const stopped = ctx.speed < params.stoppedSpeedMps;
  const place = stopped ? placeOf(ctx, params) : null;
  const cond = place !== null && !exempt(frame, ctx, params);
  const since = holdSince(state.since, cond, ctx.t);
  return {
    detectorState: { since },
    active: cond && heldFor(since, ctx.t, params.minStopS),
    tierInput: { place },
  };
}
