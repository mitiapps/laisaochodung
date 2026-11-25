/**
 * The player's camera mode, kept in `localStorage`. Reading never throws: a missing, invalid or
 * unreadable value is `chase`. Nothing here touches storage at import time.
 */

import { CAMERA_MODES } from '../../contracts/controls.js';

/** @typedef {import('../../contracts/controls.js').CameraMode} CameraMode */
/** @typedef {Pick<Storage, 'getItem' | 'setItem'>} CameraStorage */

/** `localStorage` key of the camera mode. */
export const CAMERA_MODE_STORAGE_KEY = 'laisaochodung.cameraMode';
/** Camera mode of a new player. */
export const DEFAULT_CAMERA_MODE = /** @type {CameraMode} */ ('chase');

/**
 * The browser's `localStorage`, or null where reading it throws (blocked storage) or it is absent.
 * @returns {CameraStorage | null} Storage.
 */
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a value is a camera mode.
 * @param {unknown} value Value.
 * @returns {value is CameraMode} A known mode.
 */
export function isCameraMode(value) {
  return CAMERA_MODES.includes(/** @type {CameraMode} */ (value));
}

/**
 * Reads the stored camera mode.
 * @param {CameraStorage | null} [storage] Storage; the browser's by default.
 * @returns {CameraMode} Stored mode, or `chase`.
 */
export function readCameraMode(storage = browserStorage()) {
  if (!storage) return DEFAULT_CAMERA_MODE;
  try {
    const value = storage.getItem(CAMERA_MODE_STORAGE_KEY);
    return isCameraMode(value) ? value : DEFAULT_CAMERA_MODE;
  } catch {
    return DEFAULT_CAMERA_MODE;
  }
}

/**
 * Stores a camera mode.
 * @param {CameraMode} mode Mode.
 * @param {CameraStorage | null} [storage] Storage; the browser's by default.
 * @returns {boolean} Whether it was stored (false where storage is blocked or full).
 */
export function writeCameraMode(mode, storage = browserStorage()) {
  if (!isCameraMode(mode)) throw new RangeError(`Unknown camera mode "${String(mode)}"`);
  if (!storage) return false;
  try {
    storage.setItem(CAMERA_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}
