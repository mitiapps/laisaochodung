/**
 * `junction-turn`: evaluated when the ego leaves a junction. The manoeuvre comes from the change
 * between the entry and exit travel headings: at least `uturnMinDeg` is a U-turn, at least
 * `turnMinDeg` a left (positive) or right (negative) turn, anything less is straight on.
 *
 * Mode `signal`: a turn without the indicator toward it (left for a U-turn) held from
 * `signalFromM` before the junction entry (or from the run start, if nearer) to the exit.
 * Mode `restriction`: a manoeuvre a map restriction bans from the approach lane.
 * Both modes fire on the exit step, so `banned-turn` and `turn-signal` coincide for supersession.
 *
 * An exit made while backing slowly (a signed speed below 0 and no faster than `backExemptMaxMps`
 * backwards; the scooter's push-back or a car's slow R gear) is no manoeuvre of its own: backing
 * out on full lock swings the heading without a turn.
 * - Backing out by the road the ego entered on drops the pass: it left the way it came.
 * - Backing out into any other arm keeps the entry: the next exit of the same junction, re-entered
 *   from the arm the ego backed into, is judged from the kept entry. Entering south-bound, facing
 *   east, backing into the west arm and then driving east across is a left turn, not a straight
 *   pass. An exit of another junction, or a re-entry from another road, drops the kept entry and
 *   is judged on its own.
 * A faster reverse exit is judged as a forward one.
 */

import { angleDiff } from '../../geometry/index.js';
import { laneById } from '../../map-query/index.js';
import { DEG, NUMBER, OPTIONAL_NUMBER, slowBacking } from './common.js';

/** @typedef {import('../context.js').JunctionPass} JunctionPass */
/**
 * @typedef {object} State
 * @property {{pass: JunctionPass, intoRoadId: string | null} | null} kept Entry kept after a slow
 *   backward exit into another arm, with the road it backed into (null: off every lane).
 */
/**
 * @typedef {object} Params
 * @property {'signal' | 'restriction'} mode Mode.
 * @property {number} turnMinDeg Smallest heading change that is a turn.
 * @property {number} uturnMinDeg Smallest heading change that is a U-turn.
 * @property {number} [signalFromM] Signal mode: distance before the junction from which the
 *   indicator must be on.
 * @property {number} backExemptMaxMps Fastest backward speed of the slow-backing band.
 */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({
  mode: { type: 'enum', values: ['signal', 'restriction'] },
  turnMinDeg: NUMBER,
  uturnMinDeg: NUMBER,
  signalFromM: OPTIONAL_NUMBER,
  backExemptMaxMps: NUMBER,
});

/** @returns {State} Fresh state. */
export function init() {
  return { kept: null };
}

/**
 * Manoeuvre of a completed junction pass.
 * @param {import('../context.js').JunctionPass} pass Pass with exit heading.
 * @param {{turnMinDeg: number, uturnMinDeg: number}} params Thresholds.
 * @returns {'left' | 'right' | 'uturn' | 'straight'} Manoeuvre.
 */
export function manoeuvreOf(pass, params) {
  const turn = angleDiff(pass.entryHeading, pass.exitHeading ?? pass.entryHeading);
  if (Math.abs(turn) >= params.uturnMinDeg * DEG - 1e-9) return 'uturn';
  if (turn >= params.turnMinDeg * DEG) return 'left';
  if (turn <= -params.turnMinDeg * DEG) return 'right';
  return 'straight';
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @param {Params} params Params.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx, params) {
  const exit = ctx.junctionExit;
  if (!exit) return { detectorState: state, active: false, tierInput: {} };
  const { kept } = state;
  const resumes = kept !== null && kept.pass.id === exit.id && (kept.intoRoadId === null || kept.intoRoadId === exit.entryRoadId);
  /** @type {JunctionPass} */
  const pass = resumes
    ? {
        ...exit,
        entryLaneId: kept.pass.entryLaneId,
        entryRoadId: kept.pass.entryRoadId,
        entryHeading: kept.pass.entryHeading,
        entryOdo: kept.pass.entryOdo,
        entryT: kept.pass.entryT,
      }
    : exit;
  if (slowBacking(frame.ego.speed, params.backExemptMaxMps)) {
    const exitLane = exit.exitLaneId ? laneById(ctx.env.map, exit.exitLaneId) : null;
    const intoRoadId = exitLane ? exitLane.road.id : null;
    const sameRoad = intoRoadId !== null && intoRoadId === pass.entryRoadId;
    /** @type {State} */
    const next = { kept: sameRoad ? null : { pass, intoRoadId } };
    return { detectorState: next, active: false, tierInput: {} };
  }
  /** @type {State} */
  const cleared = { kept: null };
  const manoeuvre = manoeuvreOf(pass, params);
  if (manoeuvre === 'straight') return { detectorState: cleared, active: false, tierInput: { manoeuvre } };

  if (params.mode === 'restriction') {
    const banned = ctx.env.map.restrictions.some(
      (r) =>
        r.junctionId === pass.id &&
        pass.entryLaneId !== null &&
        r.fromLaneIds.includes(pass.entryLaneId) &&
        r.banned.includes(manoeuvre),
    );
    return { detectorState: cleared, active: banned, tierInput: { manoeuvre } };
  }

  const required = manoeuvre === 'uturn' ? 'left' : manoeuvre;
  const fromOdo = Math.max(ctx.startOdo, pass.entryOdo - (params.signalFromM ?? 0));
  const held = ctx.indicator.state === required && ctx.indicator.sinceOdo <= fromOdo + 1e-6;
  return { detectorState: cleared, active: !held, tierInput: { manoeuvre } };
}
