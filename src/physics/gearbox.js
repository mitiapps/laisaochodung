/**
 * Gearboxes as pure functions. The car is a clutchless manual (N, R, 1–5): the clutch is
 * implied, so a stationary car in gear idles instead of stalling. The scooter is an automatic
 * (N, D). Engine speed is estimated from the driven wheels' spin.
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

/**
 * Gear at the start of a run: N for a manual, D for an automatic.
 * @param {GearboxSpec} spec Gearbox.
 * @returns {Gear} Gear.
 */
export function initialGear(spec) {
  return spec.kind === 'manual' ? 'N' : 'D';
}

/**
 * Applies a shift request. A manual refuses R at or above `maxReverseShiftKmh`.
 * @param {GearboxSpec} spec Gearbox.
 * @param {Gear} gear Current gear.
 * @param {'up' | 'down' | null} cmd Shift request.
 * @param {number} speedMps Signed forward speed.
 * @returns {Gear} New gear.
 */
export function shiftGear(spec, gear, cmd, speedMps) {
  if (cmd === null) return gear;
  const order = spec.kind === 'manual' ? MANUAL_ORDER : AUTO_ORDER;
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
