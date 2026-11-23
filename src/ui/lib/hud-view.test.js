import { describe, expect, it } from 'vitest';
import { RPM_BAR_MAX, indicatorLamps, pedalBars, rpmFraction, steerPosition } from './hud-view.js';

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

  it('labels pedal bars by vehicle and clamps them', () => {
    const controls = { throttle: 0.4, brakeFront: 1.5, brakeRear: 0.3, steer: 0, handbrake: false };
    expect(pedalBars(controls, true)).toEqual([
      { id: 'throttle', label: 'Ga', fraction: 0.4 },
      { id: 'brake-front', label: 'Phanh chân', fraction: 1 },
    ]);
    expect(pedalBars({ ...controls, throttle: Number.NaN }, false)).toEqual([
      { id: 'throttle', label: 'Ga', fraction: 0 },
      { id: 'brake-front', label: 'Phanh trước', fraction: 1 },
      { id: 'brake-rear', label: 'Phanh sau', fraction: 0.3 },
    ]);
  });

  it('maps steering onto the gauge with the centre at 0.5', () => {
    expect(steerPosition(-1)).toBe(0);
    expect(steerPosition(0)).toBe(0.5);
    expect(steerPosition(0.5)).toBe(0.75);
    expect(steerPosition(3)).toBe(1);
    expect(steerPosition(Number.NaN)).toBe(0.5);
  });
});
