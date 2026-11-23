import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, expectBreach, loadShippedMap, runPlan, stepsLine, vehicleOf } from './drive.js';

const CAR = vehicleOf('car-sedan');
/** Inner lane (z 2) to the kerb lane (z 5) at x 260 to 300, on the dashed lane line, before the road works. */
const TO_KERB = stepsLine([[230, 2], [260, 2], [300, 5], [400, 5]]);
/** The same move on the solid lane line after x 460. */
const TO_INNER_SOLID = stepsLine([[430, 5], [460, 5], [500, 2], [560, 2]]);

describe('lane-change', () => {
  it('breaches a lane change on the dashed line with no indicator', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, TO_KERB, 8.33));
    await expectBreach(report, 'lane-change', { tier: 0 });
  });

  it('stays quiet on the same dashed-line change with the right indicator held', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const plan = constantPlan(map, CAR, TO_KERB, 8.33, { controls: [{ t: 0, indicators: 'right' }] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'lane-change')).toEqual([]);
  });

  it('breaches a lane change across a solid lane line even with the indicator on', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const plan = constantPlan(map, CAR, TO_INNER_SOLID, 8.33, { controls: [{ t: 0, indicators: 'left' }] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'lane-change', { tier: 0 });
  });

  it('breaches a lane change into the kerb lane with the NPC car about 3 m ahead in that lane', async () => {
    // The NPC car in the kerb lane is triggered as the car passes x 280; at 14 m/s the car closes
    // on it and moves over at x 420 to 450, when the NPC is a few metres ahead of its front.
    const map = loadShippedMap('tutorial-03-ban-dem');
    const line = stepsLine([[270, 2], [420, 2], [450, 5], [510, 5]]);
    const plan = constantPlan(map, CAR, line, 14, { lights: 'low', controls: [{ t: 0, indicators: 'right' }] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'lane-change', { tier: 1 });
  });

  it('stays quiet when the same move is made at 13.5 m/s, before the NPC car is close', async () => {
    const map = loadShippedMap('tutorial-03-ban-dem');
    const line = stepsLine([[270, 2], [400, 2], [430, 5], [490, 5]]);
    const plan = constantPlan(map, CAR, line, 13.5, { lights: 'low', controls: [{ t: 0, indicators: 'right' }] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'lane-change')).toEqual([]);
  });
});
