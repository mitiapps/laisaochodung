import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFrame } from '../contracts/assert-frame.js';
import { assertMap } from '../contracts/assert-map.js';
import { createScorer, scoreRun } from '../scoring/index.js';
import { createSim } from '../sim/index.js';
import { buildFrames } from '../testing/index.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createSession } from './session.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').HudState} HudState */
/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */

/**
 * @param {string} rel Repo-relative path.
 * @returns {unknown} Parsed JSON.
 */
const json = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

const MAP = /** @type {GameMap} */ (json('tests/fixtures/map-minimal.json'));
const VEHICLES = /** @type {VehicleInfo[]} */ (json('data/vehicles/vehicles.json'));
const BUNDLE = /** @type {RulesBundle} */ (json('src/generated/rules.json'));
const CAR = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.id === 'car-sedan'));

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * Manual animation frames: each `tick(ms)` advances the clock and runs the scheduled callback.
 * @returns {{requestFrame: (cb: (ts: number) => void) => number, cancelFrame: (h: number) => void, now: () => number, tick: (ms: number) => void}} Fake.
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
 * A sim that replays frames and then appends `timeout` to the last one.
 * @param {Frame[]} frames Frames.
 * @returns {import('../contracts/index.js').Sim & {disposed: () => boolean}} Stub.
 */
function replaySim(frames) {
  let i = 0;
  let disposed = false;
  return {
    step() {
      const f = frames[Math.min(i, frames.length - 1)];
      i += 1;
      return i === frames.length ? { ...f, events: [...f.events, { type: 'timeout' }] } : f;
    },
    reset() {},
    dispose() {
      disposed = true;
    },
    disposed: () => disposed,
  };
}

/**
 * Session with stub collaborators; overrides replace any of them.
 * @param {Partial<import('./session.js').SessionDeps>} [over] Overrides.
 * @returns {{game: ReturnType<typeof createSession>, frames: ReturnType<typeof fakeFrames>, states: HudState[], keys: EventTarget, renders: number[], visibility: EventTarget & {visibilityState: string}, errors: unknown[]}} Harness.
 */
function harness(over = {}) {
  const frames = fakeFrames();
  /** @type {HudState[]} */
  const states = [];
  /** @type {number[]} */
  const renders = [];
  /** @type {unknown[]} */
  const errors = [];
  const keys = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const kinematic = buildFrames({ map: MAP, vehicle: CAR, laneId: 'rw-e', startS: 5, durationS: 1, speed: 10 });
  const game = createSession({
    vehicles: VEHICLES,
    loadMap: async () => structuredClone(MAP),
    loadRules: async () => BUNDLE,
    loadRapier: async () => RAPIER,
    createSim: () => replaySim(kinematic),
    createScorer,
    createView: () => ({ renderer: { render: (_p, f) => renders.push(f.tick), resize() {}, dispose() {} }, dispose() {} }),
    createInput,
    createLoop,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    now: frames.now,
    keyTarget: keys,
    visibility,
    logError: (_m, err) => errors.push(err),
    ...over,
  });
  game.subscribe((s) => states.push(s));
  return { game, frames, states, keys, renders, visibility, errors };
}

/**
 * Runs animation frames of ~1/60 s until the predicate holds.
 * @param {ReturnType<typeof fakeFrames>} frames Fake frames.
 * @param {() => boolean} done Stop condition.
 * @param {number} [max] Frame limit.
 */
function runUntil(frames, done, max = 2000) {
  for (let i = 0; i < max && !done(); i += 1) frames.tick(1000 / 60);
}

