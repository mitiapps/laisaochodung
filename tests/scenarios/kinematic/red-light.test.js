import { describe, expect, it } from 'vitest';
import { breachesOf, expectBreach, loadShippedMap, planDrive, runPlan, vehicleOf } from './drive.js';

const MAP = 'tutorial-02-nga-tu';

describe('red-light', () => {
  it('breaches when the car drives on through the red signal into the junction', async () => {
    const map = loadShippedMap(MAP);
    const plan = planDrive(map, vehicleOf('car-sedan'), { ignore: ['signal'] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'red-light', { tier: 1 });
  });

  it('stays quiet when the planned car halts at the red light and goes on green', async () => {
    const map = loadShippedMap(MAP);
    const plan = planDrive(map, vehicleOf('car-sedan'));
    const { report, frames } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'red-light')).toEqual([]);
    const halted = frames.filter((f) => f.ego.speed < 0.05 && f.ego.pos.x > -25 && f.ego.pos.x < -10 && f.ego.pos.z > 0);
    expect(halted.length).toBeGreaterThan(30);
  });
});
