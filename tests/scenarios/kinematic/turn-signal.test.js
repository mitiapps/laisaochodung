import { describe, expect, it } from 'vitest';
import { loadShippedMap, planDrive, runPlan, breachesOf, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-02-nga-tu';

describe('turn-signal', () => {
  it('breaches a junction turn made with no indicator on', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan'), { turnSignals: false }));
    await expectBreach(report, 'turn-signal', { tier: 0 });
  });

  it('stays quiet when the indicator is on for every turn', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan')));
    expect(breachesOf(report, 'turn-signal')).toEqual([]);
  });
});
