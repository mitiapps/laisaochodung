/**
 * `stop-line-on-red`: the front crosses a signal stop line bound to the ego lane on red, or on a
 * yellow the vehicle could have stopped for. Stopping ability on yellow is judged when the yellow
 * is first seen on the approach: `v² / (2·yellowDecelMps2) ≤ distance` to the line. A vehicle that
 * first sees yellow already on the line may go on. The breach stays active until the ego leaves
 * the junction behind the line (or moves far from it); while it lasts, entering the crosswalk
 * governed by the same signal, or the junction, with the light not green escalates it from stage
 * `line` to stage `entered`. The front counts as in a crosswalk or junction only once it is
 * `entryToleranceM` or more inside along the heading, so a short overshoot past a stop line drawn
 * right before the crosswalk stays at stage `line`.
 */

import { headingVector, pointInPolygon } from '../../geometry/index.js';
import { junctionById, locate, mapIndex, stopLinesForLane } from '../../map-query/index.js';
import { distanceAlong } from './common.js';

/** Distance ahead within which a yellow onset is recorded, metres. */
const APPROACH_M = 150;
/** Distance from the crossing point after which a lingering violation ends, metres. */
const CLEAR_M = 80;

/**
 * @typedef {object} State
 * @property {Record<string, {d: number, v: number}>} yellowSeen Yellow onset per stop line id.
 * @property {{signalId: string, stage: 'line' | 'entered', at: [number, number]} | null} violation
 *   Open violation.
 */
/** @typedef {{yellowDecelMps2: number, entryToleranceM: number}} Params */

/** @returns {State} Fresh state. */
export function init() {
  return { yellowSeen: {}, violation: null };
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
  const lights = frame.trafficLights;
  /** @type {Record<string, {d: number, v: number}>} */
  const yellowSeen = {};
  if (ctx.loc.laneId) {
    for (const line of stopLinesForLane(map, ctx.loc.laneId)) {
      if (line.control !== 'signal' || !line.signalId || lights[line.signalId] !== 'yellow') continue;
      const d = distanceAlong(ctx.front, ctx.heading, line.segment);
      if (d === null || d < 0 || d > APPROACH_M) continue;
      yellowSeen[line.id] = state.yellowSeen[line.id] ?? { d, v: ctx.speed };
    }
  }

  let violation = state.violation;
  const forward = frame.ego.speed > 0 && !ctx.against;
  for (const c of ctx.frontCrossings.stopLines) {
    const line = c.item;
    if (!forward || line.control !== 'signal' || !line.signalId) continue;
    if (ctx.loc.laneId === null || !line.laneIds.includes(ctx.loc.laneId)) continue;
    const light = lights[line.signalId];
    let breach = light === 'red';
    if (light === 'yellow') {
      const seen = state.yellowSeen[line.id];
      breach = seen !== undefined && (seen.v * seen.v) / (2 * params.yellowDecelMps2) <= seen.d;
    }
    if (breach && !violation) violation = { signalId: line.signalId, stage: 'line', at: c.point };
  }

  if (!violation) return { detectorState: { yellowSeen, violation: null }, active: false, tierInput: {} };

  if (violation.stage === 'line' && lights[violation.signalId] !== 'green') {
    const signalId = violation.signalId;
    const [fx, fz] = headingVector(ctx.heading);
    /** @type {[number, number]} Point entryToleranceM behind the front. */
    const back = [ctx.front[0] - fx * params.entryToleranceM, ctx.front[1] - fz * params.entryToleranceM];
    /**
     * @param {[number, number][]} polygon Ring.
     * @returns {boolean} The front and the point entryToleranceM behind it are both inside.
     */
    const deepIn = (polygon) => pointInPolygon(ctx.front, polygon) && pointInPolygon(back, polygon);
    const inCrosswalk = mapIndex(map)
      .crosswalks.near(ctx.front)
      .some((cw) => cw.signalId === signalId && deepIn(cw.polygon));
    const junctionId = locate(map, ctx.front, ctx.heading).junctionId;
    const junction = junctionId === null ? null : junctionById(map, junctionId);
    const inJunction = junction !== null && deepIn(junction.polygon);
    if (inCrosswalk || inJunction) violation = { ...violation, stage: 'entered' };
  }
  const tierInput = { stage: violation.stage };
  const far = Math.hypot(ctx.pos[0] - violation.at[0], ctx.pos[1] - violation.at[1]) > CLEAR_M;
  const done = ctx.junctionExit !== null || far;
  return { detectorState: { yellowSeen, violation: done ? null : violation }, active: true, tierInput };
}
