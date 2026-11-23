import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf, expectBreach } from './drive.js';

const MAP = 'tutorial-03-ban-dem';
const CAR = vehicleOf('car-sedan');

describe('headlights', () => {
  it('breaches driving at night in the rain with the lights off', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), 8.33, { lights: 'off' }));
    await expectBreach(report, 'headlights', { tier: 0 });
  });

  it('stays quiet with the low beam on', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), 8.33, { lights: 'low' }));
    expect(breachesOf(report, 'headlights')).toEqual([]);
  });
});
