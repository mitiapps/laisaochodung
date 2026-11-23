import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, expectBreach, loadShippedMap, planDrive, runPlan, straightLine, vehicleOf } from './drive.js';

const MAP = 'tutorial-01-co-ban';
const CAR = vehicleOf('car-sedan');
/** On the inner lane of the P.127 40 km/h stretch (x 240 to 420). */
const STRETCH = straightLine(240, 400, 2);

describe('speeding', () => {
  it('breaches at 54 km/h on the 40 km/h stretch, in the 10 to 20 km/h band', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, CAR, { cruiseMps: 15 }));
    await expectBreach(report, 'speeding', { tier: 1 });
  });

  it('breaches in the 5 to 10 km/h band at 47 km/h', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, STRETCH, 47 / 3.6));
    await expectBreach(report, 'speeding', { tier: 0 });
  });

  it('breaches in the 20 to 35 km/h band at 65 km/h', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, STRETCH, 65 / 3.6));
    await expectBreach(report, 'speeding', { tier: 2 });
  });

  it('breaches above 35 km/h over the limit at 80 km/h', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, STRETCH, 80 / 3.6));
    await expectBreach(report, 'speeding', { tier: 3 });
  });

  it('stays quiet at 30 km/h on the same route', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, CAR));
    expect(breachesOf(report, 'speeding')).toEqual([]);
  });

  it('stays quiet at 45 km/h, under the 5 km/h margin of the 40 km/h stretch', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, STRETCH, 44 / 3.6));
    expect(breachesOf(report, 'speeding')).toEqual([]);
  });
});
