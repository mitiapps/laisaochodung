import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS } from '../contracts/controls.js';
import { DT } from '../contracts/units.js';
import { SCOOTER_FRONT_BRAKE_PER_GRIP, STEER_RETURN_S, THROTTLE_RAMP_S, createInput } from './input.js';

/**
 * Dispatches a key event with the given fields.
 * @param {EventTarget} target Target.
 * @param {'keydown' | 'keyup'} type Type.
 * @param {string} code `KeyboardEvent.code`.
 * @param {Record<string, unknown>} [extra] Extra fields (repeat, ctrlKey).
 * @returns {Event} The event.
 */
function key(target, type, code, extra = {}) {
  const e = Object.assign(new Event(type, { cancelable: true }), { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
  target.dispatchEvent(e);
  return e;
}

/**
 * @param {Partial<import('./input.js').InputOptions>} [options] Options.
 * @returns {{input: import('./input.js').Input, target: EventTarget, pauses: () => number}} Driving input.
 */
function setup(options = {}) {
  const target = new EventTarget();
  let pauses = 0;
  const input = createInput({ legalClass: 'car', surfaceGrip: 1, target, onPause: () => (pauses += 1), ...options });
  input.setEnabled(true);
  input.setDriving(true);
  return { input, target, pauses: () => pauses };
}

/**
 * @param {import('./input.js').Input} input Input.
 * @param {number} n Samples.
 * @returns {import('../contracts/controls.js').ControlInput} Last sample.
 */
function sampleN(input, n) {
  let last = input.sample();
  for (let i = 1; i < n; i += 1) last = input.sample();
  return last;
}

describe('createInput ramps', () => {
  it('ramps the throttle to 1 in 0.3 s and back down after release', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyW');
    const steps = Math.round(THROTTLE_RAMP_S / DT);
    expect(sampleN(input, steps / 2).throttle).toBeCloseTo(0.5, 5);
    expect(sampleN(input, steps / 2).throttle).toBeCloseTo(1, 5);
    key(target, 'keyup', 'KeyW');
    expect(sampleN(input, 60).throttle).toBe(0);
  });

  it('ramps the steering out and returns it to centre', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyA');
    const left = sampleN(input, 6).steer;
    expect(left).toBeLessThan(0);
    expect(left).toBeGreaterThan(-1);
    expect(sampleN(input, 60).steer).toBe(-1);
    key(target, 'keyup', 'KeyA');
    expect(sampleN(input, 60).steer).toBe(0);
    key(target, 'keydown', 'ArrowRight');
    expect(sampleN(input, 60).steer).toBe(1);
  });
});

describe('createInput commands', () => {
  it('emits a press once, ignores key repeat and drops edges while not driving', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyE');
    key(target, 'keydown', 'KeyE', { repeat: true });
    expect(input.sample().gearCmd).toBe('up');
    expect(input.sample().gearCmd).toBeNull();
    input.setDriving(false);
    key(target, 'keydown', 'KeyZ');
    input.setDriving(true);
    expect(input.sample().signalCmd).toBeNull();
    key(target, 'keydown', 'KeyL');
    key(target, 'keydown', 'KeyF');
    expect(input.sample().lightsCmd).toBe('cycle');
    expect(input.sample().lightsCmd).toBe('flash');
  });

  it('prevents the default of bound keys only while enabled, and leaves shortcuts alone', () => {
    const { input, target } = setup();
    expect(key(target, 'keydown', 'Space').defaultPrevented).toBe(true);
    expect(key(target, 'keydown', 'KeyW', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(target, 'keydown', 'KeyQ', { metaKey: true }).defaultPrevented).toBe(false);
    expect(key(target, 'keydown', 'Tab').defaultPrevented).toBe(false);
    input.setEnabled(false);
    expect(key(target, 'keydown', 'Space').defaultPrevented).toBe(false);
  });

  it('calls onPause on Escape and P, also while not driving', () => {
    const { input, target, pauses } = setup();
    key(target, 'keydown', 'Escape');
    input.setDriving(false);
    key(target, 'keydown', 'KeyP');
    key(target, 'keydown', 'KeyP', { repeat: true });
    expect(pauses()).toBe(2);
  });

  it('releases held keys on blur', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyS');
    expect(input.sample().brakeFront).toBe(1);
    target.dispatchEvent(new Event('blur'));
    expect(input.sample().brakeFront).toBe(0);
  });

  it('stops listening after dispose', () => {
    const { input, target } = setup();
    input.dispose();
    key(target, 'keydown', 'KeyS');
    expect(input.sample().brakeFront).toBe(0);
  });

  it('rejects a missing grip', () => {
    expect(() => createInput({ legalClass: 'car', surfaceGrip: 0, target: new EventTarget() })).toThrow(RangeError);
  });
});

describe('createInput brake mapping', () => {
  it('car: S is the foot brake, Space the handbrake', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyS');
    key(target, 'keydown', 'Space');
    expect(input.sample()).toMatchObject({ brakeFront: 1, brakeRear: 0, handbrake: true });
  });

  it('motorbike: S is the front brake scaled by grip, Space the rear brake', () => {
    for (const grip of [1, 0.7]) {
      const { input, target } = setup({ legalClass: 'motorbike', surfaceGrip: grip });
      key(target, 'keydown', 'KeyS');
      key(target, 'keydown', 'Space');
      const s = input.sample();
      expect(s.brakeFront).toBeCloseTo(SCOOTER_FRONT_BRAKE_PER_GRIP * grip, 10);
      expect(s.brakeRear).toBe(1);
      expect(s.handbrake).toBe(false);
    }
  });
});

