import { describe, expect, it } from 'vitest';
import { RPM_BAR_MAX, indicatorLamps, rpmFraction } from './hud-view.js';

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
});
