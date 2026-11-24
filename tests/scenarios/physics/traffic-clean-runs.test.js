/**
 * The legal autopilot drives every map that carries traffic, through the real sim with traffic on:
 * it finishes in time, no contact with traffic costs it a point (each one is a notice), the
 * `osm-pasteur` kerb-lane merge draws no `lane-change` deduction, and the live report equals the
 * replay of the recorded frames, whole and windowed from a mid-run scorer state.
 *
 * The same runs with the Đơn giản assists, where the driver leaves the indicator to the
 * auto-cancel after each junction exit, draw no `turn-signal` breach, and the auto-cancel fires on
 * tutorial 02.
 *
 * The full sweep is 20 seeds per map with TRAFFIC_LONG=1; the default suite runs the first 2 to stay
 * fast.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createScorer, scoreRun } from '../../../src/scoring/index.js';
import { resolveControlPreset } from '../../../src/game/control-presets.js';
import { carSedan } from '../../../src/physics/vehicles/car-sedan.js';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { breachesOf, loadShippedMap } from '../kinematic/drive.js';
import { drivePhysics, initRapier } from './driver.js';

/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */
/** @typedef {Awaited<ReturnType<typeof drivePhysics>>} Run */

/** @type {import('../../../src/contracts/index.js').TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../../src/generated/traffic-params.json', import.meta.url), 'utf8'));
const MAPS = ['osm-pasteur', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem'];
const SEEDS = Array.from({ length: process.env.TRAFFIC_LONG ? 20 : 2 }, (_, i) => i + 1);
/** After a junction exit the driver leaves the indicator alone this far, metres, as the assists test does. */
const QUIET_AFTER_EXIT_M = 20;
const RUN_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await initRapier();
});

/**
 * Drives one map with traffic on.
 * @param {string} mapId Map id.
 * @param {number} seed Run seed.
 * @param {boolean} simple Đơn giản assists, with the indicator left to the auto-cancel after exits.
 * @returns {Promise<Run>} Run.
 */
async function drive(mapId, seed, simple) {
  const map = loadShippedMap(mapId);
  expect(map.traffic, `${mapId} carries a traffic block`).toBeDefined();
  /** @type {import('../../../src/contracts/index.js').SimOptions} */
  const sim = { traffic: 'map', runSeed: seed, params: PARAMS };
  if (!simple) return drivePhysics(map, 'car-sedan', { sim });
  const { simAssists } = resolveControlPreset('simple', await realBundle(), carSedan);
  return drivePhysics(map, 'car-sedan', { sim: { ...sim, assists: simAssists }, leaveIndicatorAfterExitM: QUIET_AFTER_EXIT_M });
}

/** Contact ticks with the same agent further apart than this start a new episode. */
const EPISODE_GAP_TICKS = 30;

/**
 * Contact episodes of a run with traffic agents: runs of collision ticks with one agent.
 * @param {Run} run Run.
 * @returns {Array<{otherId: string, first: number, last: number, t: number}>} Episodes.
 */
function trafficEpisodes(run) {
  /** @type {Array<{otherId: string, first: number, last: number, t: number}>} */
  const out = [];
  /** @type {Map<string, {otherId: string, first: number, last: number, t: number}>} */
  const open = new Map();
  for (const f of run.frames) {
    for (const e of f.events) {
      if (e.type !== 'collision' || !e.otherId?.startsWith('npc-')) continue;
      const ep = open.get(e.otherId);
      if (ep && f.tick - ep.last <= EPISODE_GAP_TICKS) ep.last = f.tick;
      else {
        const fresh = { otherId: e.otherId, first: f.tick, last: f.tick, t: f.t };
        open.set(e.otherId, fresh);
        out.push(fresh);
      }
    }
  }
  return out;
}

/**
 * Asserts the live report equals the replay over the kept frames from a mid-run scorer state, as
 * the session's windowed replay check folds it.
 * @param {string} mapId Map id.
 * @param {Run} run Run.
 */
async function expectWindowedReplay(mapId, run) {
  const bundle = await realBundle();
  const map = loadShippedMap(mapId);
  const scorer = createScorer(bundle, map, run.vehicle);
  const cut = Math.floor(run.frames.length / 2);
  let state = scorer.initial;
  for (const f of run.frames.slice(0, cut)) state = scorer.step(state, f).state;
  const windowed = scoreRun(bundle, map, run.vehicle, run.frames.slice(cut), { quit: false, initialState: state });
  expect(JSON.stringify(windowed)).toBe(JSON.stringify(run.live));
}

/**
 * Times the indicator went off with no command from the driver: the auto-cancel.
 * @param {Run} run Run.
 * @returns {number[]} Times.
 */
function autoCancels(run) {
  /** @type {number[]} */
  const out = [];
  run.frames.forEach((f, i) => {
    const prev = run.frames[i - 1];
    if (prev && prev.ego.indicators !== 'off' && f.ego.indicators === 'off' && f.ego.input.signalCmd === null) out.push(f.t);
  });
  return out;
}

describe.each(MAPS)('legal autopilot in traffic on %s', (mapId) => {
  it.each(SEEDS)('seed %i finishes in time, loses nothing to traffic, and replays equal', async (seed) => {
    const run = await drive(mapId, seed, false);
    const at = `${mapId} seed ${seed}`;
    expect(run.live.endedBy, `${at}: ended by (reached ${run.finalS.toFixed(0)} of ${run.total.toFixed(0)} m)`).toBe('finish');
    expect(run.frames.at(-1)?.t ?? Infinity).toBeLessThanOrEqual(loadShippedMap(mapId).route.timeLimitS);
    expect(breachesOf(run.live, 'crash'), `${at}: crash breaches`).toEqual([]);
    expect(run.live.breaches, `${at}: breaches`).toEqual([]);
    expect(run.live.score).toBe(10);
    // Each contact episode with an agent yields a notice inside the episode.
    for (const ep of trafficEpisodes(run)) {
      const covered = run.live.notices.some((n) => n.tick >= ep.first && n.tick <= ep.last);
      expect(covered, `${at}: contact with ${ep.otherId} at ${ep.t.toFixed(2)} s resolves to a notice`).toBe(true);
    }
    if (mapId === 'osm-pasteur') expect(breachesOf(run.live, 'lane-change'), `${at}: kerb-lane merge`).toEqual([]);
    expect(JSON.stringify(run.replay)).toBe(JSON.stringify(run.live));
    await expectWindowedReplay(mapId, run);
  }, RUN_TIMEOUT_MS);

  it.each(SEEDS)('seed %i with the Đơn giản assists draws no turn-signal breach', async (seed) => {
    const run = await drive(mapId, seed, true);
    expect(run.live.endedBy).toBe('finish');
    expect(breachesOf(run.live, 'turn-signal'), `${mapId} seed ${seed}`).toEqual([]);
    if (mapId === 'tutorial-02-nga-tu') expect(autoCancels(run).length, `${mapId} seed ${seed}: auto-cancels`).toBeGreaterThan(0);
  }, RUN_TIMEOUT_MS);
});
