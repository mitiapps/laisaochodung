/**
 * Driving assists on the real sim: the car's auto-shift selector, the scooter's combined brake
 * share, and the indicator auto-cancel scored with the real scorer.
 *
 * The turn runs use the scenario driver, which keeps the indicator on until 15 m past a junction
 * exit and switches it back on if it finds it off before then. A player relying on the auto-cancel
 * does not do that, so the loop here drops the driver's indicator commands for `QUIET_AFTER_EXIT_M`
 * after each junction exit and leaves the switching off to the assist.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DT, kmhToMps } from '../../../src/contracts/units.js';
import { createSim } from '../../../src/sim/index.js';
import { createScorer } from '../../../src/scoring/index.js';
import { locate } from '../../../src/map-query/index.js';
import { projectOntoPolyline } from '../../../src/geometry/index.js';
import { SCOOTER_FRONT_BRAKE_PER_GRIP } from '../../../src/game/input.js';
import { carSedan } from '../../../src/physics/vehicles/car-sedan.js';
import { scooter } from '../../../src/physics/vehicles/scooter.js';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { breachesOf, loadShippedMap, routePath, vehicleOf } from '../kinematic/drive.js';
import { createDriver, initRapier } from './driver.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */
/** @typedef {import('../../../src/contracts/index.js').ControlInput} ControlInput */
/** @typedef {import('../../../src/contracts/index.js').ControlAssists} ControlAssists */
/** @typedef {import('../../../src/contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../../../src/physics/tuning.js').ManualGearboxSpec} ManualGearboxSpec */

/** @type {GameMap} */
const MINIMAL = JSON.parse(readFileSync(new URL('../../fixtures/map-minimal.json', import.meta.url), 'utf8'));
/** @type {GameMap} */
const JUNCTION = JSON.parse(readFileSync(new URL('../../fixtures/map-junction.json', import.meta.url), 'utf8'));

const GEARBOX = /** @type {ManualGearboxSpec} */ (carSedan.gearbox);
const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** The `turn-signal` rule's thresholds, as the session passes them. */
const CANCEL = { turnMinDeg: 45, clearM: 30 };
/** @type {ControlAssists} */
const CANCEL_ONLY = { autoGearbox: false, signalAutoCancel: CANCEL };
/** @type {ControlAssists} */
const ALL_ON = { autoGearbox: true, signalAutoCancel: CANCEL };
const QUIET_AFTER_EXIT_M = 20;
/** Manual shift points of the scenario driver (`driver.js`), up from gears 1–4. */
const DRIVER_SHIFT_UP_KMH = [15, 30, 45, 60];

let R;
beforeAll(async () => {
  R = await initRapier();
});

/**
 * Steering that holds the lane centre `z` heading east on the straight fixtures.
 * @param {Frame | null} f Last frame.
 * @param {number} [z] Lane centre.
 * @returns {number} Steer.
 */
function holdLane(f, z = 1.75) {
  if (!f) return 0;
  return Math.max(-1, Math.min(1, -0.3 * (z - f.ego.pos.z) + 2 * f.ego.heading));
}

/**
 * The engaged ratio behind the selector, recovered from the frame: rpm over the driven-wheel spin.
 * @param {Frame} f Frame.
 * @returns {number} Gear 1–5.
 */
function impliedRatio(f) {
  const spin = (f.ego.wheels[2].spin + f.ego.wheels[3].spin) / 2;
  const overall = f.ego.rpm / RPM_PER_RAD_S / spin / GEARBOX.finalDrive;
  let best = 1;
  GEARBOX.ratios.forEach((r, i) => {
    if (Math.abs(r - overall) < Math.abs(GEARBOX.ratios[best - 1] - overall)) best = i + 1;
  });
  return best;
}

/**
 * Full throttle on map-minimal until 60 km/h.
 * @param {boolean} autoGearbox Selector with auto-shift, else the driver's manual schedule.
 * @returns {{t: number, frames: Frame[]}} Time to 60 km/h and the frames.
 */
