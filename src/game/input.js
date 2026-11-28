/**
 * The input mixer: the keyboard (`KEY_BINDINGS`) and the on-screen controls feed one held set and
 * one press path. Held actions become ramped analogue values, `press` actions become edge commands
 * delivered once by the next `sample()`, and the pause and camera actions are handled outside the
 * sim step through `onPause` and `onCamera`, so they keep working while the run is paused.
 *
 * - Holds are kept per source, a key code or the on-screen control of an action, and an action is
 *   held while any source holds it, so a key and a finger on the same action release correctly.
 * - `event.repeat` key-downs never emit a command again.
 * - Key-downs with Ctrl, Alt or Meta are left to the browser.
 * - Losing focus (`blur`) or a hidden tab (`visibilitychange`) releases every source.
 * - While an on-screen steering pointer is down its value is the steering; on release the ramp
 *   takes over from that value and returns it to centre.
 * - While input is enabled, bound keys have their default action prevented, so Space does not
 *   click a focused button and the arrows do not scroll.
 * - `handbrake` and `brakeRear` are one control: either applies the handbrake on a car and the
 *   rear brake on a motorbike, so each vehicle shows its own key and a habit key still works.
 * - A motorbike has no gear selector to drive: the gear keys send no `gearCmd` for it. The rule
 *   goes by legal class because every catalog motorbike is automatic (see `ControlAction`).
 * - `pushBack` (R, or the on-screen Lùi button) is the mirror: it reaches the sim on a motorbike
 *   only and stays false on a car, which reverses through its R gear. The sim decides when the push
 *   acts (throttle and brakes released, not rolling forward).
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


/** @type {ReadonlyMap<ControlAction, import('../contracts/controls.js').KeyBinding>} */
const BINDING_BY_ACTION = new Map(KEY_BINDINGS.map((b) => [b.action, b]));

/**
 * The binding of an on-screen control's action, checked against the mode the call needs.
 * @param {unknown} action Action from the UI.
 * @param {'hold' | 'press'} mode Mode the call needs.
 * @returns {import('../contracts/controls.js').KeyBinding} Binding.
 */
function bindingFor(action, mode) {
  const binding = BINDING_BY_ACTION.get(/** @type {ControlAction} */ (action));
  if (!binding) throw new RangeError(`Unknown control action "${String(action)}"`);
  if (binding.mode !== mode) throw new RangeError(`Control action "${binding.action}" is a ${binding.mode} action, not a ${mode} action`);
  return binding;
}

/**
 * @typedef {object} InputOptions
 * @property {LegalClass} legalClass Vehicle class; picks the brake mapping.
 * @property {number} surfaceGrip Map surface grip (1 dry asphalt).
 * @property {EventTarget} target Where key events arrive (the window).
 * @property {{visibilityState: string} & EventTarget} [visibility] Releases every source when it
 *   reports `hidden` (the document).
 * @property {() => void} [onPause] Called on a pause press while input is enabled.
 * @property {() => void} [onCamera] Called on a camera press while input is enabled, running or
 *   paused.
 * @property {number} [combinedRearPerGrip] Motorbike: the rear brake the brake action adds, per unit
 *   of surface grip, next to the front brake. 0 (default) keeps the brakes separate.
 */

/**
 * @typedef {object} Input
 * @property {(dt?: number) => ControlInput} sample Input for one fixed step of `dt` seconds;
 *   consumes the pending edge commands.
 * @property {(enabled: boolean) => void} setEnabled Whether the run listens (running or paused).
 * @property {(driving: boolean) => void} setDriving Whether edge commands are latched (running).
 * @property {(action: ControlAction, on: boolean) => void} hold On-screen control: hold or release
 *   a `hold` action. Ignored while input is disabled, except a release.
 * @property {(action: ControlAction) => void} press On-screen control: fire a `press` action once,
 *   on the same path as its key.
 * @property {(value: number | null) => void} steer On-screen steering −1..1 while its pointer is
 *   down; null hands the steering back to the ramp.
 * @property {() => void} dispose Removes the listeners.
 */

/**
 * Creates the input mixer.
 * @param {InputOptions} options Options.
 * @returns {Input} Input.
 */
