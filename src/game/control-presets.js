/**
 * Control presets: what `simple` (Đơn giản) and `real` (Thực tế) turn on in the sim and the input.
 * The sim assists' thresholds are read from the `turn-signal` rule in the rules bundle, so the
 * auto-cancel waits for the same turn angle and distance the scorer judges the indicator by.
 */

import { CONTROL_PRESETS } from '../contracts/controls.js';

/** @typedef {import('../contracts/controls.js').ControlPreset} ControlPreset */
/** @typedef {import('../contracts/controls.js').ControlAssists} ControlAssists */
/** @typedef {import('../contracts/rule.js').RulesBundle} RulesBundle */
/** @typedef {import('../physics/tuning.js').VehicleTuning} VehicleTuning */

/** Preset used when none or an unknown one is given. */
export const DEFAULT_CONTROL_PRESET = /** @type {ControlPreset} */ ('simple');

/** Rule whose parameters set the indicator auto-cancel. */
const TURN_SIGNAL_RULE = 'turn-signal';

/**
 * @typedef {object} ResolvedPreset
 * @property {ControlPreset} preset The preset applied (unknown values fall back to `simple`).
 * @property {ControlAssists} simAssists Assists for `createSim`'s `options.assists`.
 * @property {{combinedRearPerGrip: number}} inputOptions Options for `createInput`.
 */

/**
 * Normalises a preset value: anything other than a known preset is `simple`.
 * @param {unknown} preset Value.
 * @returns {ControlPreset} Preset.
 */
export function normalizeControlPreset(preset) {
  return CONTROL_PRESETS.includes(/** @type {ControlPreset} */ (preset)) ? /** @type {ControlPreset} */ (preset) : DEFAULT_CONTROL_PRESET;
}

/**
 * Reads the auto-cancel thresholds from the turn-signal rule.
 * @param {RulesBundle} bundle Rules bundle.
 * @returns {{turnMinDeg: number, clearM: number}} Thresholds.
 */
function signalCancelOf(bundle) {
  const rule = bundle.rules.find((r) => r.id === TURN_SIGNAL_RULE);
  if (!rule) throw new Error(`The rules bundle has no "${TURN_SIGNAL_RULE}" rule; the indicator auto-cancel needs its thresholds`);
  const { turnMinDeg, signalFromM } = rule.detection.params;
  if (typeof turnMinDeg !== 'number' || typeof signalFromM !== 'number') {
    throw new Error(`The "${TURN_SIGNAL_RULE}" rule lacks numeric turnMinDeg and signalFromM params`);
  }
  return { turnMinDeg, clearM: signalFromM };
}

/**
 * Resolves a preset into sim assists and input options.
 * @param {unknown} preset Preset; unknown values fall back to `simple`.
 * @param {RulesBundle} bundle Rules bundle.
 * @param {VehicleTuning} tuning Physics tuning of the run's vehicle.
 * @returns {ResolvedPreset} Resolved preset.
 */
export function resolveControlPreset(preset, bundle, tuning) {
  const p = normalizeControlPreset(preset);
  if (p === 'real') {
    return { preset: p, simAssists: { autoGearbox: false, signalAutoCancel: null }, inputOptions: { combinedRearPerGrip: 0 } };
  }
  return {
    preset: p,
    simAssists: { autoGearbox: true, signalAutoCancel: signalCancelOf(bundle) },
    inputOptions: { combinedRearPerGrip: tuning.brakes.combinedRearPerGrip ?? 0 },
  };
}
