import { describe, expect, it } from 'vitest';
import { driveForce, initialGear, shiftGear } from './gearbox.js';
import { carSedan } from './vehicles/car-sedan.js';
import { scooter } from './vehicles/scooter.js';

const manual = /** @type {import('./tuning.js').ManualGearboxSpec} */ (carSedan.gearbox);
const auto = /** @type {import('./tuning.js').AutoGearboxSpec} */ (scooter.gearbox);

describe('shiftGear', () => {
  it('walks the manual gears from R through N to 5 and clamps at the ends', () => {
    expect(initialGear(manual)).toBe('N');
    /** @type {import('../contracts/telemetry.js').Gear} */
    let g = 'N';
    const seen = [];
    for (let i = 0; i < 7; i += 1) {
      g = shiftGear(manual, g, 'up', 10);
      seen.push(g);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(shiftGear(manual, 1, 'down', 10)).toBe('N');
    expect(shiftGear(manual, 'R', 'up', 0)).toBe('N');
    expect(shiftGear(manual, 'R', 'down', 0)).toBe('R');
    expect(shiftGear(manual, 3, null, 10)).toBe(3);
  });

  it('allows reverse only below 2 km/h', () => {
    expect(shiftGear(manual, 'N', 'down', 0.5)).toBe('R');
    expect(shiftGear(manual, 'N', 'down', -0.5)).toBe('R');
    expect(shiftGear(manual, 'N', 'down', 2 / 3.6)).toBe('N');
    expect(shiftGear(manual, 'N', 'down', 5)).toBe('N');
  });

  it('gives the automatic N and D only', () => {
    expect(initialGear(auto)).toBe('D');
    expect(shiftGear(auto, 'D', 'down', 0)).toBe('N');
    expect(shiftGear(auto, 'N', 'down', 0)).toBe('N');
    expect(shiftGear(auto, 'N', 'up', 0)).toBe('D');
    expect(shiftGear(auto, 'D', 'up', 0)).toBe('D');
    expect(() => shiftGear(auto, 3, 'up', 0)).toThrow(RangeError);
  });
});

describe('driveForce', () => {
  it('drives forward in gear, backward in R and not at all in N', () => {
    const r = carSedan.wheelRadius;
    expect(driveForce(manual, 1, 1, 0, 0, r).forceN).toBeGreaterThan(5000);
    expect(driveForce(manual, 'R', 1, 0, 0, r).forceN).toBeLessThan(-5000);
    expect(driveForce(manual, 'N', 1, 0, 0, r).forceN).toBe(0);
    expect(driveForce(manual, 3, 0, 10, 10 / r, r).forceN).toBe(0);
  });

  it('gives less force in higher gears and estimates rpm from wheel spin', () => {
    const r = carSedan.wheelRadius;
    const f1 = driveForce(manual, 1, 1, 5, 5 / r, r);
    const f5 = driveForce(manual, 5, 1, 5, 5 / r, r);
    expect(f5.forceN).toBeLessThan(f1.forceN);
    expect(f1.rpm).toBeGreaterThan(f5.rpm);
    // 50 km/h in 4th: 44.8 rad/s × 4.1 ≈ 1754 rpm.
    const f4 = driveForce(manual, 4, 0.5, 50 / 3.6, 50 / 3.6 / r, r);
    expect(f4.rpm).toBeCloseTo((50 / 3.6 / r) * 4.1 * (60 / (2 * Math.PI)), 3);
    expect(driveForce(manual, 1, 0, 0, 0, r).rpm).toBe(manual.idleRpm);
  });

  it('cuts drive force at the rev limiter', () => {
    const r = carSedan.wheelRadius;
    const spin = (manual.redlineRpm / (60 / (2 * Math.PI))) / (manual.ratios[0] * manual.finalDrive);
    expect(driveForce(manual, 1, 1, spin * r, spin * 1.01, r)).toEqual({ forceN: 0, rpm: manual.redlineRpm });
  });

  it('fades the automatic drive force to zero at top speed', () => {
    const r = scooter.wheelRadius;
    expect(driveForce(auto, 'D', 1, 0, 0, r).forceN).toBeCloseTo(auto.maxForceN);
    expect(driveForce(auto, 'D', 1, auto.topSpeedMps, 0, r).forceN).toBe(0);
    expect(driveForce(auto, 'N', 1, 0, 0, r).forceN).toBe(0);
    expect(driveForce(auto, 'D', 1, 10, 0, r).rpm).toBeLessThanOrEqual(auto.redlineRpm);
  });
});
