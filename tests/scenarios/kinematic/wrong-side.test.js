import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, stepsLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-01-co-ban';
const CAR = vehicleOf('car-sedan');

describe('wrong-side', () => {
  it('breaches moving into the opposing lane across the solid centre line', async () => {
    const map = loadShippedMap(MAP);
    const line = stepsLine([[160, 2], [175, -2], [190, -2], [205, 2], [215, 2]]);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, line, 8.33));
    await expectBreach(report, 'wrong-side', { tier: 0 });
  });

  it('stays quiet on a lawful overtake across the dashed centre line', async () => {
    const map = loadShippedMap(MAP);
    const line = stepsLine([[20, 2], [40, -2], [55, -2], [70, 2], [100, 2]]);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, line, 8.33));
    expect(breachesOf(report, 'wrong-side')).toEqual([]);
  });
});