export function createInput({ legalClass, surfaceGrip, target, visibility, onPause, onCamera, combinedRearPerGrip = 0 }) {
  if (!Number.isFinite(surfaceGrip) || surfaceGrip <= 0) throw new RangeError('createInput needs a positive surfaceGrip');
  if (!Number.isFinite(combinedRearPerGrip) || combinedRearPerGrip < 0) throw new RangeError('createInput needs a combinedRearPerGrip ≥ 0');
  const motorbike = legalClass !== 'car';
  const frontBrake = motorbike ? Math.min(1, SCOOTER_FRONT_BRAKE_PER_GRIP * surfaceGrip) : 1;
  const combinedRear = motorbike && combinedRearPerGrip > 0 ? Math.min(1, combinedRearPerGrip * surfaceGrip) : 0;
  /** @type {Set<string>} */
  const heldCodes = new Set();
  /** @type {Set<ControlAction>} Actions held by their on-screen control. */
  const heldControls = new Set();
  /** @type {{gearCmd: ControlInput['gearCmd'], signalCmd: ControlInput['signalCmd'], cycle: boolean}} */
  let edges = { gearCmd: null, signalCmd: null, cycle: false };
  let throttle = 0;
  let steer = 0;
  /** @type {number | null} On-screen steering while its pointer is down. */
  let steerOverride = null;
  let enabled = false;
  let driving = false;

  /**
   * @param {ControlAction} action Action.
   * @returns {boolean} Some source holds the action.
   */
  const held = (action) => {
    if (heldControls.has(action)) return true;
    for (const code of heldCodes) if (BINDING_BY_CODE.get(code)?.action === action) return true;
    return false;
  };

  const releaseAll = () => {
    heldCodes.clear();
    heldControls.clear();
    steerOverride = null;
  };

  /** @param {ControlAction} action Pressed action. */
  const firePress = (action) => {
    if (action === 'pause') {
      onPause?.();
      return;
    }
    if (action === 'camera') {
      onCamera?.();
      return;
    }
    if (!driving) return;
    if (action === 'gearUp') edges.gearCmd = motorbike ? null : 'up';
    else if (action === 'gearDown') edges.gearCmd = motorbike ? null : 'down';
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
    else if (!e.repeat) firePress(binding.action);
  };

  /** @param {Event} ev Key event. */
  const onKeyUp = (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    const binding = BINDING_BY_CODE.get(e.code);
    if (!binding) return;
    heldCodes.delete(e.code);
    if (enabled) e.preventDefault();
  };

  const onBlur = () => releaseAll();
  const onVisibility = () => {
    if (visibility?.visibilityState === 'hidden') releaseAll();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);
  visibility?.addEventListener('visibilitychange', onVisibility);

  return {
    sample(dt = DT) {
      throttle = held('throttle') ? approach(throttle, 1, dt / THROTTLE_RAMP_S) : approach(throttle, 0, dt / THROTTLE_RELEASE_S);
      if (steerOverride !== null) {
        steer = steerOverride;
      } else {
        const steerTarget = (held('steerRight') ? 1 : 0) - (held('steerLeft') ? 1 : 0);
        // Back toward centre (released, or counter-steering) at the return rate, outward at the ramp rate.
        const rate = steerTarget === 0 || steer * steerTarget < 0 ? dt / STEER_RETURN_S : dt / STEER_RAMP_S;
        steer = approach(steer, steerTarget, rate);
      }
      const brake = held('brake');
      const lever = held('handbrake') || held('brakeRear');
      const input = neutralInput();
      input.throttle = throttle;
      input.steer = steer;
      input.brakeFront = brake ? frontBrake : 0;
      input.brakeRear = motorbike ? Math.max(lever ? 1 : 0, brake ? combinedRear : 0) : 0;
      input.handbrake = !motorbike && lever;
      input.horn = held('horn');
      input.pushBack = motorbike && held('pushBack');
      input.gearCmd = edges.gearCmd;
      input.signalCmd = edges.signalCmd;
      input.lightsCmd = edges.cycle ? 'cycle' : held('flash') ? 'flash' : null;
      edges = { gearCmd: null, signalCmd: null, cycle: false };
      return input;
    },
    setEnabled(value) {
      enabled = value;
      if (!value) releaseAll();
    },
    setDriving(value) {
      driving = value;
      if (!value) edges = { gearCmd: null, signalCmd: null, cycle: false };
    },
    hold(action, on) {
      const binding = bindingFor(action, 'hold');
      if (!on) heldControls.delete(binding.action);
      else if (enabled) heldControls.add(binding.action);
    },
    press(action) {
      const binding = bindingFor(action, 'press');
      if (enabled) firePress(binding.action);
    },
    steer(value) {
      if (value === null) {
        steerOverride = null;
        return;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`steer needs a finite number or null, got ${String(value)}`);
      if (!enabled) return;
      steerOverride = Math.max(-1, Math.min(1, value));
      steer = steerOverride;
    },
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      visibility?.removeEventListener('visibilitychange', onVisibility);
      releaseAll();
    },
  };
}