function launchTo60(autoGearbox) {
  const sim = createSim(R, MINIMAL, vehicleOf('car-sedan'), { assists: { autoGearbox, signalAutoCancel: null } });
  /** @type {Frame[]} */
  const frames = [];
  /** @type {Frame | null} */
  let f = null;
  let lastShiftT = -10;
  for (let k = 0; k < 60 * 20; k += 1) {
    /** @type {Partial<ControlInput>} */
    const input = { throttle: 1, steer: holdLane(f), gearCmd: k === 0 ? 'up' : null };
    if (!autoGearbox && f && typeof f.ego.gear === 'number' && f.t - lastShiftT > 0.6) {
      const g = f.ego.gear;
      if (g < 5 && f.ego.speed * 3.6 > DRIVER_SHIFT_UP_KMH[g - 1] + 2) {
        input.gearCmd = 'up';
        lastShiftT = f.t;
      }
    }
    f = sim.step(input);
    frames.push(f);
    if (f.ego.speed >= kmhToMps(60)) break;
  }
  sim.dispose();
  return { t: /** @type {Frame} */ (f).t, frames };
}

/**
 * Times of the ratio changes in a run, from the implied ratio of frames above 1 m/s.
 * @param {Frame[]} frames Frames.
 * @returns {Array<{t: number, from: number, to: number}>} Shifts.
 */
function shiftsOf(frames) {
  /** @type {Array<{t: number, from: number, to: number}>} */
  const out = [];
  /** @type {number | null} */
  let last = null;
  for (const f of frames) {
    if (f.ego.speed < 1 || f.ego.rpm <= GEARBOX.idleRpm) continue;
    const g = impliedRatio(f);
    if (last !== null && g !== last) out.push({ t: f.t, from: last, to: g });
    last = g;
  }
  return out;
}

