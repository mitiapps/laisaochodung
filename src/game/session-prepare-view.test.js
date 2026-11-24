import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createScorer } from '../scoring/index.js';
import { buildFrames } from '../testing/index.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createSession } from './session.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */
/** @typedef {import('./session.js').SessionDeps} SessionDeps */

/**
 * @param {string} rel Repo-relative path.
 * @returns {unknown} Parsed JSON.
 */
const json = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

const MAP = /** @type {GameMap} */ (json('tests/fixtures/map-minimal.json'));
const VEHICLES = /** @type {VehicleInfo[]} */ (json('data/vehicles/vehicles.json'));
const BUNDLE = /** @type {RulesBundle} */ (json('src/generated/rules.json'));
const CAR = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.id === 'car-sedan'));
const FRAMES = buildFrames({ map: MAP, vehicle: CAR, laneId: 'rw-e', startS: 5, durationS: 1, speed: 10 });

/**
 * A promise with its settle functions outside.
 * @returns {{promise: Promise<void>, resolve: () => void, reject: (err: Error) => void}} Deferred.
 */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  /** @type {(err: Error) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A session whose view is prepared by `prepareView`; it records the order of the calls.
 * @param {() => Promise<void>} prepareView View preparation.
 * @returns {{game: ReturnType<typeof createSession>, calls: string[], errors: unknown[]}} Harness.
 */
function harness(prepareView) {
  /** @type {string[]} */
  const calls = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {SessionDeps} */
  const deps = {
    vehicles: VEHICLES,
    loadMap: async () => structuredClone(MAP),
    loadRules: async () => BUNDLE,
    loadRapier: async () => ({}),
    createSim: () => {
      let i = 0;
      return {
        step: () => FRAMES[Math.min((i += 1) - 1, FRAMES.length - 1)],
        reset() {},
        dispose() {},
      };
    },
    createScorer,
    prepareView: async () => {
      calls.push('prepareView');
      await prepareView();
      calls.push('prepared');
    },
    createView: () => {
      calls.push('createView');
      return { renderer: { render() {}, resize() {}, dispose() {} }, dispose: () => calls.push('disposeView') };
    },
    createInput,
    createLoop,
    requestFrame: () => 1,
    cancelFrame() {},
    now: () => 0,
    keyTarget: new EventTarget(),
    logError: (_m, err) => errors.push(err),
  };
  return { game: createSession(deps), calls, errors };
}

describe('session view preparation', () => {
  it('waits for prepareView before it builds the view', async () => {
    const gate = deferred();
    const h = harness(() => gate.promise);
    const started = h.game.start('map-minimal', 'car-sedan');
    await Promise.resolve();
    expect(h.calls).toEqual(['prepareView']);
    gate.resolve();
    await started;
    expect(h.calls).toEqual(['prepareView', 'prepared', 'createView']);
    expect(h.game.debugInfo().status).toBe('running');
    h.game.quit();
    expect(h.errors).toEqual([]);
  });

  it('fails the start when prepareView fails, and builds no view', async () => {
    const h = harness(() => Promise.reject(new Error('renderer chunk failed')));
    await expect(h.game.start('map-minimal', 'car-sedan')).rejects.toThrow('renderer chunk failed');
    expect(h.calls).not.toContain('createView');
    expect(h.game.debugInfo().status).toBeNull();
  });

  it('builds no view for a start superseded while the view was being prepared', async () => {
    const first = deferred();
    let n = 0;
    const h = harness(() => (n++ === 0 ? first.promise : Promise.resolve()));
    const superseded = h.game.start('map-minimal', 'car-sedan');
    await Promise.resolve();
    await h.game.start('map-minimal', 'car-sedan');
    expect(h.calls.filter((c) => c === 'createView')).toHaveLength(1);
    first.resolve();
    await superseded;
    expect(h.calls.filter((c) => c === 'createView')).toHaveLength(1);
    h.game.quit();
    expect(h.errors).toEqual([]);
  });
});
