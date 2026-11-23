import { describe, expect, it } from 'vitest';
import { breachesOf, expectBreach, loadShippedMap, planDrive, runPlan, vehicleOf } from './drive.js';

const MAP = 'tutorial-02-nga-tu';

describe('stop-sign', () => {
  it('breaches when the car crosses the R.122 STOP line without stopping', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan'), { ignore: ['stop-sign'] }));
    await expectBreach(report, 'stop-sign', { tier: 0 });
  });

  it('stays quiet when the car stops at the STOP line', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan')));
    expect(breachesOf(report, 'stop-sign')).toEqual([]);
  });
});
