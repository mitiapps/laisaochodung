import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-03-ban-dem';
const CAR = vehicleOf('car-sedan');

describe('high-beam', () => {
  it('breaches holding the high beam toward oncoming traffic in a lit built-up zone', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), 8.33, { lights: 'high' }));
    await expectBreach(report, 'high-beam', { tier: 0 });
  });

  it('stays quiet on the low beam past the same oncoming cars', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), 8.33, { lights: 'low' }));
    expect(breachesOf(report, 'high-beam')).toEqual([]);
  });
});
