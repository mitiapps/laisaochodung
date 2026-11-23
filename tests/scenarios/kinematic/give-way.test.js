import { describe, expect, it } from 'vitest';
import { loadShippedMap, planDrive, runPlan, breachesOf, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-02-nga-tu';

describe('give-way', () => {
  it('breaches when the car enters the priority road at speed', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan'), { ignore: ['give-way'] }));
    await expectBreach(report, 'give-way', { tier: 0 });
  });

  it('stays quiet when the car slows to give way before the line', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan')));
    expect(breachesOf(report, 'give-way')).toEqual([]);
  });
});
