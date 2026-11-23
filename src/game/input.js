/**
 * Keyboard input from `KEY_BINDINGS`. Held keys become ramped analogue values, `press` keys become
 * edge commands delivered once by the next `sample()`, and the pause key is handled outside the
 * sim step through `onPause`, so it keeps working while the run is paused.
 *
 * - `event.repeat` key-downs never emit a command again.
 * - Key-downs with Ctrl, Alt or Meta are left to the browser.
 * - Losing focus (`blur`) releases every held key.
 * - While input is enabled, bound keys have their default action prevented, so Space does not
 *   click a focused button and the arrows do not scroll.
 * - Throttle ramps 0 → 1 in `THROTTLE_RAMP_S`; steering ramps to full lock in `STEER_RAMP_S` and
 *   returns to centre in `STEER_RETURN_S`. Brakes are not ramped.
 */

import { KEY_BINDINGS, neutralInput } from '../contracts/controls.js';
import { DT } from '../contracts/units.js';

/** @typedef {import('../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/controls.js').ControlAction} ControlAction */
/** @typedef {import('../contracts/vehicle.js').LegalClass} LegalClass */

/** Seconds for the throttle to go from 0 to 1. */
export const THROTTLE_RAMP_S = 0.3;
/** Seconds for the throttle to fall from 1 to 0 after release. */
export const THROTTLE_RELEASE_S = 0.15;
/** Seconds for the steering to go from centre to full lock. */
export const STEER_RAMP_S = 0.35;
/** Seconds for the steering to return from full lock to centre. */
export const STEER_RETURN_S = 0.25;
/**
 * Front brake of a motorbike while S is held, as a fraction of `map.environment.surfaceGrip`.
 * A key cannot be squeezed halfway, so S stands for the firmest squeeze a careful rider uses on
 * that surface. Tuned to the two-wheel rig's front lock point (between 0.6 and 0.7 on dry asphalt,
 * scaling with grip): 0.55 × grip never locks the front in a straight line, so S plus Space never
 * drops the scooter, while rain still lengthens the stop.
 */
export const SCOOTER_FRONT_BRAKE_PER_GRIP = 0.55;

/** @type {ReadonlyMap<string, import('../contracts/controls.js').KeyBinding>} */
const BINDING_BY_CODE = new Map(KEY_BINDINGS.flatMap((b) => b.keys.map((k) => /** @type {const} */ ([k, b]))));

/**
 * Moves `value` toward `target` by at most `maxStep`.
 * @param {number} value Current.
 * @param {number} target Target.
 * @param {number} maxStep Largest change.
 * @returns {number} Next value.
 */
function approach(value, target, maxStep) {
  if (value < target) return Math.min(target, value + maxStep);
  return Math.max(target, value - maxStep);
}

/**
 * @typedef {object} InputOptions
 * @property {LegalClass} legalClass Vehicle class; picks the brake mapping.
 * @property {number} surfaceGrip Map surface grip (1 dry asphalt).
 * @property {EventTarget} target Where key events arrive (the window).
 * @property {() => void} [onPause] Called on a pause key press while input is enabled.
 */

/**
 * @typedef {object} Input
 * @property {(dt?: number) => ControlInput} sample Input for one fixed step of `dt` seconds;
 *   consumes the pending edge commands.
 * @property {(enabled: boolean) => void} setEnabled Whether the run listens (running or paused).
 * @property {(driving: boolean) => void} setDriving Whether edge commands are latched (running).
 * @property {() => void} dispose Removes the listeners.
 */

/**
 * Creates the keyboard input.
 * @param {InputOptions} options Options.
 * @returns {Input} Input.
 */
export function createInput({ legalClass, surfaceGrip, target, onPause }) {
  if (!Number.isFinite(surfaceGrip) || surfaceGrip <= 0) throw new RangeError('createInput needs a positive surfaceGrip');
  const motorbike = legalClass !== 'car';
  const frontBrake = motorbike ? Math.min(1, SCOOTER_FRONT_BRAKE_PER_GRIP * surfaceGrip) : 1;
  /** @type {Set<string>} */
  const heldCodes = new Set();
  /** @type {{gearCmd: ControlInput['gearCmd'], signalCmd: ControlInput['signalCmd'], cycle: boolean}} */
  let edges = { gearCmd: null, signalCmd: null, cycle: false };
  let throttle = 0;
  let steer = 0;
  let enabled = false;
  let driving = false;

  /**
   * @param {ControlAction} action Action.
   * @returns {boolean} Some key of the action is held.
   */
  const held = (action) => {
    for (const code of heldCodes) if (BINDING_BY_CODE.get(code)?.action === action) return true;
    return false;
  };

  /** @param {ControlAction} action Pressed action. */
  const press = (action) => {
    if (action === 'pause') {
      onPause?.();
      return;
    }
    if (!driving) return;
    if (action === 'gearUp') edges.gearCmd = 'up';
    else if (action === 'gearDown') edges.gearCmd = 'down';
    else if (action === 'signalLeft') edges.signalCmd = 'left';
    else if (action === 'signalRight') edges.signalCmd = 'right';
    else if (action === 'hazard') edges.signalCmd = 'hazard';
    else if (action === 'lightsCycle') edges.cycle = true;
  };

  /** @param {Event} ev Key event. */
  const onKeyDown = (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const binding = BINDING_BY_CODE.get(e.code);
    if (!binding || !enabled) return;
    e.preventDefault();
    if (binding.mode === 'hold') heldCodes.add(e.code);
    else if (!e.repeat) press(binding.action);
  };

  /** @param {Event} ev Key event. */
  const onKeyUp = (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    const binding = BINDING_BY_CODE.get(e.code);
    if (!binding) return;
    heldCodes.delete(e.code);
    if (enabled) e.preventDefault();
  };

  const onBlur = () => heldCodes.clear();

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return {
    sample(dt = DT) {
      throttle = held('throttle') ? approach(throttle, 1, dt / THROTTLE_RAMP_S) : approach(throttle, 0, dt / THROTTLE_RELEASE_S);
      const steerTarget = (held('steerRight') ? 1 : 0) - (held('steerLeft') ? 1 : 0);
      // Back toward centre (released, or counter-steering) at the return rate, outward at the ramp rate.
      const rate = steerTarget === 0 || steer * steerTarget < 0 ? dt / STEER_RETURN_S : dt / STEER_RAMP_S;
      steer = approach(steer, steerTarget, rate);
      const brake = held('brake');
      const space = held('handbrake');
      const input = neutralInput();
      input.throttle = throttle;
      input.steer = steer;
      input.brakeFront = brake ? frontBrake : 0;
      input.brakeRear = motorbike && space ? 1 : 0;
      input.handbrake = !motorbike && space;
      input.horn = held('horn');
      input.gearCmd = edges.gearCmd;
      input.signalCmd = edges.signalCmd;
      input.lightsCmd = edges.cycle ? 'cycle' : held('flash') ? 'flash' : null;
      edges = { gearCmd: null, signalCmd: null, cycle: false };
      return input;
    },
    setEnabled(value) {
      enabled = value;
      if (!value) heldCodes.clear();
    },
    setDriving(value) {
      driving = value;
      if (!value) edges = { gearCmd: null, signalCmd: null, cycle: false };
    },
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      heldCodes.clear();
    },
  };
}
