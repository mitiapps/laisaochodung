import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, polyLine, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-02-nga-tu';
const CAR = vehicleOf('car-sedan');
/** Down the north-south priority road, left into the closed road at its west end. */
const INTO_CLOSED_ROAD = polyLine([[251.8, -200], [251.8, -251.8], [200, -251.8]]);

describe('no-entry', () => {
  it('breaches entering the closed road (P.101) in its banned heading', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, INTO_CLOSED_ROAD, 8.33));
    await expectBreach(report, 'no-entry', { tier: 0 });
  });

  it('stays quiet entering the same road in the other direction', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(130, 245, -248.3), 8.33));
    expect(breachesOf(report, 'no-entry')).toEqual([]);
  });
});
