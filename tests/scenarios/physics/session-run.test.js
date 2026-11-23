import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFrame } from '../../../src/contracts/assert-frame.js';
import { assertMap } from '../../../src/contracts/assert-map.js';
import { createLoop } from '../../../src/game/loop.js';
import { createSession } from '../../../src/game/session.js';
import { createScorer, scoreRun } from '../../../src/scoring/index.js';
import { createSim } from '../../../src/sim/index.js';
import { ROOT, realBundle } from '../../../scripts/rules/lib/test-support.js';
import { breachesOf, loadShippedMap } from '../kinematic/drive.js';
import { createDriver, initRapier } from './driver.js';

/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */

beforeAll(async () => {
  await initRapier();
});

/**
 * Manual animation frames: `tick(ms)` advances the clock and runs the pending callback.
 * @returns {{requestFrame: (cb: (ts: number) => void) => number, cancelFrame: () => void, now: () => number, tick: (ms: number) => void}} Clock.
 */
function fakeFrames() {
  let t = 0;
  /** @type {((ts: number) => void) | null} */
  let pending = null;
  return {
    requestFrame(cb) {
      pending = cb;
      return 1;
    },
    cancelFrame() {
      pending = null;
    },
    now: () => t,
    tick(ms) {
      t += ms;
      const cb = pending;
      pending = null;
      cb?.(t);
    },
  };
}

/**
 * Plays one run through the real session (dev checks on, so it runs its own replay check), with
 * the physics driver standing in for the keyboard.
 * @param {string} mapId Map id.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 * @param {import('./driver.js').PhysicsOptions} [options] Driver options.
 * @returns {Promise<{report: import('../../../src/contracts/index.js').ScoreReport, replayCheck: {equal: boolean, frames: number} | null}>}
 *   Session report and replay check.
 */
async function playInSession(mapId, vehicleId, options = {}) {
  const map = loadShippedMap(mapId);
  const driver = createDriver(map, vehicleId, options);
  const clock = fakeFrames();
  const vehicles = JSON.parse(readFileSync(path.join(ROOT, 'data', 'vehicles', 'vehicles.json'), 'utf8'));
  const bundle = await realBundle();
  /** @type {Frame | null} */
  let last = null;
  /** @type {import('../../../src/contracts/index.js').ScoreReport | null} */
  let report = null;
  const game = createSession({
    vehicles,
    loadMap: async () => map,
    loadRules: async () => bundle,
    loadRapier: async () => (await import('@dimforge/rapier3d-compat')).default,
    createSim: (R, m, v) => {
      const sim = createSim(R, m, v);
      return {
        ...sim,
        step(input) {
          last = sim.step(input);
          return last;
        },
      };
    },
    createScorer,
    createView: () => ({ renderer: { render() {}, resize() {}, dispose() {} }, dispose() {} }),
    createInput: () => ({
      sample: () => driver.next(last),
      setEnabled() {},
      setDriving() {},
      dispose() {},
    }),
    createLoop,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    now: clock.now,
    keyTarget: new EventTarget(),
    visibility: new EventTarget(),
    dev: true,
    assertFrame,
    assertMap,
    scoreRun,
    logError: (msg) => {
      throw new Error(msg);
    },
  });
  game.subscribe((state) => {
    if (state.runStatus === 'finished') report = state.report;
  });
  await game.start(mapId, vehicleId);
  for (let i = 0; i < 60 * (map.route.timeLimitS + 10) && !report; i += 1) clock.tick(1000 / 60);
  const replayCheck = game.debugInfo().replayCheck;
  game.dispose?.();
  if (!report) throw new Error('The session run did not finish');
  return { report, replayCheck };
}

describe('session runs with the physics driver', () => {
  it('a clean run finishes at 10 and the session replay check agrees with the live report', async () => {
    const { report, replayCheck } = await playInSession('tutorial-01-co-ban', 'car-sedan');
    expect(report.score).toBe(10);
    expect(report.endedBy).toBe('finish');
    expect(replayCheck?.equal).toBe(true);
  }, 300000);

  it('a breach run reports the breach and the session replay check agrees', async () => {
    const { report, replayCheck } = await playInSession('tutorial-02-nga-tu', 'car-sedan', { ignore: ['signal'] });
    expect(breachesOf(report, 'red-light').length).toBeGreaterThan(0);
    expect(replayCheck?.equal).toBe(true);
  }, 300000);
});
