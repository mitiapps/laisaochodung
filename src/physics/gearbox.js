/**
 * Gearboxes as pure functions. The car is a clutchless manual (N, R, 1–5): the clutch is
 * implied, so a stationary car in gear idles instead of stalling. The scooter is an automatic
 * (N, D). Engine speed is estimated from the driven wheels' spin.
 *
 * With the auto-shift assist the manual car shows a selector R, N, D instead of its gears: in D
 * the vehicle keeps an engaged ratio (1–5) of its own and `autoShiftRatio` moves it by rpm, so
 * drive force and rpm still come from the manual path.
 */

import { mpsToKmh } from '../contracts/units.js';

/** @typedef {import('../contracts/telemetry.js').Gear} Gear */
/** @typedef {import('./tuning.js').GearboxSpec} GearboxSpec */
/** @typedef {import('./tuning.js').ManualGearboxSpec} ManualGearboxSpec */

const RAD_PER_S_TO_RPM = 60 / (2 * Math.PI);

/** Manual gear order from reverse to top gear. */
const MANUAL_ORDER = /** @type {readonly Gear[]} */ (Object.freeze(['R', 'N', 1, 2, 3, 4, 5]));

/** Automatic gear order. */
const AUTO_ORDER = /** @type {readonly Gear[]} */ (Object.freeze(['N', 'D']));

/** Selector order of a manual gearbox with the auto-shift assist. */
const SELECTOR_ORDER = /** @type {readonly Gear[]} */ (Object.freeze(['R', 'N', 'D']));

/**
 * Below this speed (m/s) the auto-shift engages ratio 1 at once, so a car always moves off in 1.
 */
export const AUTO_SHIFT_STANDSTILL_MPS = 0.5;

/**
 * @typedef {object} ShiftMode
 * @property {boolean} [autoShift] Manual gearbox driven through the R, N, D selector. Ignored by
 *   an automatic gearbox.
 */

/**
 * Whether a gearbox runs as the auto-shift selector.
 * @param {GearboxSpec} spec Gearbox.
 * @param {ShiftMode} mode Mode.
 * @returns {boolean} Selector mode.
 */
function selectorMode(spec, mode) {
  return spec.kind === 'manual' && mode.autoShift === true;
}

/**
 * Gear at the start of a run: N for a manual, D for an automatic or the auto-shift selector.
 * @param {GearboxSpec} spec Gearbox.
 * @param {ShiftMode} [mode] Mode; default the plain gearbox.
 * @returns {Gear} Gear.
 */
export function initialGear(spec, mode = {}) {
  return spec.kind === 'manual' && !selectorMode(spec, mode) ? 'N' : 'D';
}

/**
 * Applies a shift request. A manual, selector included, refuses R at or above
 * `maxReverseShiftKmh`.
 * @param {GearboxSpec} spec Gearbox.
 * @param {Gear} gear Current gear.
 * @param {'up' | 'down' | null} cmd Shift request.
 * @param {number} speedMps Signed forward speed.
 * @param {ShiftMode} [mode] Mode; default the plain gearbox.
 * @returns {Gear} New gear.
 */
export function shiftGear(spec, gear, cmd, speedMps, mode = {}) {
  if (cmd === null) return gear;
  let order = AUTO_ORDER;
  if (spec.kind === 'manual') order = selectorMode(spec, mode) ? SELECTOR_ORDER : MANUAL_ORDER;
  const i = order.indexOf(gear);
  if (i < 0) throw new RangeError(`Gear ${String(gear)} does not exist on a ${spec.kind} gearbox`);
  const j = Math.max(0, Math.min(order.length - 1, i + (cmd === 'up' ? 1 : -1)));
  const next = order[j];
  if (spec.kind === 'manual' && next === 'R' && Math.abs(mpsToKmh(speedMps)) >= spec.maxReverseShiftKmh) {
    return gear;
  }
  return next;
}

/**
 * Engine speed of a manual gear at a driven-wheel spin.
 * @param {ManualGearboxSpec} spec Gearbox.
 * @param {number} ratio Gear 1–5.
 * @param {number} wheelSpin Mean driven-wheel spin in rad/s.
 * @returns {number} rpm.
 */
