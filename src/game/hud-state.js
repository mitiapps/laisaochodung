/**
 * Builds the `HudState` the UI reads from the latest frame and scorer output.
 */

import { mpsToKmh } from '../contracts/units.js';

/** @typedef {import('../contracts/hud.js').HudState} HudState */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/score.js').ScoreContext} ScoreContext */
/** @typedef {import('../contracts/score.js').Breach} Breach */
/** @typedef {import('../contracts/score.js').ScoreReport} ScoreReport */
/** @typedef {import('../contracts/score.js').Notice} Notice */

/** Most recent breaches resent with every HUD state; the toast stack drops ones already shown. */
export const HUD_TOAST_WINDOW = 8;
/**
 * A notice stays in the HUD state this long after its contact, in seconds of run time. Shorter
 * than a breach toast (which carries the legal text), since a notice only says who was at fault
 * and a wreck clears from the road soon after.
 */
export const HUD_NOTICE_S = 4;
/** Most notices sent at once. */
export const HUD_NOTICE_MAX = 3;

/**
 * Notices to show at run time `t`: those raised within the last `HUD_NOTICE_S`, newest last. Run
 * time, not the breach list, decides when one goes, so later breaches never clear it early.
 * @param {readonly Notice[]} notices Notices of the run so far, oldest first.
 * @param {number} t Run time of the latest frame.
 * @returns {Notice[]} Notices to show.
 */
export function visibleNotices(notices, t) {
  /** @type {Notice[]} */
  const shown = [];
  for (let i = notices.length - 1; i >= 0 && shown.length < HUD_NOTICE_MAX; i -= 1) {
    const age = t - notices[i].t;
    if (age < 0) continue;
    if (age >= HUD_NOTICE_S) break;
    shown.push(notices[i]);
  }
  return shown.reverse();
}

/**
 * @param {object} args Inputs.
 * @param {Frame} args.frame Latest frame.
 * @param {ScoreContext} args.context Latest scorer context.
 * @param {number} args.score Running score.
 * @param {Breach[]} args.breaches Breaches of the run so far, oldest first.
 * @param {readonly Notice[]} [args.notices] Notices of the run so far, oldest first.
 * @param {import('../contracts/controls.js').ControlPreset} args.controlPreset Control preset the
 *   session applied to the run.
 * @param {HudState['runStatus']} args.runStatus Run status.
 * @param {ScoreReport} [args.report] Final report, once finished.
 * @returns {HudState} HUD state.
 */
export function hudStateOf({ frame, context, score, breaches, notices = [], controlPreset, runStatus, report }) {
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
    notices: visibleNotices(notices, frame.t),
    controlPreset,
    runStatus,
  };
  if (report) state.report = report;
  return state;
}
