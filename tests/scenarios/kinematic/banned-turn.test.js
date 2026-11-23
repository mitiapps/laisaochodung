import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, expectBreach, loadShippedMap, planDrive, polyLine, runPlan, straightLine, vehicleOf } from './drive.js';

const MAP = 'tutorial-02-nga-tu';
/** Straight from the start of tay to the junction, then north into bac: a left turn P.123a bans. */
const LEFT_TURN = [...straightLine(-185, 1.8, 1.75), ...straightLine(1.8, 1.8, -100).slice(1)];

/**
 * A U-turn through the junction: east on tay, a half circle of radius 1.75 m inside the junction,
 * then west on the other carriageway of tay. The banned manoeuvre of P.124a.
 * @returns {import('./drive.js').Vec2[]} Path.
 */
function uTurnPath() {
  const r = 1.75;
  const cx = -3.25;
  /** @type {import('./drive.js').Vec2[]} */
  const arc = [];
  for (let k = 0; k <= 40; k += 1) {
    const phi = (Math.PI * k) / 40;
    arc.push([cx + r * Math.sin(phi), r * Math.cos(phi)]);
  }
  return [...polyLine([[-185, 1.75], [cx, 1.75]]), ...arc.slice(1), ...polyLine([[cx, -1.75], [-100, -1.75]]).slice(1)];
}

describe('banned-turn', () => {
  it('breaches a left turn that the P.123a sign bans from the approach', async () => {
    const map = loadShippedMap(MAP);
    const plan = planDrive(map, vehicleOf('car-sedan'), { path: LEFT_TURN });
    const { report } = await runPlan(map, 'car-sedan', plan);
    await expectBreach(report, 'banned-turn', { tier: 0 });
  });

  it('breaches a U-turn that the P.124a sign bans from the approach', async () => {
    const map = loadShippedMap(MAP);
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, vehicleOf('car-sedan'), uTurnPath(), 4));
    await expectBreach(report, 'banned-turn', { tier: 1 });
  });

  it('stays quiet on the straight run through the same junction', async () => {
    const map = loadShippedMap(MAP);
    const plan = planDrive(map, vehicleOf('car-sedan'), { path: straightLine(-185, 100, 1.75) });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'banned-turn')).toEqual([]);
  });
});
