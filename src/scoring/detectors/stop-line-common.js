/**
 * Shared tests for the stop-line detectors.
 */

import { junctionById, roadById } from '../../map-query/index.js';

/**
 * Whether the front crossed, moving forward, a stop line of `control` bound to the ego lane.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {'stop-sign' | 'give-way'} control Control.
 * @returns {boolean} Crossed this step.
 */
export function stopLineCrossed(frame, ctx, control) {
  if (frame.ego.speed <= 0 || ctx.against || ctx.loc.laneId === null) return false;
  const laneId = ctx.loc.laneId;
  return ctx.frontCrossings.stopLines.some((c) => c.item.control === control && c.item.laneIds.includes(laneId));
}

/**
 * Junction the ego must give way at, given the road it comes from: unsignalised, with priority
 * roads, and the ego's road not among them.
 * @param {import('../../contracts/index.js').GameMap} map Map.
 * @param {string} junctionId Junction id.
 * @param {string | null} fromRoadId Road of the approach.
 * @returns {boolean} Give way required.
 */
export function givesWayAt(map, junctionId, fromRoadId) {
  const j = junctionById(map, junctionId);
  if (!j || j.signalized || j.priorityRoadIds.length === 0 || fromRoadId === null) return false;
  return roadById(map, fromRoadId) !== null && !j.priorityRoadIds.includes(fromRoadId);
}
