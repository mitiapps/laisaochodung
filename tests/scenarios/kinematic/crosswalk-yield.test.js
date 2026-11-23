import { describe, expect, it } from 'vitest';
import { breachesOf, expectBreach, loadShippedMap, planDrive, runPlan, vehicleOf } from './drive.js';

const MAP = 'tutorial-01-co-ban';

describe('crosswalk-yield', () => {
  it('breaches driving onto the crosswalk while the pedestrian is on it', async () => {
    const map = loadShippedMap(MAP);
    const plan = planDrive(map, vehicleOf('car-sedan'), { ignore: ['crosswalk'] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'crosswalk-yield', { tier: 0 });
  });

  it('stays quiet when the car waits for the pedestrian to leave the crosswalk', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan')));
    expect(breachesOf(report, 'crosswalk-yield')).toEqual([]);
  });
});
