import { describe, expect, it } from 'vitest';
import { AUTO_SHIFT_STANDSTILL_MPS, autoShiftRatio, driveForce, initialGear, shiftGear } from './gearbox.js';
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

describe('auto-shift selector', () => {
  const sel = { autoShift: true };
  const r = carSedan.wheelRadius;
  const { upRpm, downRpm, minIntervalS } = manual.autoShift;
  const RPM_PER_RAD_S = 60 / (2 * Math.PI);
  /**
   * Wheel spin at which a gear turns at an engine speed.
   * @param {number} gear Gear 1–5.
   * @param {number} rpm Engine speed.
   * @returns {number} Spin in rad/s.
   */
  const spinAt = (gear, rpm) => rpm / RPM_PER_RAD_S / (manual.ratios[gear - 1] * manual.finalDrive);

  it('starts in D and walks R ← N ← D, refusing R when moving', () => {
    expect(initialGear(manual, sel)).toBe('D');
    expect(shiftGear(manual, 'D', 'down', 0, sel)).toBe('N');
    expect(shiftGear(manual, 'N', 'down', 0, sel)).toBe('R');
    expect(shiftGear(manual, 'R', 'down', 0, sel)).toBe('R');
    expect(shiftGear(manual, 'R', 'up', 0, sel)).toBe('N');
    expect(shiftGear(manual, 'N', 'up', 0, sel)).toBe('D');
    expect(shiftGear(manual, 'D', 'up', 20, sel)).toBe('D');
    expect(shiftGear(manual, 'N', 'down', 2 / 3.6, sel)).toBe('N');
    expect(shiftGear(manual, 'N', 'down', -5, sel)).toBe('N');
    expect(() => shiftGear(manual, 3, 'up', 0, sel)).toThrow(RangeError);
  });

  it('leaves the automatic scooter and the plain manual alone', () => {
    expect(initialGear(auto, sel)).toBe('D');
    expect(shiftGear(auto, 'D', 'down', 0, sel)).toBe('N');
    expect(shiftGear(auto, 'N', 'down', 0, sel)).toBe('N');
    expect(initialGear(manual, {})).toBe('N');
    expect(shiftGear(manual, 'N', 'up', 0, {})).toBe(1);
  });

  it('shifts up one gear at upRpm with the throttle open, never within minIntervalS', () => {
    const at = (/** @type {number} */ gear, /** @type {number} */ rpm, throttle = 1, sinceShiftS = 5) => {
      const wheelSpin = spinAt(gear, rpm);
      return autoShiftRatio(manual, gear, { throttle, speedMps: wheelSpin * r, wheelSpin, sinceShiftS });
    };
    expect(at(1, upRpm)).toBe(2);
    expect(at(1, upRpm - 1)).toBe(1);
    expect(at(1, upRpm, 0)).toBe(1);
    expect(at(1, upRpm, 1, minIntervalS - 0.01)).toBe(1);
    expect(at(5, 6000)).toBe(5);
    expect(at(3, (upRpm + downRpm) / 2)).toBe(3);
  });

  it('shifts down to the highest gear above downRpm, landing below upRpm', () => {
    for (let g = 2; g <= 5; g += 1) {
      for (let rpm = 50; rpm < downRpm; rpm += 50) {
        const wheelSpin = spinAt(g, rpm);
        const next = autoShiftRatio(manual, g, { throttle: 0, speedMps: Math.max(1, wheelSpin * r), wheelSpin, sinceShiftS: 5 });
        expect(next).toBeLessThan(g);
        const after = wheelSpin * manual.ratios[next - 1] * manual.finalDrive * RPM_PER_RAD_S;
        expect(after).toBeLessThan(upRpm);
        if (next > 1) expect(after).toBeGreaterThan(downRpm);
      }
    }
    // Every up-shift lands above downRpm, so an up-shift cannot trigger a down-shift.
    for (let g = 1; g < 5; g += 1) expect((upRpm * manual.ratios[g]) / manual.ratios[g - 1]).toBeGreaterThan(downRpm);
  });

  it('engages 1 at once near standstill and rejects a ratio that does not exist', () => {
    const still = { throttle: 1, speedMps: AUTO_SHIFT_STANDSTILL_MPS / 2, wheelSpin: 0, sinceShiftS: 0 };
    expect(autoShiftRatio(manual, 4, still)).toBe(1);
    expect(() => autoShiftRatio(manual, 0, still)).toThrow(RangeError);
    expect(() => autoShiftRatio(manual, 6, still)).toThrow(RangeError);
    expect(() => autoShiftRatio(manual, 1.5, still)).toThrow(RangeError);
  });
});