describe('auto-shift selector on the sedan', () => {
  it('reaches 60 km/h within 10% of the manual shift schedule, showing D throughout', () => {
    const manual = launchTo60(false);
    const auto = launchTo60(true);
    console.log(`0–60 km/h: manual ${manual.t.toFixed(2)} s, auto-shift ${auto.t.toFixed(2)} s`);
    expect(Math.abs(auto.t - manual.t) / manual.t).toBeLessThanOrEqual(0.1);
    expect(new Set(auto.frames.map((f) => f.ego.gear))).toEqual(new Set(['D']));
    const shifts = shiftsOf(auto.frames);
    const kmhAt = (/** @type {number} */ t) => ((auto.frames.find((f) => f.t >= t)?.ego.speed ?? 0) * 3.6).toFixed(1);
    console.log(`auto up-shifts at ${shifts.map((x) => `${kmhAt(x.t)} km/h`).join(', ')}`);
    // Up one gear at a time from 1st; 5th may engage just before 60 km/h.
    expect(shifts.map((s) => s.to).slice(0, 3)).toEqual([2, 3, 4]);
    expect(shifts.every((s) => s.to === s.from + 1)).toBe(true);
    for (let i = 1; i < shifts.length; i += 1) {
      expect(shifts[i].t - shifts[i - 1].t).toBeGreaterThanOrEqual(GEARBOX.autoShift.minIntervalS);
    }
  });

  it.each([30, 50])('holds one ratio through 10 s of steady cruise at %i km/h', (kmh) => {
    const sim = createSim(R, MINIMAL, vehicleOf('car-sedan'), { assists: ALL_ON });
    const target = kmhToMps(kmh);
    /** @type {Frame[]} */
    const cruise = [];
    /** @type {Frame | null} */
    let f = null;
    let reachedT = null;
    for (let k = 0; k < 60 * 25; k += 1) {
      const v = f ? f.ego.speed : 0;
      f = sim.step({ throttle: Math.max(0, Math.min(1, 0.6 * (target - v))), steer: holdLane(f) });
      if (reachedT === null && f.ego.speed >= target - 0.3) reachedT = f.t;
      if (reachedT !== null && f.t >= reachedT + 3) cruise.push(f);
      if (cruise.length >= 60 * 10) break;
    }
    sim.dispose();
    expect(cruise).toHaveLength(600);
    expect(Math.abs(cruise[0].ego.speed - target)).toBeLessThan(1);
    expect(shiftsOf(cruise)).toEqual([]);
    console.log(`cruise ${kmh} km/h: ratio ${impliedRatio(cruise[0])}, ${Math.round(cruise[0].ego.rpm)}–${Math.round(cruise.at(-1)?.ego.rpm ?? 0)} rpm, settle ended at ${cruise[0].t.toFixed(2)} s`);
    expect(new Set(cruise.map((x) => x.ego.gear))).toEqual(new Set(['D']));
  });

  it('gives N then R from D at rest, refuses R when moving, and moves off in 1 after a stop', () => {
    const sim = createSim(R, MINIMAL, vehicleOf('car-sedan'), { assists: { autoGearbox: true, signalAutoCancel: null } });
    let f = sim.step({});
    expect(f.ego.gear).toBe('D');
    expect(sim.step({ gearCmd: 'down' }).ego.gear).toBe('N');
    expect(sim.step({ gearCmd: 'down' }).ego.gear).toBe('R');
    expect(sim.step({ gearCmd: 'up' }).ego.gear).toBe('N');
    expect(sim.step({ gearCmd: 'up' }).ego.gear).toBe('D');
    // No creep: D with no throttle stays put.
    for (let k = 0; k < 120; k += 1) f = sim.step({});
    expect(Math.abs(f.ego.speed)).toBeLessThan(0.05);
    for (let k = 0; k < 600 && f.ego.speed < kmhToMps(40); k += 1) f = sim.step({ throttle: 1, steer: holdLane(f) });
    expect(sim.step({ gearCmd: 'down', steer: holdLane(f) }).ego.gear).toBe('N');
    f = sim.step({ gearCmd: 'down', steer: holdLane(f) });
    expect(f.ego.gear).toBe('N');
    f = sim.step({ gearCmd: 'up', steer: holdLane(f) });
    expect(f.ego.gear).toBe('D');
    // Back in D at speed with no throttle: the box keeps a ratio that suits the speed, not 1st.
    for (let k = 0; k < 5; k += 1) f = sim.step({ steer: holdLane(f) });
    expect(f.ego.rpm).toBeLessThan(GEARBOX.autoShift.upRpm);
    expect(impliedRatio(f)).toBeGreaterThanOrEqual(3);
    for (let k = 0; k < 600 && f.ego.speed > 0.05; k += 1) f = sim.step({ brakeFront: 1, steer: holdLane(f) });
    /** @type {Frame[]} */
    const launch = [];
    for (let k = 0; k < 40; k += 1) {
      f = sim.step({ throttle: 1, steer: holdLane(f) });
      launch.push(f);
    }
    sim.dispose();
    const moving = launch.filter((x) => x.ego.speed > 1 && x.ego.rpm > GEARBOX.idleRpm);
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.every((x) => impliedRatio(x) === 1)).toBe(true);
  });

  it('is ignored by the scooter', () => {
    const run = (/** @type {ControlAssists | undefined} */ assists) => {
      const sim = createSim(R, MINIMAL, vehicleOf('scooter'), assists ? { assists } : undefined);
      /** @type {Frame[]} */
      const out = [];
      /** @type {Frame | null} */
      let f = null;
      for (let k = 0; k < 300; k += 1) {
        f = sim.step({ throttle: 0.8, steer: holdLane(f), gearCmd: k === 100 ? 'down' : k === 140 ? 'up' : null });
        out.push(f);
      }
      sim.dispose();
      return out;
    };
    expect(run({ autoGearbox: true, signalAutoCancel: null })).toEqual(run(undefined));
  });
});

