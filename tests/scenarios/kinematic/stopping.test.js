import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, expectBreach, loadShippedMap, runPlan, straightLine, vehicleOf } from './drive.js';

const CAR = vehicleOf('car-sedan');
const V = 8.33;

/**
 * Constant speed from `x0`, then a sudden halt of `seconds` at `xStop`.
 * @param {number} x0 Start x.
 * @param {number} xStop Where the car stops.
 * @param {number} seconds Stop length.
 * @returns {Array<{t: number, value: number}>} Speed keyframes.
 */
function haltAt(x0, xStop, seconds) {
  const tStop = (xStop - x0) / V;
  return [
    { t: 0, value: V },
    { t: tStop, value: V },
    { t: tStop + 0.2, value: 0 },
    { t: tStop + 0.2 + seconds, value: 0 },
    { t: tStop + 0.4 + seconds, value: V },
  ];
}

describe('stopping', () => {
  it('breaches a stop in a junction that no light or sign requires', async () => {
    const map = loadShippedMap('tutorial-02-nga-tu');
    const line = straightLine(-20, 60, 1.75);
    const plan = constantPlan(map, CAR, line, V, { speedAt: haltAt(-20, 0, 6) });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'stopping', { tier: 0 });
  });

  it('breaches a stop on the pedestrian crossing', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const line = straightLine(20, 200, 2);
    const plan = constantPlan(map, CAR, line, V, { speedAt: haltAt(20, 120, 6) });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'stopping', { tier: 2 });
  });

  it('breaches a stop inside a P.130 no-stopping zone', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const line = straightLine(440, 560, 5);
    const plan = constantPlan(map, CAR, line, V, { speedAt: haltAt(440, 470, 6) });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'stopping', { tier: 2 });
  });

  it('stays quiet for the same stop on a plain stretch of road', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const line = straightLine(20, 200, 2);
    const plan = constantPlan(map, CAR, line, V, { speedAt: haltAt(20, 60, 6) });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'stopping')).toEqual([]);
  });
});