describe('createInput on-screen controls', () => {
  /** A step script: actions held over a number of steps, or one press. */
  const SCRIPT = /** @type {const} */ ([
    ['throttle', 20],
    ['brake', 5],
    ['handbrake', 5],
    ['steerLeft', 30],
    ['steerRight', 10],
    ['horn', 3],
    ['flash', 3],
  ]);

  it('hold and press give the same inputs as the keys, for every action', () => {
    for (const legalClass of /** @type {const} */ (['car', 'motorbike'])) {
      const keys = setup({ legalClass });
      const ui = setup({ legalClass });
      for (const binding of KEY_BINDINGS) {
        const code = binding.keys[0];
        if (binding.mode === 'hold') {
          const steps = SCRIPT.find(([a]) => a === binding.action)?.[1];
          expect(steps, binding.action).toBeDefined();
          key(keys.target, 'keydown', code);
          ui.input.hold(binding.action, true);
          for (let i = 0; i < /** @type {number} */ (steps); i += 1) expect(ui.input.sample()).toEqual(keys.input.sample());
          key(keys.target, 'keyup', code);
          ui.input.hold(binding.action, false);
        } else {
          key(keys.target, 'keydown', code);
          ui.input.press(binding.action);
        }
        for (let i = 0; i < 30; i += 1) expect(ui.input.sample()).toEqual(keys.input.sample());
      }
      expect(ui.pauses()).toBe(1);
      expect(keys.pauses()).toBe(1);
    }
  });

  it('a key and a control on one action release in either order', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyS');
    input.hold('brake', true);
    key(target, 'keyup', 'KeyS');
    expect(input.sample().brakeFront).toBe(1);
    input.hold('brake', false);
    expect(input.sample().brakeFront).toBe(0);
    input.hold('brake', true);
    key(target, 'keydown', 'KeyS');
    input.hold('brake', false);
    expect(input.sample().brakeFront).toBe(1);
    key(target, 'keyup', 'KeyS');
    expect(input.sample().brakeFront).toBe(0);
  });

  it('steer sets the steering while down and hands it back to the ramp, which centres it', () => {
    const { input } = setup();
    input.steer(0.6);
    expect(input.sample().steer).toBe(0.6);
    expect(input.sample().steer).toBe(0.6);
    input.steer(2);
    expect(input.sample().steer).toBe(1);
    input.steer(0.6);
    input.steer(null);
    const first = input.sample().steer;
    expect(first).toBeLessThan(0.6);
    expect(first).toBeGreaterThan(0);
    expect(sampleN(input, Math.ceil((0.6 * STEER_RETURN_S) / DT)).steer).toBe(0);
    expect(() => input.steer(Number.NaN)).toThrow(RangeError);
  });

  it('drops presses while not driving and every call while disabled, except releases', () => {
    const { input, pauses } = setup();
    input.setDriving(false);
    input.press('signalLeft');
    input.press('pause');
    input.setDriving(true);
    expect(input.sample().signalCmd).toBeNull();
    expect(pauses()).toBe(1);
    input.hold('throttle', true);
    input.setEnabled(false);
    input.hold('horn', true);
    input.press('pause');
    input.steer(0.5);
    const s = input.sample();
    expect(s.horn).toBe(false);
    expect(s.steer).toBe(0);
    expect(sampleN(input, 30).throttle).toBe(0);
    expect(pauses()).toBe(1);
  });

  it('rejects unknown actions and actions of the other mode', () => {
    const { input } = setup();
    expect(() => input.hold(/** @type {never} */ ('jump'), true)).toThrow(RangeError);
    expect(() => input.hold('gearUp', true)).toThrow(RangeError);
    expect(() => input.press('throttle')).toThrow(RangeError);
  });

  it('blur and a hidden tab release on-screen holds and steering', () => {
    const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const { input, target } = setup({ visibility });
    input.hold('brake', true);
    input.steer(-0.5);
    target.dispatchEvent(new Event('blur'));
    expect(input.sample().brakeFront).toBe(0);
    input.hold('brake', true);
    input.steer(-0.5);
    visibility.dispatchEvent(new Event('visibilitychange'));
    expect(input.sample().brakeFront).toBe(1);
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    const s = input.sample();
    expect(s.brakeFront).toBe(0);
    expect(s.steer).toBeGreaterThan(-0.5);
  });

  it('motorbike: the combined brake adds rear per grip; Space still gives full rear', () => {
    const share = 1.0;
    for (const grip of [1, 0.6]) {
      const { input, target } = setup({ legalClass: 'motorbike', surfaceGrip: grip, combinedRearPerGrip: share });
      input.hold('brake', true);
      const s = input.sample();
      expect(s.brakeFront).toBeCloseTo(SCOOTER_FRONT_BRAKE_PER_GRIP * grip, 10);
      expect(s.brakeRear).toBeCloseTo(Math.min(1, share * grip), 10);
      key(target, 'keydown', 'Space');
      expect(input.sample().brakeRear).toBe(1);
    }
    const car = setup({ combinedRearPerGrip: 1 });
    car.input.hold('brake', true);
    expect(car.input.sample()).toMatchObject({ brakeFront: 1, brakeRear: 0 });
    expect(() => createInput({ legalClass: 'motorbike', surfaceGrip: 1, target: new EventTarget(), combinedRearPerGrip: -1 })).toThrow(RangeError);
  });
});