describe('scooter combined brake share', () => {
  it.each([1, 0.6])('stops straight from 50 km/h at grip %f with no skid and no fall', (grip) => {
    const share = /** @type {number} */ (scooter.brakes.combinedRearPerGrip);
    expect(share).toBeGreaterThan(0);
    const map = structuredClone(MINIMAL);
    map.environment.surfaceGrip = grip;
    const sim = createSim(R, map, vehicleOf('scooter'));
    /** @type {Frame | null} */
    let f = null;
    for (let k = 0; k < 60 * 30 && !(f && f.ego.speed >= kmhToMps(50)); k += 1) f = sim.step({ throttle: 1, steer: holdLane(f) });
    const start = /** @type {Frame} */ (f);
    expect(start.ego.speed).toBeGreaterThanOrEqual(kmhToMps(50));
    let skid = false;
    let fall = false;
    let end = start;
    for (let k = 0; k < 60 * 10 && end.ego.speed > 0.05; k += 1) {
      end = sim.step({
        brakeFront: Math.min(1, SCOOTER_FRONT_BRAKE_PER_GRIP * grip),
        brakeRear: Math.min(1, share * grip),
        steer: holdLane(end),
      });
      skid ||= end.ego.wheels.some((w) => w.skid > 0);
      fall ||= end.events.some((e) => e.type === 'fall' || e.type === 'reset');
    }
    sim.dispose();
    const distance = end.ego.pos.x - start.ego.pos.x;
    console.log(`scooter combined brake, grip ${grip}: ${distance.toFixed(2)} m in ${(end.t - start.t).toFixed(2)} s`);
    expect(end.ego.speed).toBeLessThan(0.05);
    expect(skid).toBe(false);
    expect(fall).toBe(false);
    if (grip === 1) {
      expect(distance).toBeGreaterThanOrEqual(11);
      expect(distance).toBeLessThanOrEqual(16);
    }
  });
});

/**
 * @typedef {object} TurnRun
 * @property {Frame[]} frames Frames.
 * @property {import('../../../src/contracts/index.js').ScoreReport} report Live score report.
 * @property {number[]} cancels Frame indices where the indicator went off with no player command.
 * @property {Array<{index: number, junctionId: string}>} exits Frame indices of junction exits.
 */

/**
 * Drives a path with the scenario driver and the assists, scoring live.
 * @param {GameMap} map Map.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 * @param {{assists?: ControlAssists, path?: Vec2[], maxS?: number,
 *   intercept?: (k: number, input: Partial<ControlInput>, sim: import('../../../src/contracts/index.js').Sim) => Partial<ControlInput>}} options
 *   Assists (none when absent), path (default the route), stop distance and a hook that may change
 *   the input of step `k`.
 * @returns {Promise<TurnRun>} Run.
 */
async function driveTurns(map, vehicleId, options) {
  const bundle = await realBundle();
  const driver = createDriver(map, vehicleId, { path: options.path, maxS: options.maxS });
  const sim = createSim(R, map, driver.vehicle, options.assists ? { assists: options.assists } : undefined);
  const scorer = createScorer(bundle, map, driver.vehicle);
  const maxS = options.maxS ?? driver.total;
  const line = options.path ?? routePath(map);
  /** @type {Frame[]} */
  const frames = [];
  /** @type {number[]} */
  const cancels = [];
  /** @type {Array<{index: number, junctionId: string}>} */
  const exits = [];
  let state = scorer.initial;
  /** @type {Frame | null} */
  let prev = null;
  /** @type {string | null} */
  let inJunction = null;
  let sinceExitM = Infinity;
  try {
    for (let k = 0; k < Math.ceil((map.route.timeLimitS + 5) / DT); k += 1) {
      let input = driver.next(prev);
      if (sinceExitM < QUIET_AFTER_EXIT_M) input = { ...input, signalCmd: null };
      if (options.intercept) input = options.intercept(k, input, sim);
      const f = sim.step(input);
      if (prev) sinceExitM += Math.hypot(f.ego.pos.x - prev.ego.pos.x, f.ego.pos.z - prev.ego.pos.z);
      const j = locate(map, [f.ego.pos.x, f.ego.pos.z], f.ego.heading).junctionId;
      if (inJunction !== null && j !== inJunction) {
        exits.push({ index: k, junctionId: inJunction });
        sinceExitM = 0;
      }
      inJunction = j;
      if (prev && prev.ego.indicators !== 'off' && f.ego.indicators === 'off' && f.ego.input.signalCmd === null) cancels.push(k);
      frames.push(f);
      state = scorer.step(state, f).state;
      prev = f;
      if (f.events.some((e) => e.type === 'finish' || e.type === 'timeout')) break;
      if (projectOntoPolyline([f.ego.pos.x, f.ego.pos.z], line).s >= maxS) break;
    }
  } finally {
    sim.dispose();
  }
  return { frames, report: scorer.report(state, { quit: false }), cancels, exits };
}