describe('session', () => {
  it('ends on a timeout event from the sim, with the report from the scorer', async () => {
    const h = harness();
    await h.game.start('map-minimal', 'car-sedan');
    expect(h.states.map((s) => s.runStatus).slice(0, 2)).toEqual(['ready', 'running']);
    runUntil(h.frames, () => h.states.at(-1)?.runStatus === 'finished');
    const end = h.states.at(-1);
    expect(end?.runStatus).toBe('finished');
    expect(end?.report?.endedBy).toBe('timeout');
    expect(end?.report?.finished).toBe(false);
    expect(h.renders.at(-1)).toBe(59);
    expect(h.errors).toEqual([]);
  });

  it('ends on runEnded: crash from the scorer', async () => {
    /** @type {import('../contracts/index.js').CreateScorer} */
    const crashScorer = (b, m, v) => {
      const real = createScorer(b, m, v);
      let n = 0;
      return {
        initial: real.initial,
        step(state, frame) {
          n += 1;
          const res = real.step(state, frame);
          return n >= 10 ? { ...res, runEnded: 'crash' } : res;
        },
        report: (state, o) => ({ ...real.report(state, o), endedBy: 'crash' }),
      };
    };
    const h = harness({ createScorer: crashScorer });
    await h.game.start('map-minimal', 'car-sedan');
    runUntil(h.frames, () => h.states.at(-1)?.runStatus === 'finished');
    expect(h.states.at(-1)?.report?.endedBy).toBe('crash');
    expect(h.renders.at(-1)).toBe(9);
  });

  it('quits with endedBy quit, pauses and resumes from the pause key and on a hidden tab', async () => {
    const h = harness();
    await h.game.start('map-minimal', 'car-sedan');
    h.frames.tick(0);
    h.frames.tick(1000 / 60);
    const esc = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape', repeat: false });
    h.keys.dispatchEvent(esc);
    expect(h.states.at(-1)?.runStatus).toBe('paused');
    expect(esc.defaultPrevented).toBe(true);
    const tick = h.renders.at(-1);
    h.frames.tick(1000);
    expect(h.renders.at(-1)).toBe(tick);
    h.keys.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyP', repeat: false }));
    expect(h.states.at(-1)?.runStatus).toBe('running');
    h.visibility.visibilityState = 'hidden';
    h.visibility.dispatchEvent(new Event('visibilitychange'));
    expect(h.states.at(-1)?.runStatus).toBe('paused');
    h.game.quit();
    expect(h.states.at(-1)?.runStatus).toBe('finished');
    expect(h.states.at(-1)?.report?.endedBy).toBe('quit');
    h.game.quit();
    expect(h.states.filter((s) => s.runStatus === 'finished')).toHaveLength(1);
  });

  it('does not replay a finished state to a new subscriber, and supersedes a pending start', async () => {
    const h = harness();
    await h.game.start('map-minimal', 'car-sedan');
    h.game.quit();
    /** @type {HudState[]} */
    const late = [];
    h.game.subscribe((s) => late.push(s));
    expect(late).toEqual([]);
    const first = h.game.start('map-minimal', 'car-sedan');
    h.game.quit(); // quit while loading cancels the load
    await first;
    expect(h.game.debugInfo().status).toBeNull();
    await h.game.start('map-minimal', 'scooter');
    expect(late.map((s) => s.runStatus)).toEqual(['ready', 'running']);
  });

  it('rejects bad ids and load failures, and stays usable', async () => {
    const h = harness({ loadMap: async () => Promise.reject(new Error('HTTP 404')) });
    await expect(h.game.start('../secret', 'car-sedan')).rejects.toThrow(/Invalid map id/);
    await expect(h.game.start('map-minimal', 'tank')).rejects.toThrow(/Unknown vehicle/);
    await expect(h.game.start('map-minimal', 'car-sedan')).rejects.toThrow(/404/);
    expect(h.game.debugInfo().status).toBeNull();
  });

  it('publishes a breach at once and keeps it in the toasts', async () => {
    const speeding = buildFrames({ map: MAP, vehicle: CAR, laneId: 'rw-e', startS: 5, durationS: 3, speed: 70 / 3.6 });
    const h = harness({ createSim: () => replaySim(speeding) });
    await h.game.start('map-minimal', 'car-sedan');
    runUntil(h.frames, () => h.states.some((s) => s.toasts.length > 0));
    const withToast = h.states.find((s) => s.toasts.length > 0);
    expect(withToast?.toasts[0].ruleId).toBe('speeding');
    expect(withToast?.speedLimitKmh).toBe(50);
    expect(withToast?.speedLimitVerified).toBe(true);
    h.game.quit();
  });
});

describe('session with the real sim (dev build checks)', () => {
  it('drives the minimal map, and the live report equals scoreRun over the kept frames', async () => {
    const h = harness({ createSim, dev: true, assertFrame, assertMap, scoreRun });
    await h.game.start('map-minimal', 'car-sedan');
    const down = (/** @type {string} */ code) => h.keys.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code, repeat: false }));
    down('KeyE'); // N → 1
    down('KeyW');
    h.frames.tick(0);
    for (let i = 0; i < 180; i += 1) h.frames.tick(1000 / 60);
    const running = h.states.at(-1);
    expect(running?.speedKmh).toBeGreaterThan(5);
    expect(running?.gear).not.toBe('N');
    expect(running?.controls.throttle).toBe(1);
    expect(running?.controls.brakeFront).toBe(0);
    const live = h.game.debugInfo();
    expect(live.actors.map((a) => a.kind).sort()).toEqual(['car', 'pedestrian']);
    expect(live.actors.every((a) => Number.isFinite(a.x) && Number.isFinite(a.z))).toBe(true);
    h.game.quit();
    const info = h.game.debugInfo();
    expect(info.replayCheck?.equal).toBe(true);
    expect(info.replayCheck?.frames).toBeGreaterThan(150);
    expect(h.errors).toEqual([]);
  });
});
