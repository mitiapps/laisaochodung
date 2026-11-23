import { describe, expect, it } from 'vitest';
import { DT } from '../contracts/units.js';
import { SCOOTER_FRONT_BRAKE_PER_GRIP, THROTTLE_RAMP_S, createInput } from './input.js';

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
