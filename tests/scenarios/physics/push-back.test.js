import { beforeAll, describe, expect, it } from 'vitest';
import { DT } from '../../../src/contracts/units.js';
import { createInput } from '../../../src/game/input.js';
import { scoreRun } from '../../../src/scoring/scorer.js';
import { createSim } from '../../../src/sim/index.js';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { initRapier } from './driver.js';
import { loadShippedMap, vehicleOf } from '../kinematic/drive.js';

/**
 * The scooter's push-back on the real sim, input and scorer: backing out, straight or on full lock,
 * across a dashed or a solid lane line or inside a junction, is never a breach. Tutorial 02's
 * one-way `mot-chieu` runs east with two lanes: `f0` centred on z = −248.25, `f1` on z = −251.75,
 * the line between them at z = −250, dashed to x = 460 and solid from there to the stop line.
 */

/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */

let R;
beforeAll(async () => {
  R = await initRapier();
});

/**
 * Keyboard event on a target, as the browser delivers it.
 * @param {EventTarget} target Target.
 * @param {'keydown' | 'keyup'} type Type.
 * @param {string} code Key code.
 */
function key(target, type, code) {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false }));
}

/**
 * Starts the scooter at rest at a pose on tutorial 02, holds R (and A for full left lock when
 * asked) until `until` holds or `maxS` passes, then releases and lets the feet stop it.
 * @param {{x: number, z: number, heading: number}} pose Start pose.
 * @param {{lock: boolean, maxS: number, until?: (f: Frame) => boolean}} how Push.
 * @returns {Promise<{frames: Frame[], report: import('../../../src/contracts/index.js').ScoreReport, reached: boolean}>}
 *   Frames, the replayed report, and whether `until` held.
 */
async function pushBack(pose, { lock, maxS, until = () => false }) {
  const map = structuredClone(loadShippedMap('tutorial-02-nga-tu'));
  map.route.start = { pos: { x: pose.x, z: pose.z }, heading: pose.heading };
  const veh = vehicleOf('scooter');
  const sim = createSim(R, map, veh);
  const target = new EventTarget();
  const input = createInput({ legalClass: 'motorbike', surfaceGrip: map.environment.surfaceGrip, target, onPause: () => {} });
  input.setEnabled(true);
  input.setDriving(true);
  /** @type {Frame[]} */
  const frames = [];
  let reached = false;
  try {
    key(target, 'keydown', 'KeyR');
    if (lock) key(target, 'keydown', 'KeyA');
    for (let k = 0; k < Math.round(maxS / DT); k += 1) {
      const f = sim.step(input.sample());
      frames.push(f);
      if (until(f)) {
        reached = true;
        break;
      }
    }
    key(target, 'keyup', 'KeyR');
    if (lock) key(target, 'keyup', 'KeyA');
    for (let k = 0; k < Math.round(1 / DT); k += 1) frames.push(sim.step(input.sample()));
  } finally {
    input.dispose();
    if (typeof sim.dispose === 'function') sim.dispose();
  }
  const report = scoreRun(await realBundle(), map, veh, frames, { quit: false });
  return { frames, report, reached };
}

describe('scooter push-back on tutorial 02', () => {
  it('backs 3 m in its lane on the one-way road with no breach, then stands still', async () => {
    const x0 = 350;
    const { frames, report, reached } = await pushBack({ x: x0, z: -248.25, heading: 0 }, { lock: false, maxS: 8, until: (f) => f.ego.pos.x <= x0 - 3 });
    expect(reached).toBe(true);
    expect(frames.some((f) => f.ego.gear === 'R')).toBe(true);
    expect(Math.min(...frames.map((f) => f.ego.speed))).toBeGreaterThanOrEqual(-0.8);
    expect(Math.abs(frames.at(-1)?.ego.speed ?? 1)).toBeLessThan(0.02);
    expect(report.breaches).toEqual([]);
  }, 30_000);

  for (const [kind, x0] of /** @type {const} */ ([
    ['dashed', 350],
    ['solid', 475],
  ])) {
    it(`backs on full lock across the ${kind} lane line, with no indicator, with no breach`, async () => {
      // Full left lock swings the tail left (north, −z) towards the line from f0.
      const { frames, report, reached } = await pushBack({ x: x0, z: -248.8, heading: 0 }, { lock: true, maxS: 6, until: (f) => f.ego.pos.z < -250.3 });
      expect(reached).toBe(true);
      expect(frames.every((f) => f.ego.indicators === 'off')).toBe(true);
      expect(report.breaches).toEqual([]);
    }, 30_000);
  }

  it('backs on full lock inside the signalised junction j1 with no turn-signal, banned-turn or other breach', async () => {
    const { frames, report } = await pushBack({ x: 0, z: 0, heading: 0 }, { lock: true, maxS: 3 });
    // The heading swings by a turn's worth while backing.
    const swing = Math.abs((frames.at(-1)?.ego.heading ?? 0) - frames[0].ego.heading);
    expect(swing).toBeGreaterThan(0.5);
    expect(report.breaches).toEqual([]);
  }, 30_000);
});
