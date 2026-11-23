import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-02-nga-tu';
const CAR = vehicleOf('car-sedan');

describe('wrong-way', () => {
  it('breaches driving west against the one-way street', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(485, 260, -248.3), 8.33));
    await expectBreach(report, 'wrong-way', { tier: 0 });
  });

  it('stays quiet driving east with the one-way street', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(260, 485, -248.3), 8.33));
    expect(breachesOf(report, 'wrong-way')).toEqual([]);
  });
});