function ratioRpm(spec, ratio, wheelSpin) {
  return Math.abs(wheelSpin * spec.ratios[ratio - 1] * spec.finalDrive) * RAD_PER_S_TO_RPM;
}

/**
 * The engaged ratio of the auto-shift selector in D after one step. Near standstill it is 1 at
 * once. Otherwise it shifts up one gear at `upRpm` while the throttle is open, and down when the
 * rpm falls to `downRpm`, to the highest lower gear that turns above `downRpm` (or 1); a down-shift
 * so chosen lands below `upRpm`, so the box cannot hunt. No shift within `minIntervalS` of the
 * last one.
 * @param {ManualGearboxSpec} spec Gearbox.
 * @param {number} ratio Engaged gear 1–5.
 * @param {{throttle: number, speedMps: number, wheelSpin: number, sinceShiftS: number}} state
 *   Throttle 0..1, signed forward speed, mean driven-wheel spin in rad/s and the time since the
 *   last shift.
 * @returns {number} Engaged gear 1–5.
 */
export function autoShiftRatio(spec, ratio, state) {
  const top = spec.ratios.length;
  if (!Number.isInteger(ratio) || ratio < 1 || ratio > top) {
    throw new RangeError(`Engaged ratio ${String(ratio)} does not exist on a ${top}-speed gearbox`);
  }
  const { upRpm, downRpm, minIntervalS } = spec.autoShift;
  if (Math.abs(state.speedMps) < AUTO_SHIFT_STANDSTILL_MPS) return 1;
  if (state.sinceShiftS < minIntervalS) return ratio;
  const rpm = ratioRpm(spec, ratio, state.wheelSpin);
  if (ratio < top && state.throttle > 0 && rpm >= upRpm) return ratio + 1;
  if (ratio > 1 && rpm <= downRpm) {
    for (let g = ratio - 1; g > 1; g -= 1) {
      if (ratioRpm(spec, g, state.wheelSpin) > downRpm) return g;
    }
    return 1;
  }
  return ratio;
}

/**
 * Overall ratio (gear times final drive) of a manual gear, signed: negative in reverse, 0 in N.
 * @param {ManualGearboxSpec} spec Gearbox.
 * @param {Gear} gear Gear.
 * @returns {number} Ratio.
 */
function manualRatio(spec, gear) {
  if (gear === 'R') return -spec.reverseRatio * spec.finalDrive;
  if (typeof gear === 'number') return spec.ratios[gear - 1] * spec.finalDrive;
  return 0;
}

/**
 * Drive force at the driven wheels and the engine speed.
 * @param {GearboxSpec} spec Gearbox.
 * @param {Gear} gear Selected gear.
 * @param {number} throttle 0..1.
 * @param {number} speedMps Signed forward speed.
 * @param {number} wheelSpin Mean driven-wheel spin in rad/s, signed forward.
 * @param {number} wheelRadius Wheel radius in metres.
 * @returns {{forceN: number, rpm: number}} Total drive force along +X (negative in reverse) and rpm.
 */
export function driveForce(spec, gear, throttle, speedMps, wheelSpin, wheelRadius) {
  const t = Math.max(0, Math.min(1, throttle));
  if (spec.kind === 'auto') {
    const span = spec.redlineRpm - spec.idleRpm;
    if (gear !== 'D') return { forceN: 0, rpm: spec.idleRpm + t * span * 0.6 };
    const fade = Math.max(0, 1 - Math.max(0, speedMps) / spec.topSpeedMps);
    const load = Math.min(1, 0.35 * t + 0.65 * Math.max(0, speedMps) / spec.topSpeedMps);
    return { forceN: t * spec.maxForceN * fade, rpm: spec.idleRpm + load * span };
  }
  const ratio = manualRatio(spec, gear);
  if (ratio === 0) {
    return { forceN: 0, rpm: spec.idleRpm + t * (spec.redlineRpm - spec.idleRpm) * 0.8 };
  }
  const engineRpm = Math.abs(wheelSpin * ratio) * RAD_PER_S_TO_RPM;
  const rpm = Math.max(spec.idleRpm, engineRpm);
  if (engineRpm >= spec.redlineRpm) return { forceN: 0, rpm: spec.redlineRpm };
  const forceN = (t * spec.peakTorqueNm * ratio * spec.efficiency) / wheelRadius;
  return { forceN, rpm };
}
