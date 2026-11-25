import { describe, expect, it } from 'vitest';
import hudStates from '../../../tests/fixtures/hud-states.json';
import { KEY_BINDINGS } from '../../contracts/controls.js';
import {
  CAMERA_NAMES,
  PRESET_NAMES,
  RPM_BAR_MAX,
  STEER_SLIDER_RANGE_PX,
  actionLabel,
  buttonView,
  controlLayout,
  indicatorLamps,
  layoutActions,
  newestToast,
  noticeItems,
  pedalControl,
  rpmFraction,
  sliderSteer,
  steeringTurnDeg,
} from './hud-view.js';

/** @typedef {import('../../contracts/hud.js').HudState} HudState */

const RUNNING = /** @type {HudState} */ (/** @type {unknown} */ (hudStates.running));

describe('HUD view helpers', () => {
  it('clamps the rpm bar to 0..1', () => {
    expect(rpmFraction(0)).toBe(0);
    expect(rpmFraction(RPM_BAR_MAX / 2)).toBe(0.5);
    expect(rpmFraction(RPM_BAR_MAX * 2)).toBe(1);
    expect(rpmFraction(Number.NaN)).toBe(0);
  });

  it('lights both arrows for hazards', () => {
    expect(indicatorLamps('hazard')).toEqual({ left: true, right: true, hazard: true });
    expect(indicatorLamps('left')).toEqual({ left: true, right: false, hazard: false });
    expect(indicatorLamps('off')).toEqual({ left: false, right: false, hazard: false });
  });

  it('shows the pedals and levers, labelled by vehicle and preset, and clamps them', () => {
    const controls = { throttle: 0.4, brakeFront: 1.5, brakeRear: 0.3, steer: 0, handbrake: false };
    expect(pedalControl('handbrake', controls, true, 'simple')).toEqual({
      action: 'handbrake',
      testId: 'hud-handbrake',
      label: 'Phanh tay',
      fraction: 0,
      on: false,
      shape: 'lever',
      rear: null,
    });
    expect(pedalControl('brake', controls, true, 'simple')).toMatchObject({ testId: 'hud-brake-front', label: 'Phanh chân', fraction: 1, on: true, shape: 'pedal', rear: null });
    expect(pedalControl('throttle', controls, true, 'simple')).toMatchObject({ testId: 'hud-throttle', label: 'Ga', fraction: 0.4, on: true });
    expect(pedalControl('handbrake', { ...controls, handbrake: true }, true, 'real')).toMatchObject({ fraction: 1, on: true });
    expect(pedalControl('throttle', { ...controls, throttle: Number.NaN }, false, 'real')).toMatchObject({ fraction: 0, on: false });
    expect(pedalControl('brakeRear', controls, false, 'real')).toMatchObject({ testId: 'hud-brake-rear', label: 'Phanh sau', fraction: 0.3, shape: 'lever' });
    expect(pedalControl('brake', controls, false, 'real')).toMatchObject({ label: 'Phanh trước', rear: null });
    // Đơn giản: one brake for both, which also shows the rear brake it applies.
    expect(pedalControl('brake', controls, false, 'simple')).toMatchObject({ label: 'Phanh', rear: { testId: 'hud-brake-rear', fraction: 0.3 } });
    expect(() => pedalControl(/** @type {never} */ ('horn'), controls, true, 'simple')).toThrow(RangeError);
  });

  it('gives each round button the state it shows', () => {
    const state = { ...RUNNING, indicators: /** @type {const} */ ('left'), horn: true };
    for (const action of /** @type {const} */ (['signalLeft', 'signalRight', 'hazard', 'horn', 'lightsCycle', 'flash', 'gearUp', 'gearDown'])) {
      const b = buttonView(action, state);
      const binding = KEY_BINDINGS.find((k) => k.action === action);
      expect(b.mode).toBe(binding?.mode);
      expect(b.label).toBe(binding?.label.vi);
    }
    expect(buttonView('signalLeft', state)).toMatchObject({ testId: 'hud-indicator-left', on: true, blink: true });
    expect(buttonView('signalRight', state)).toMatchObject({ testId: 'hud-indicator-right', on: false });
    expect(buttonView('horn', state)).toMatchObject({ testId: 'hud-horn', on: true, blink: false });
    expect(buttonView('lightsCycle', state).testId).toBeNull();
    const hazard = { ...RUNNING, indicators: /** @type {const} */ ('hazard') };
    expect(['signalLeft', 'hazard', 'signalRight'].map((a) => buttonView(/** @type {never} */ (a), hazard).on)).toEqual([true, true, true]);
    expect(() => buttonView('throttle', state)).toThrow(RangeError);
  });

  it('lays the controls out in cabin order: stalk, lever, steering, horn, pedals, console', () => {
    const car = controlLayout('car', 'simple');
    expect(car).toMatchObject({
      steering: 'wheel',
      stalk: [
        ['lightsCycle', 'flash'],
        ['signalLeft', 'signalRight'],
      ],
      lever: [],
      horn: ['horn'],
      pedals: ['brake', 'throttle'],
      console: ['hazard', 'gearUp', 'gearDown', 'handbrake'],
      consoleOverThrottle: false,
      top: ['camera', 'pause'],
    });
    expect(controlLayout('car', 'real')).toBe(car);
    const real = controlLayout('motorbike', 'real');
    expect(real).toMatchObject({
      steering: 'handlebar',
      stalk: [
        ['lightsCycle', 'flash'],
        ['signalLeft', 'signalRight', 'horn'],
      ],
      lever: ['brakeRear'],
      horn: [],
      console: ['hazard'],
      consoleOverThrottle: true,
    });
    expect(controlLayout('motorbike', 'simple').lever).toEqual([]);
    expect(controlLayout('moped', 'real')).toBe(real);
  });

  it('gives every action one control per vehicle: the car has no rear lever, the motorbike no gears or handbrake', () => {
    const all = KEY_BINDINGS.map((b) => b.action);
    const car = layoutActions(controlLayout('car', 'real'));
    expect(new Set(car).size).toBe(car.length);
    expect([...car].sort()).toEqual(all.filter((a) => a !== 'brakeRear').sort());
    const bike = layoutActions(controlLayout('motorbike', 'real'));
    expect(new Set(bike).size).toBe(bike.length);
    expect([...bike].sort()).toEqual(all.filter((a) => !['gearUp', 'gearDown', 'handbrake'].includes(a)).sort());
    expect(layoutActions(controlLayout('motorbike', 'simple'))).not.toContain('brakeRear');
  });

  it('turns the drawn wheel further than the handlebar', () => {
    expect(steeringTurnDeg(1, 'wheel')).toBe(120);
    expect(steeringTurnDeg(-0.5, 'handlebar')).toBe(-12.5);
    expect(steeringTurnDeg(3, 'wheel')).toBe(120);
    expect(steeringTurnDeg(Number.NaN, 'wheel')).toBe(0);
  });

  it('turns the slider offset into steering and names actions and presets', () => {
    expect(sliderSteer(0)).toBe(0);
    expect(sliderSteer(STEER_SLIDER_RANGE_PX / 2)).toBe(0.5);
    expect(sliderSteer(-STEER_SLIDER_RANGE_PX * 3)).toBe(-1);
    expect(sliderSteer(Number.NaN)).toBe(0);
    expect(sliderSteer(10, 0)).toBe(0);
    expect(actionLabel('horn')).toBe('Còi');
    expect(() => actionLabel(/** @type {never} */ ('jump'))).toThrow(RangeError);
    expect(PRESET_NAMES).toEqual({ simple: 'Đơn giản', real: 'Thực tế' });
    expect(CAMERA_NAMES).toEqual({ chase: 'Thứ ba (sau xe)', cockpit: 'Thứ nhất (trong xe)' });
  });

  it('keys notices by contact tick, counting contacts on the same tick', () => {
    const at = (/** @type {number} */ tick) =>
      /** @type {import('../../contracts/score.js').Notice} */ (/** @type {unknown} */ ({ tick, text: { vi: 'x' } }));
    const items = noticeItems([at(100), at(160), at(160)]);
    expect(items.map((i) => i.key)).toEqual(['100#0', '160#0', '160#1']);
    expect(noticeItems([at(160), at(160)]).map((i) => i.key)).toEqual(['160#0', '160#1']);
    expect(noticeItems([])).toEqual([]);
  });

  it('picks the newest toast-stack item by tick and counts the rest for a short screen', () => {
    const at = (/** @type {number} */ tick) =>
      /** @type {import('../../contracts/score.js').Notice} */ (/** @type {unknown} */ ({ tick, text: { vi: 'x' } }));
    const toast = (/** @type {string} */ episodeId, /** @type {number} */ tick) => ({ episodeId, breach: { tick } });
    expect(newestToast([], [])).toEqual({ key: null, more: 0 });
    expect(newestToast(noticeItems([at(100)]), [])).toEqual({ key: 'notice:100#0', more: 0 });
    expect(newestToast(noticeItems([at(100)]), [toast('a', 90), toast('b', 120)])).toEqual({ key: 'toast:b', more: 2 });
    expect(newestToast(noticeItems([at(100), at(300)]), [toast('a', 90), toast('b', 120)])).toEqual({ key: 'notice:300#0', more: 3 });
    // The last notice of one tick is the newest; a breach toast on the same tick wins.
    expect(newestToast(noticeItems([at(160), at(160)]), []).key).toBe('notice:160#1');
    expect(newestToast(noticeItems([at(160)]), [toast('a', 160)]).key).toBe('toast:a');
  });
});
