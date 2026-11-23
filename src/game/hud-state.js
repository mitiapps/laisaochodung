/**
 * Builds the `HudState` the UI reads from the latest frame and scorer output.
 */

import { mpsToKmh } from '../contracts/units.js';

/** @typedef {import('../contracts/hud.js').HudState} HudState */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/score.js').ScoreContext} ScoreContext */
/** @typedef {import('../contracts/score.js').Breach} Breach */
/** @typedef {import('../contracts/score.js').ScoreReport} ScoreReport */

/** Most recent breaches resent with every HUD state; the toast stack drops ones already shown. */
export const HUD_TOAST_WINDOW = 8;

/**
 * @param {object} args Inputs.
 * @param {Frame} args.frame Latest frame.
 * @param {ScoreContext} args.context Latest scorer context.
 * @param {number} args.score Running score.
 * @param {Breach[]} args.breaches Breaches of the run so far, oldest first.
 * @param {HudState['runStatus']} args.runStatus Run status.
 * @param {ScoreReport} [args.report] Final report, once finished.
 * @returns {HudState} HUD state.
 */
export function hudStateOf({ frame, context, score, breaches, runStatus, report }) {
  const { ego } = frame;
  /** @type {HudState} */
  const state = {
    speedKmh: mpsToKmh(Math.abs(ego.speed)),
    speedLimitKmh: context.speedLimitKmh,
    speedLimitVerified: context.speedLimitVerified,
    gear: ego.gear,
    rpm: ego.rpm,
    indicators: ego.indicators,
    lights: ego.lights,
    horn: ego.horn,
    skid: ego.wheels.some((w) => w.skid > 0),
    controls: {
      throttle: ego.input.throttle,
      brakeFront: ego.input.brakeFront,
      brakeRear: ego.input.brakeRear,
      steer: ego.input.steer,
      handbrake: ego.input.handbrake,
    },
    score,
    headingRad: ego.heading,
    nav: { distanceM: frame.route.distanceM, bearingRad: frame.route.bearingRad },
    toasts: breaches.slice(-HUD_TOAST_WINDOW),
    runStatus,
  };
  if (report) state.report = report;
  return state;
}
