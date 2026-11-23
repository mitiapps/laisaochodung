import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-03-ban-dem';
const CAR = vehicleOf('car-sedan');

describe('following-distance', () => {
  it('breaches following the NPC car ahead at a 5 m gap at 30 km/h', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(40, 200, 2), 8.33, { lights: 'low' }));
    await expectBreach(report, 'following-distance', { tier: 0, clause: false });
  });

  it('stays quiet at a 45 m gap to the same car', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(0, 200, 2), 8.33, { lights: 'low' }));
    expect(breachesOf(report, 'following-distance')).toEqual([]);
  });

  it('stays quiet in a slow queue: 3.5 m behind the car at 4 m/s', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(41.5, 200, 2), 4, { lights: 'low' }));
    expect(breachesOf(report, 'following-distance')).toEqual([]);
  });
});