/**
 * Points of an arc.
 * @param {(phi: number) => Vec2} at Point at an angle.
 * @param {number} to Last angle (from 0).
 * @returns {Vec2[]} Points.
 */
function arc(at, to) {
  /** @type {Vec2[]} */
  const out = [];
  for (let k = 0; k <= 40; k += 1) out.push(at((to * k) / 40));
  return out;
}

// map-junction: from the route start east in the left lane, left at j1 (|x|, |z| ≤ 7) into the
// northbound lane (north is −z). The exit is about 175 m along the path.
/** @type {Vec2[]} */
const LEFT_TURN = [[-150, 1.75], [-7, 1.75], ...arc((p) => [-7 + 8.75 * Math.sin(p), -7 + 8.75 * Math.cos(p)], Math.PI / 2).slice(1), [1.75, -120]];
const LEFT_TURN_STOP_S = 230;

/**
 * Frames from a junction exit until the indicator is off.
 * @param {TurnRun} run Run.
 * @param {number} exitIndex Frame index of the exit.
 * @returns {number} Seconds until off, Infinity when it stays on.
 */
function offAfter(run, exitIndex) {
  const k = run.frames.findIndex((f, i) => i >= exitIndex && f.ego.indicators === 'off');
  return k < 0 ? Infinity : (k - exitIndex) * DT;
}

