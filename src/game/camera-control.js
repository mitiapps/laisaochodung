/**
 * The camera mode of the game: one control shared by the key, the HUD button and the home-page
 * chooser. It keeps the mode in storage and passes it to the renderer of the current run. The mode
 * is a view choice only; it never passes through the session, a frame, the scorer or the HUD state.
 */

import { CAMERA_MODES } from '../contracts/controls.js';

/** @typedef {import('../contracts/controls.js').CameraMode} CameraMode */
/** @typedef {Pick<import('../contracts/modules.js').Renderer, 'setCameraMode'>} CameraTarget */

/**
 * @typedef {object} CameraControl
 * @property {() => CameraMode} mode Current mode.
 * @property {(mode: CameraMode) => void} set Choose a mode: stores it, applies it to the attached
 *   renderer and tells the subscribers.
 * @property {() => void} toggle Switch to the other mode.
 * @property {(renderer: CameraTarget | null) => void} attach Renderer of the current run, given the
 *   current mode at once; null detaches it.
 * @property {(fn: (mode: CameraMode) => void) => () => void} subscribe Called with the mode now and
 *   on every change; returns an unsubscribe function.
 */

/**
 * Where the chosen mode is kept between visits. The caller supplies it (the browser build passes
 * the `localStorage` store), so this module depends on no storage or UI code.
 * @typedef {object} CameraModeStore
 * @property {() => CameraMode} read Stored mode, or the default; never throws.
 * @property {(mode: CameraMode) => boolean} write Stores a mode; false where it could not be kept.
 */

/**
 * Creates the camera control, starting from the stored mode.
 * @param {{store: CameraModeStore}} options Options.
 * @returns {CameraControl} Control.
 */
export function createCameraControl({ store }) {
  let mode = store.read();
  if (!CAMERA_MODES.includes(mode)) throw new RangeError(`Unknown stored camera mode "${String(mode)}"`);
  /** Whether a failed save was already reported: blocked storage fails on every toggle. */
  let warned = false;
  /** @type {CameraTarget | null} */
  let renderer = null;
  /** @type {Set<(mode: CameraMode) => void>} */
  const listeners = new Set();

  /** @param {CameraMode} next Mode. */
  const set = (next) => {
    if (!CAMERA_MODES.includes(next)) throw new RangeError(`Unknown camera mode "${String(next)}"`);
    mode = next;
    if (!store.write(next) && !warned) {
      warned = true;
      console.warn('The camera mode could not be saved; it applies to this visit only');
    }
    renderer?.setCameraMode?.(next);
    for (const fn of listeners) fn(next);
  };

  return {
    mode: () => mode,
    set,
    toggle() {
      set(mode === 'chase' ? 'cockpit' : 'chase');
    },
    attach(next) {
      renderer = next;
      renderer?.setCameraMode?.(mode);
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(mode);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
