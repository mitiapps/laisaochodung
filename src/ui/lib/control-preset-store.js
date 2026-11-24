/**
 * The player's control preset, kept in `localStorage`. Reading never throws: a missing, invalid
 * or unreadable value is `simple`. Nothing here touches storage at import time.
 */

import { CONTROL_PRESETS } from '../../contracts/controls.js';

/** @typedef {import('../../contracts/controls.js').ControlPreset} ControlPreset */
/** @typedef {Pick<Storage, 'getItem' | 'setItem'>} PresetStorage */

/** `localStorage` key of the preset. */
export const CONTROL_PRESET_STORAGE_KEY = 'laisaochodung.controlPreset';
/** Preset of a new player. */
export const DEFAULT_PRESET = /** @type {ControlPreset} */ ('simple');

/**
 * The browser's `localStorage`, or null where reading it throws (blocked storage) or it is absent.
 * @returns {PresetStorage | null} Storage.
 */
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the stored preset.
 * @param {PresetStorage | null} [storage] Storage; the browser's by default.
 * @returns {ControlPreset} Stored preset, or `simple`.
 */
export function readControlPreset(storage = browserStorage()) {
  if (!storage) return DEFAULT_PRESET;
  try {
    const value = storage.getItem(CONTROL_PRESET_STORAGE_KEY);
    return CONTROL_PRESETS.includes(/** @type {ControlPreset} */ (value)) ? /** @type {ControlPreset} */ (value) : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

/**
 * Stores a preset.
 * @param {ControlPreset} preset Preset.
 * @param {PresetStorage | null} [storage] Storage; the browser's by default.
 * @returns {boolean} Whether it was stored (false where storage is blocked or full).
 */
export function writeControlPreset(preset, storage = browserStorage()) {
  if (!CONTROL_PRESETS.includes(preset)) throw new RangeError(`Unknown control preset "${String(preset)}"`);
  if (!storage) return false;
  try {
    storage.setItem(CONTROL_PRESET_STORAGE_KEY, preset);
    return true;
  } catch {
    return false;
  }
}
