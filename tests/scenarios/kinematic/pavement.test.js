import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-01-co-ban';
const CAR = vehicleOf('car-sedan');

describe('pavement', () => {
  it('breaches driving with the body centre on the pavement', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(250, 300, 8), 8.33));
    await expectBreach(report, 'pavement', { tier: 0 });
  });

  it('stays quiet in the kerb lane beside the same stretch', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(250, 300, 5), 8.33));
    expect(breachesOf(report, 'pavement')).toEqual([]);
  });
});
