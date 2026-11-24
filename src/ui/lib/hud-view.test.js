import { describe, expect, it } from 'vitest';
import hudStates from '../../../tests/fixtures/hud-states.json';
import { KEY_BINDINGS } from '../../contracts/controls.js';
import {
  ARC_ROWS,
  PRESET_NAMES,
  RPM_BAR_MAX,
  STEER_SLIDER_RANGE_PX,
  actionLabel,
  arcButtons,
  indicatorLamps,
  noticeItems,
  pedalControls,
  rpmFraction,
  sliderSteer,
  steerPosition,
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

  it('lays out the pedals and the lever, labelled by vehicle and preset, and clamps them', () => {
    const controls = { throttle: 0.4, brakeFront: 1.5, brakeRear: 0.3, steer: 0, handbrake: false };
    expect(pedalControls(controls, true, 'simple')).toEqual([
      { action: 'handbrake', testId: 'hud-handbrake', label: 'Phanh tay', fraction: 0, on: false, shape: 'lever' },
      { action: 'brake', testId: 'hud-brake-front', label: 'Phanh chân', fraction: 1, on: true, shape: 'pedal' },
      { action: 'throttle', testId: 'hud-throttle', label: 'Ga', fraction: 0.4, on: true, shape: 'pedal' },
    ]);
    expect(pedalControls({ ...controls, handbrake: true }, true, 'real')[0]).toMatchObject({ fraction: 1, on: true });
    const scooter = pedalControls({ ...controls, throttle: Number.NaN }, false, 'real');
    expect(scooter.map((c) => [c.testId, c.label, c.fraction])).toEqual([
      ['hud-brake-rear', 'Phanh sau', 0.3],
      ['hud-brake-front', 'Phanh trước', 1],
      ['hud-throttle', 'Ga', 0],
    ]);
    expect(pedalControls(controls, false, 'simple')[1].label).toBe('Phanh');
  });

  it('puts every press and arc action in exactly one arc button, with the state it shows', () => {
    const car = arcButtons({ ...RUNNING, indicators: 'left', horn: true });
    expect(car.map((row) => row.map((b) => b.action))).toEqual(ARC_ROWS.map((row) => [...row]));
    const flat = car.flat();
    expect(new Set(flat.map((b) => b.action)).size).toBe(flat.length);
    for (const b of flat) {
      const binding = KEY_BINDINGS.find((k) => k.action === b.action);
      expect(b.mode).toBe(binding?.mode);
      expect(b.label).toBe(binding?.label.vi);
    }
    expect(flat.find((b) => b.action === 'signalLeft')).toMatchObject({ testId: 'hud-indicator-left', on: true, blink: true });
    expect(flat.find((b) => b.action === 'signalRight')).toMatchObject({ testId: 'hud-indicator-right', on: false });
    expect(flat.find((b) => b.action === 'horn')).toMatchObject({ testId: 'hud-horn', on: true, blink: false });
    expect(flat.find((b) => b.action === 'lightsCycle')?.testId).toBeNull();
    const hazard = arcButtons({ ...RUNNING, indicators: 'hazard' }).flat();
    expect(hazard.filter((b) => b.on).map((b) => b.action)).toEqual(['signalLeft', 'hazard', 'signalRight']);
  });

  it('covers every action once across the arc, the pedals, the slider and pause', () => {
    const actions = [
      ...arcButtons(RUNNING).flat().map((b) => b.action),
      ...pedalControls(RUNNING.controls, true, 'simple').map((c) => c.action),
      'steerLeft',
      'steerRight',
      'pause',
    ].sort();
    expect(actions).toEqual(KEY_BINDINGS.map((b) => b.action).sort());
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
  });

  it('maps steering onto the slider with the centre at 0.5', () => {
    expect(steerPosition(-1)).toBe(0);
    expect(steerPosition(0)).toBe(0.5);
    expect(steerPosition(0.5)).toBe(0.75);
    expect(steerPosition(3)).toBe(1);
    expect(steerPosition(Number.NaN)).toBe(0.5);
  });

  it('keys notices by contact tick, counting contacts on the same tick', () => {
    const at = (/** @type {number} */ tick) =>
      /** @type {import('../../contracts/score.js').Notice} */ (/** @type {unknown} */ ({ tick, text: { vi: 'x' } }));
    const items = noticeItems([at(100), at(160), at(160)]);
    expect(items.map((i) => i.key)).toEqual(['100#0', '160#0', '160#1']);
    expect(noticeItems([at(160), at(160)]).map((i) => i.key)).toEqual(['160#0', '160#1']);
    expect(noticeItems([])).toEqual([]);
  });
});
