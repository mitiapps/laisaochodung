import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-03-ban-dem';
const CAR = vehicleOf('car-sedan');

describe('night-horn', () => {
  it('breaches sounding the horn in the built-up zone at night', async () => {
    const map = loadShippedMap(MAP);
    const controls = [{ t: 5, horn: true }, { t: 7, horn: false }];
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), 8.33, { lights: 'low', controls }));
    await expectBreach(report, 'night-horn', { tier: 0 });
  });

  it('stays quiet with the horn silent', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), 8.33, { lights: 'low' }));
    expect(breachesOf(report, 'night-horn')).toEqual([]);
  });
});