describe('indicator auto-cancel, scored', () => {
  it('cancels after a signalled left turn on map-junction with no turn-signal breach', async () => {
    const run = await driveTurns(JUNCTION, 'car-sedan', { assists: CANCEL_ONLY, path: LEFT_TURN, maxS: LEFT_TURN_STOP_S });
    const exit = run.exits.find((e) => e.junctionId === 'j1');
    expect(exit).toBeDefined();
    const at = /** @type {{index: number}} */ (exit).index;
    expect(run.frames[at - 1].ego.indicators).toBe('left');
    expect(offAfter(run, at)).toBeLessThanOrEqual(1);
    expect(run.cancels).toHaveLength(1);
    expect(breachesOf(run.report, 'turn-signal')).toEqual([]);

    // Without the assist the same driver leaves the indicator on.
    const plain = await driveTurns(JUNCTION, 'car-sedan', { path: LEFT_TURN, maxS: LEFT_TURN_STOP_S });
    const plainExit = /** @type {{index: number}} */ (plain.exits.find((e) => e.junctionId === 'j1')).index;
    expect(offAfter(plain, plainExit)).toBeGreaterThan(1);
    expect(plain.cancels).toEqual([]);
  }, 60000);

  it('cancels after each turn of tutorial 02 with every assist on, and the run finishes at 10', async () => {
    const map = loadShippedMap('tutorial-02-nga-tu');
    const run = await driveTurns(map, 'car-sedan', { assists: ALL_ON });
    expect(run.report.endedBy).toBe('finish');
    expect(run.report.breaches).toEqual([]);
    expect(run.report.score).toBe(10);
    // j-j2 left, j-j3 right, j-j4 right; j-j1 is crossed straight.
    const turns = run.exits.filter((e) => e.junctionId !== 'j-j1');
    expect(turns.map((e) => e.junctionId)).toEqual(['j-j2', 'j-j3', 'j-j4']);
    for (const e of turns) expect(offAfter(run, e.index), e.junctionId).toBeLessThanOrEqual(1);
    expect(run.cancels).toHaveLength(3);
    expect(new Set(run.frames.map((f) => f.ego.gear))).toEqual(new Set(['D']));
  }, 180000);

  it('keeps the indicator on when another junction lies ahead within clearM', async () => {
    // A second junction 20 m past the exit of the left turn, closer than signalFromM.
    const map = structuredClone(JUNCTION);
    map.junctions.push({ ...structuredClone(map.junctions[0]), id: 'j2', polygon: [[-7, -41], [7, -41], [7, -27], [-7, -27]] });
    const run = await driveTurns(map, 'car-sedan', { assists: CANCEL_ONLY, path: LEFT_TURN, maxS: LEFT_TURN_STOP_S });
    const exit = /** @type {{index: number}} */ (run.exits.find((e) => e.junctionId === 'j1')).index;
    const entry2 = run.frames.findIndex((f, i) => i > exit && locate(map, [f.ego.pos.x, f.ego.pos.z], f.ego.heading).junctionId === 'j2');
    expect(entry2).toBeGreaterThan(exit);
    expect(run.frames.slice(exit, entry2).every((f) => f.ego.indicators === 'left')).toBe(true);
    // Crossing j2 straight with the indicator on does not cancel either.
    expect(run.cancels).toEqual([]);
    expect(breachesOf(run.report, 'turn-signal')).toEqual([]);
  }, 60000);

  it('forgets the pass on a reset, and a press on the cancel step wins', async () => {
    const base = await driveTurns(JUNCTION, 'car-sedan', { assists: CANCEL_ONLY, path: LEFT_TURN, maxS: LEFT_TURN_STOP_S });
    const exit = /** @type {{index: number}} */ (base.exits.find((e) => e.junctionId === 'j1')).index;
    const cancelAt = base.cancels[0];

    // A reset 0.1 s after the exit, before the cancel: the ego goes back to the last passed
    // checkpoint (x −40, 33 m before j1) on that step, and the indicator stays on. Without the
    // tracker clear the pass would still cancel there, since j1 is then beyond clearM.
    let resetAt = -1;
    const reset = await driveTurns(JUNCTION, 'car-sedan', {
      assists: CANCEL_ONLY,
      path: LEFT_TURN,
      maxS: LEFT_TURN_STOP_S,
      intercept(k, input, sim) {
        if (k === exit + 6) {
          sim.reset();
          resetAt = k;
        }
        if (resetAt >= 0 && k > resetAt && k < resetAt + 120) return { ...input, signalCmd: null, throttle: 0, brakeFront: 1 };
        return input;
      },
    });
    const after = reset.frames.slice(resetAt, resetAt + 120);
    expect(after[0].events).toContainEqual({ type: 'reset' });
    expect(after.every((f) => f.ego.indicators === 'left')).toBe(true);
    expect(resetAt).toBeLessThan(cancelAt);
    expect(reset.cancels.filter((k) => k < resetAt + 120)).toEqual([]);

    // Pressing left on the cancel step toggles the indicator off as the player asked; the assist
    // does not cancel first and turn it back on.
    const press = await driveTurns(JUNCTION, 'car-sedan', {
      assists: CANCEL_ONLY,
      path: LEFT_TURN,
      maxS: LEFT_TURN_STOP_S,
      intercept: (k, input) => (k === cancelAt ? { ...input, signalCmd: 'left' } : input),
    });
    expect(press.frames[cancelAt].ego.indicators).toBe('off');
    expect(press.frames.slice(cancelAt, cancelAt + 60).every((f) => f.ego.indicators === 'off')).toBe(true);
  }, 120000);

  it('never cancels the signalled lane change of tutorial 01', async () => {
    const run = await driveTurns(loadShippedMap('tutorial-01-co-ban'), 'car-sedan', { assists: ALL_ON });
    expect(run.report.endedBy).toBe('finish');
    expect(run.report.breaches).toEqual([]);
    expect(run.cancels).toEqual([]);
  }, 120000);

  it('records the cancels on the osm-pasteur route', async () => {
    const run = await driveTurns(loadShippedMap('osm-pasteur'), 'car-sedan', { assists: ALL_ON });
    console.log(`osm-pasteur: ${run.cancels.length} auto-cancels over ${run.exits.length} junction exits`);
    expect(run.report.endedBy).toBe('finish');
    expect(breachesOf(run.report, 'turn-signal')).toEqual([]);
  }, 180000);
});
