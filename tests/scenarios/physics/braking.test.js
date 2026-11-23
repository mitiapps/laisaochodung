import { beforeAll, describe, expect, it } from 'vitest';
import { kmhToMps } from '../../../src/contracts/units.js';
import { createBench, brakeToStop } from '../../../src/physics/bench.js';
import { vehicleTuning } from '../../../src/physics/vehicles/index.js';
import { initRapier } from './driver.js';

let R;
beforeAll(async () => {
  R = await initRapier();
});

describe('braking on a dry bench', () => {
  it('stops the sedan from 50 km/h in 11 to 16 m with the brakes held full', () => {
    const bench = createBench(R, vehicleTuning('car-sedan'), 1);
    const { distance, fell, backwardM } = brakeToStop(bench, kmhToMps(50), { brakeFront: 1, brakeRear: 1 });
    expect(fell).toBe(false);
    expect(distance).toBeGreaterThanOrEqual(11);
    expect(distance).toBeLessThanOrEqual(16);
    expect(backwardM).toBeLessThan(0.5);
  });
});
