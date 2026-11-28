/**
 * `junction-turn`: evaluated when the ego leaves a junction. The manoeuvre comes from the change
 * between the entry and exit travel headings: at least `uturnMinDeg` is a U-turn, at least
 * `turnMinDeg` a left (positive) or right (negative) turn, anything less is straight on.
 *
 * Mode `signal`: a turn without the indicator toward it (left for a U-turn) held from
 * `signalFromM` before the junction entry (or from the run start, if nearer) to the exit.
 * Mode `restriction`: a manoeuvre a map restriction bans from the approach lane.
 * Both modes fire on the exit step, so `banned-turn` and `turn-signal` coincide for supersession.
 */

import { angleDiff } from '../../geometry/index.js';
import { DEG, NUMBER, OPTIONAL_NUMBER } from './common.js';

/** @typedef {Record<string, never>} State */
/**
 * @typedef {object} Params
 * @property {'signal' | 'restriction'} mode Mode.
 * @property {number} turnMinDeg Smallest heading change that is a turn.
 * @property {number} uturnMinDeg Smallest heading change that is a U-turn.
 * @property {number} [signalFromM] Signal mode: distance before the junction from which the
 *   indicator must be on.
 */

/** @type {import('./common.js').ParamSpecs} Parameters the rule's `detection.params` must give. */
export const paramSpec = Object.freeze({
  mode: { type: 'enum', values: ['signal', 'restriction'] },
  turnMinDeg: NUMBER,
  uturnMinDeg: NUMBER,
  signalFromM: OPTIONAL_NUMBER,
});

/** @returns {State} Fresh state. */
export function init() {
  return {};
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
  const pass = ctx.junctionExit;
  if (!pass) return { detectorState: state, active: false, tierInput: {} };
  const manoeuvre = manoeuvreOf(pass, params);
  if (manoeuvre === 'straight') return { detectorState: state, active: false, tierInput: { manoeuvre } };

  if (params.mode === 'restriction') {
    const banned = ctx.env.map.restrictions.some(
      (r) =>
        r.junctionId === pass.id &&
        pass.entryLaneId !== null &&
        r.fromLaneIds.includes(pass.entryLaneId) &&
        r.banned.includes(manoeuvre),
    );
    return { detectorState: state, active: banned, tierInput: { manoeuvre } };
  }

  const required = manoeuvre === 'uturn' ? 'left' : manoeuvre;
  const fromOdo = Math.max(ctx.startOdo, pass.entryOdo - (params.signalFromM ?? 0));
  const held = ctx.indicator.state === required && ctx.indicator.sinceOdo <= fromOdo + 1e-6;
  return { detectorState: state, active: !held, tierInput: { manoeuvre } };
}
