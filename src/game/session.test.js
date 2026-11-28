import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFrame } from '../contracts/assert-frame.js';
import { assertMap } from '../contracts/assert-map.js';
import { createScorer, scoreRun } from '../scoring/index.js';
import { DT } from '../contracts/units.js';
import { KEY_BINDINGS } from '../contracts/controls.js';
import { createSim, sanitizeInput } from '../sim/index.js';
import { buildFrames } from '../testing/index.js';
import { parseDevRunQuery } from './browser.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { REPLAY_CHECKPOINT_S, createSession } from './session.js';
import { lawfulParams } from '../world/traffic/lawful-params.js';
import { pointAtDistance, projectOntoPolyline } from '../geometry/index.js';
import { createDriver } from '../../tests/scenarios/physics/driver.js';

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
const TUTORIAL_02 = /** @type {GameMap} */ (json('public/maps/tutorial-02-nga-tu.json'));
const PASTEUR = /** @type {GameMap} */ (json('public/maps/osm-pasteur.json'));
/** The signal on Pasteur itself, on the route, controlling the route's travel heading. */
const PASTEUR_SIGNAL = 'sig-w678315474-f';
const PARAMS = /** @type {import('../contracts/index.js').TrafficParams} */ (json('src/generated/traffic-params.json'));
const CHECKPOINT_TICKS = Math.round(REPLAY_CHECKPOINT_S / DT);
/** The shipped population with every rider taking a cut-in into the ego's path when it can. */
const CUTTING_RIDERS = structuredClone(PARAMS);
for (const row of Object.values(CUTTING_RIDERS.personalities)) row.violations.cutIn = 1;
/** A run seed on which a vehicle cuts in on the cruising ego early in the run, with no other contact for 16 s. */
const CUT_IN_SEED = 16;

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
    const gearUpKey = KEY_BINDINGS.find((b) => b.action === 'gearUp')?.keys[0] ?? '';
    down(gearUpKey); // N → 1
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

/**
 * Input that follows a script by step count, in place of the keyboard.
 * @param {(k: number) => Partial<import('../contracts/index.js').ControlInput>} script Input of step `k`.
 * @returns {import('./session.js').SessionDeps['createInput']} Input factory.
 */
function scriptedInput(script) {
  return () => {
    let k = 0;
    return {
      sample: () => sanitizeInput(script(k++)),
      setEnabled() {},
      setDriving() {},
      dispose() {},
    };
  };
}

/**
 * Real sim that appends a contact by a lawful NPC car from behind to the frame of step `atTick`.
 * @param {number} atTick Step of the contact.
 * @returns {import('../contracts/index.js').CreateSim} Sim factory.
 */
function simWithContactAt(atTick) {
  return (rapier, map, vehicle, options) => {
    const sim = createSim(rapier, map, vehicle, options);
    return {
      ...sim,
      step(input) {
        const f = sim.step(input);
        if (f.tick !== atTick) return f;
        /** @type {import('../contracts/index.js').CollisionEvent} */
        const hit = {
          type: 'collision',
          otherKind: 'car',
          otherId: 'npc-test',
          impulse: 400,
          egoSpeed: Math.abs(f.ego.speed),
          relSpeed: 2,
          sameLaneAhead: false,
          otherModel: 'car',
          striker: 'other',
          otherFromBehind: true,
          otherViolations: [],
        };
        return { ...f, events: [...f.events, hit] };
      },
    };
  };
}

/**
 * Real sim that records every frame it returns.
 * @param {Frame[]} out Recorded frames.
 * @returns {import('../contracts/index.js').CreateSim} Sim factory.
 */
function recordingSim(out) {
  return (rapier, map, vehicle, options) => {
    const sim = createSim(rapier, map, vehicle, options);
    return {
      ...sim,
      step(input) {
        const f = sim.step(input);
        out.push(f);
        return f;
      },
    };
  };
}

/**
 * Nearest traffic agent ahead of the ego, inside a cone of half-width `along / 2`.
 * @param {Frame} f Frame.
 * @param {number} scripted Scripted actors on the map, listed before the traffic agents.
 * @param {number} rangeM Search range.
 * @param {'car' | 'motorbike'} [kind] Only agents of this kind; any kind by default.
 * @returns {{d: number, lat: number, along: number} | null} Distance, lateral offset (+ to the
 *   right, the sign of `steer`) and distance along the ego heading.
 */
function agentAhead(f, scripted, rangeM, kind) {
  const e = f.ego;
  const fx = Math.cos(e.heading);
  const fz = -Math.sin(e.heading);
  /** @type {{d: number, lat: number, along: number} | null} */
  let best = null;
  for (const a of f.actors.slice(scripted)) {
    if (kind !== undefined && a.kind !== kind) continue;
    const dx = a.pos.x - e.pos.x;
    const dz = a.pos.z - e.pos.z;
    const along = dx * fx + dz * fz;
    const lat = dz * fx - dx * fz;
    const d = Math.hypot(dx, dz);
    if (along > 2 && d < rangeM && Math.abs(lat) < along / 2 && (!best || d < best.d)) best = { d, lat, along };
  }
  return best;
}

/**
 * Steering toward a point `along` ahead and `lat` to the side.
 * @param {number} lat Lateral offset, + to the right.
 * @param {number} along Distance ahead.
 * @returns {number} Steer in −1..1.
 */
const steerTo = (lat, along) => Math.max(-1, Math.min(1, (2 * lat) / Math.max(along, 1)));

/**
 * Input that steers the ego at the nearest traffic agent ahead with steady throttle, so it runs
 * into it.
 * @param {Frame[]} frames Frames recorded so far.
 * @param {number} scripted Scripted actors on the map.
 * @param {'car' | 'motorbike'} [kind] Only agents of this kind; any kind by default.
 * @returns {import('./session.js').SessionDeps['createInput']} Input factory.
 */
function pursuitInput(frames, scripted, kind) {
  return scriptedInput((k) => {
    const f = frames.at(-1);
    if (k === 0 || !f) return { gearCmd: 'up' };
    const best = agentAhead(f, scripted, 80, kind);
    return { throttle: 0.6, steer: best ? steerTo(best.lat, best.along) : 0 };
  });
}

/**
 * Input that follows the lane of the route start at a steady speed, braking for nothing.
 * @param {Frame[]} frames Frames recorded so far.
 * @param {number} speed Speed to hold, m/s.
 * @returns {import('./session.js').SessionDeps['createInput']} Input factory.
 */
function cruiseInput(frames, speed) {
  const start = PASTEUR.route.start.pos;
  const lane = PASTEUR.roads
    .flatMap((r) => r.lanes)
    .map((l) => ({ l, d: projectOntoPolyline([start.x, start.z], l.centerline).distance }))
    .sort((a, b) => a.d - b.d)[0].l;
  return scriptedInput((k) => {
    const f = frames.at(-1);
    if (k === 0 || !f) return { gearCmd: 'up' };
    const e = f.ego;
    const at = pointAtDistance(lane.centerline, projectOntoPolyline([e.pos.x, e.pos.z], lane.centerline).s + 12).point;
    const fx = Math.cos(e.heading);
    const fz = -Math.sin(e.heading);
    const dx = at[0] - e.pos.x;
    const dz = at[1] - e.pos.z;
    const throttle = e.speed < speed ? 0.5 : e.speed < speed + 0.5 ? 0.15 : 0;
    return { throttle, steer: steerTo(dz * fx - dx * fz, dx * fx + dz * fz) };
  });
}

/** Braking command of a held ego. */
const HOLD_BRAKE = Object.freeze({ throttle: 0, brakeFront: 0.8, brakeRear: 0.8 });

/**
 * Input that drives the ego along the route with the traffic-aware route autopilot, then brakes
 * and holds once it is within its stopping distance (`v² / 6 + 2` m) of `target` along the
 * autopilot's line. `holdTick()` gives the tick from which the ego stood still under the hold, or
 * null before that.
 * @param {Frame[]} frames Frames recorded so far.
 * @param {GameMap} map Map.
 * @param {import('../contracts/index.js').Pos2} target Point to drive to, on the route.
 * @returns {{createInput: import('./session.js').SessionDeps['createInput'], holdTick: () => number | null}}
 *   Input factory and the hold start.
 */
function routeApproachInput(frames, map, target) {
  const driver = createDriver(map, 'car-sedan', { sim: { traffic: 'map' } });
  const targetS = projectOntoPolyline([target.x, target.z], driver.line).s;
  let holding = false;
  /** @type {number | null} */
  let heldFrom = null;
  return {
    holdTick: () => heldFrom,
    createInput: scriptedInput((k) => {
      const f = frames.at(-1);
      if (k === 0 || !f) return driver.next(null);
      const e = f.ego;
      if (!holding && projectOntoPolyline([e.pos.x, e.pos.z], driver.line).s >= targetS - ((e.speed * e.speed) / 6 + 2)) holding = true;
      if (!holding) return driver.next(f);
      if (heldFrom === null && Math.abs(e.speed) < 0.2) heldFrom = f.tick;
      return HOLD_BRAKE;
    }),
  };
}

/**
 * Where an agent stands against a signal's stop line.
 * @param {GameMap['stopLines'][number]} line Stop line.
 * @param {number} heading Travel heading the signal controls.
 * @param {import('../contracts/index.js').Pos2} pos Agent position.
 * @returns {{d: number, onSpan: boolean}} Signed distance past the line along the travel
 *   heading, and whether the position lies across the line's span (1 m margin).
 */
function againstLine(line, heading, pos) {
  const [[ax, az], [bx, bz]] = line.segment;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const fx = Math.cos(heading);
  const fz = -Math.sin(heading);
  const half = Math.hypot(bx - ax, bz - az) / 2;
  const d = (pos.x - mx) * fx + (pos.z - mz) * fz;
  const lat = (pos.z - mz) * fx - (pos.x - mx) * fz;
  return { d, onSpan: Math.abs(lat) <= half + 1 };
}

/**
 * How traffic agents met the map's signals over recorded frames.
 * @param {GameMap} map Map.
 * @param {Frame[]} frames Frames in tick order.
 * @returns {{stoppedAt: Set<string>, redRuns: string[]}} Signals that held a stopped agent within
 *   15 m before their stop line while red, and every agent that crossed a stop line on red, as
 *   `agent@tick:signal`.
 */
function signalBehaviour(map, frames) {
  const scripted = map.actors.length;
  /** @type {Set<string>} */
  const stoppedAt = new Set();
  /** @type {string[]} */
  const redRuns = [];
  for (const signal of map.signals) {
    for (const line of map.stopLines.filter((l) => signal.stopLineIds.includes(l.id))) {
      /** @type {Map<string, number>} */
      const lastD = new Map();
      for (const f of frames) {
        const red = f.trafficLights[signal.id] === 'red';
        for (const a of f.actors.slice(scripted)) {
          // Only agents travelling the way the signal controls.
          if (Math.cos(a.heading - signal.heading) < 0.7) {
            lastD.delete(a.id);
            continue;
          }
          const { d, onSpan } = againstLine(line, signal.heading, a.pos);
          const prev = lastD.get(a.id);
          if (red && onSpan && prev !== undefined && prev < 0 && d >= 0) redRuns.push(`${a.id}@${f.tick}:${signal.id}`);
          if (red && onSpan && d < 0 && d > -15 && a.speed < 0.3) stoppedAt.add(signal.id);
          lastD.set(a.id, d);
        }
      }
    }
  }
  return { stoppedAt, redRuns };
}

describe('session with traffic (dev build checks)', () => {
  /**
   * Dev harness on tutorial 02 with the real sim and traffic params.
   * @param {Partial<import('./session.js').SessionDeps>} [over] Overrides.
   * @returns {ReturnType<typeof harness>} Harness.
   */
  const trafficHarness = (over = {}) =>
    harness({
      loadMap: async () => structuredClone(TUTORIAL_02),
      loadTrafficParams: async () => PARAMS,
      createSim,
      dev: true,
      assertFrame,
      assertMap,
      scoreRun,
      ...over,
    });

  it('keeps the windowed replay equal over two minutes, with a notice before the first checkpoint', { timeout: 120_000 }, async () => {
    const contactTick = 180;
    const h = trafficHarness({
      createSim: simWithContactAt(contactTick),
      // Drive off, then brake to a stop and wait while the traffic runs.
      createInput: scriptedInput((k) => ({ gearCmd: k === 0 ? 'up' : null, throttle: k < 240 ? 0.4 : 0, brakeFront: k >= 240 ? 0.8 : 0 })),
    });
    await h.game.start('tutorial-02-nga-tu', 'car-sedan', { seed: 4242 });
    expect(h.game.debugInfo().runSeed).toBe(4242);
    expect(h.game.debugInfo().traffic).toBe('map');
    const maxAgents = /** @type {NonNullable<GameMap['traffic']>} */ (TUTORIAL_02.traffic).maxAgents;
    let maxKept = 0;
    let agentsSeen = 0;
    h.frames.tick(0);
    while (h.game.debugInfo().tick < 120 / DT) {
      h.frames.tick(1000 / 60);
      const info = h.game.debugInfo();
      maxKept = Math.max(maxKept, info.keptFrames);
      agentsSeen = Math.max(agentsSeen, info.agents);
      expect(info.agents).toBeLessThanOrEqual(maxAgents);
      expect(info.mirrored).toBeLessThanOrEqual(Math.min(info.agents, PARAMS.maxMirrored));
    }
    expect(agentsSeen).toBeGreaterThan(0);
    expect(h.states.some((s) => s.notices.some((n) => n.tick === contactTick))).toBe(true);
    const live = h.game.debugInfo();
    expect(live.agents).toBeGreaterThan(0);
    expect(live.simStepMs).not.toBeNull();
    h.game.quit();
    const info = h.game.debugInfo();
    expect(maxKept).toBeLessThanOrEqual(2 * CHECKPOINT_TICKS);
    expect(maxKept).toBeGreaterThan(CHECKPOINT_TICKS);
    expect(info.replayCheck?.windowed).toBe(true);
    expect(info.replayCheck?.frames).toBeLessThanOrEqual(2 * CHECKPOINT_TICKS);
    expect(info.replayCheck?.equal).toBe(true);
    const report = h.states.at(-1)?.report;
    expect(report?.notices.map((n) => n.tick)).toContain(contactTick);
    expect(h.errors).toEqual([]);
  });

  /**
   * Runs a started session until `seconds` of sim time, checking the agent cap on each frame.
   * @param {ReturnType<typeof harness>} h Harness.
   * @param {number} seconds Sim time.
   */
  const runFor = (h, seconds) => {
    const maxAgents = /** @type {NonNullable<GameMap['traffic']>} */ (PASTEUR.traffic).maxAgents;
    h.frames.tick(0);
    while (h.game.debugInfo().tick < seconds / DT && h.game.debugInfo().status === 'running') {
      h.frames.tick(1000 / 60);
      expect(h.game.debugInfo().agents).toBeLessThanOrEqual(maxAgents);
    }
    expect(h.game.debugInfo().tick).toBeGreaterThanOrEqual(seconds / DT);
    expect(h.game.debugInfo().agents).toBeGreaterThan(0);
  };

  /** Seeds of the signal approach: two by default, more with TRAFFIC_LONG=1. */
  const APPROACH_SEEDS = [4244, 1, ...(process.env.TRAFFIC_LONG ? Array.from({ length: 10 }, (_, i) => i + 2) : [])];

  it.each(APPROACH_SEEDS)('drives osm-pasteur up to the Pasteur signal, where traffic stops on red and none runs it (seed %i)', { timeout: 120_000 }, async (seed) => {
    const signal = /** @type {GameMap['signals'][number]} */ (PASTEUR.signals.find((s) => s.id === PASTEUR_SIGNAL));
    const line = /** @type {GameMap['stopLines'][number]} */ (PASTEUR.stopLines.find((l) => l.id === signal.stopLineIds[0]));
    // Hold 40 m before the stop line, inside the traffic ring around the ego.
    const [[ax, az], [bx, bz]] = line.segment;
    const target = { x: (ax + bx) / 2 - 40 * Math.cos(signal.heading), z: (az + bz) / 2 + 40 * Math.sin(signal.heading) };
    /** @type {Frame[]} */
    const recorded = [];
    const approach = routeApproachInput(recorded, PASTEUR, target);
    const h = trafficHarness({
      loadMap: async () => structuredClone(PASTEUR),
      // The lawful driver population: no one runs a red by choice.
      loadTrafficParams: async () => lawfulParams(PARAMS),
      createSim: recordingSim(recorded),
      createInput: approach.createInput,
    });
    await h.game.start('osm-pasteur', 'car-sedan', { seed });
    expect(h.game.debugInfo()).toMatchObject({ traffic: 'map', runSeed: seed });
    // Drive there, then hold through one whole cycle of the signal (red from 30 s to 60 s of each
    // cycle), within the map's time limit.
    const cycleTicks = Math.round((signal.cycle.green + signal.cycle.yellow + signal.cycle.red) / DT);
    const limitTicks = Math.round(PASTEUR.route.timeLimitS / DT);
    const maxAgents = /** @type {NonNullable<GameMap['traffic']>} */ (PASTEUR.traffic).maxAgents;
    const heldLongEnough = () => {
      const from = approach.holdTick();
      return from !== null && h.game.debugInfo().tick - from >= cycleTicks;
    };
    h.frames.tick(0);
    while (!heldLongEnough() && h.game.debugInfo().tick < limitTicks && h.game.debugInfo().status === 'running') {
      h.frames.tick(1000 / 60);
      expect(h.game.debugInfo().agents).toBeLessThanOrEqual(maxAgents);
    }
    expect(heldLongEnough()).toBe(true);
    expect(h.game.debugInfo().agents).toBeGreaterThan(0);
    const ego = recorded.at(-1)?.ego.pos;
    expect(Math.hypot((ego?.x ?? 0) - target.x, (ego?.z ?? 0) - target.z)).toBeLessThan(30);
    const { stoppedAt, redRuns } = signalBehaviour(PASTEUR, recorded);
    expect(stoppedAt.has(PASTEUR_SIGNAL)).toBe(true);
    expect(redRuns.filter((r) => r.endsWith(`:${PASTEUR_SIGNAL}`))).toEqual([]);
    h.game.quit();
    expect(h.game.debugInfo().replayCheck).toMatchObject({ windowed: true, equal: true });
    expect(h.errors).toEqual([]);
  });

  it('charges a rear-end by the ego on osm-pasteur with traffic, and keeps the replay equal', { timeout: 120_000 }, async () => {
    /** @type {Frame[]} */
    const recorded = [];
    const h = trafficHarness({
      loadMap: async () => structuredClone(PASTEUR),
      // Lawful traffic, so the agent ahead does not leave the lane or start a crash of its own.
      loadTrafficParams: async () => lawfulParams(PARAMS),
      createSim: recordingSim(recorded),
      createInput: pursuitInput(recorded, PASTEUR.actors.length, 'car'),
    });
    await h.game.start('osm-pasteur', 'car-sedan', { seed: 8 });
    runFor(h, 20);
    const egoHit = recorded.flatMap((f) => f.events).find((ev) => ev.type === 'collision' && ev.striker === 'ego' && ev.sameLaneAhead);
    expect(egoHit).toBeDefined();
    h.game.quit();
    const report = h.states.at(-1)?.report;
    expect(report?.breaches.map((b) => b.ruleId)).toContain('crash');
    expect(report?.score).toBeLessThan(10);
    expect(report?.notices).toEqual([]);
    const info = h.game.debugInfo();
    expect(info.replayCheck).toMatchObject({ windowed: true, equal: true });
    expect(info.replayCheck?.frames).toBeLessThanOrEqual(2 * CHECKPOINT_TICKS);
    expect(h.errors).toEqual([]);
  });

  it('turns a contact with a vehicle cutting in on osm-pasteur into a notice on the HUD and the result, while the ego holds its speed', { timeout: 120_000 }, async () => {
    /** @type {Frame[]} */
    const recorded = [];
    // On this seed a car changes lane into the ego's path without checking, while the ego cruises
    // at a steady 7 m/s in its lane; the car latches `unsafe-lane-change` before the contact, and
    // the ego has not sped up since.
    const h = trafficHarness({
      loadMap: async () => structuredClone(PASTEUR),
      loadTrafficParams: async () => CUTTING_RIDERS,
      createSim: recordingSim(recorded),
      createInput: cruiseInput(recorded, 7),
    });
    await h.game.start('osm-pasteur', 'car-sedan', { seed: CUT_IN_SEED });
    runFor(h, 16);
    const hits = recorded.flatMap((f) =>
      f.events.flatMap((ev) => (ev.type === 'collision' && ev.otherViolations.includes('unsafe-lane-change') ? [{ tick: f.tick, ev }] : [])),
    );
    expect(hits.length).toBeGreaterThan(0);
    const [first] = hits;
    expect(first.ev).toMatchObject({ striker: 'ego' });
    expect(h.states.some((s) => s.notices.some((n) => n.tick === first.tick))).toBe(true);
    h.game.quit();
    const report = h.states.at(-1)?.report;
    const notice = report?.notices.find((n) => n.tick === first.tick);
    expect(notice).toMatchObject({ kind: 'npc-fault', violations: ['unsafe-lane-change'] });
    expect(notice?.text.vi).not.toBe('');
    expect(report?.breaches.map((b) => b.ruleId)).not.toContain('crash');
    // The run ends before a second checkpoint, so the replay folds the whole run.
    expect(h.game.debugInfo().replayCheck).toMatchObject({ windowed: false, equal: true });
    expect(h.errors).toEqual([]);
  });

  it('charges an ego that speeds up into a rider ahead on osm-pasteur, whatever the rider did', { timeout: 120_000 }, async () => {
    /** @type {Frame[]} */
    const recorded = [];
    // The ego chases riders with steady throttle, gaining speed all the way to the contact.
    const h = trafficHarness({
      loadMap: async () => structuredClone(PASTEUR),
      createSim: recordingSim(recorded),
      createInput: pursuitInput(recorded, PASTEUR.actors.length, 'motorbike'),
    });
    await h.game.start('osm-pasteur', 'car-sedan', { seed: 4242 });
    runFor(h, 20);
    const first = recorded.flatMap((f) => f.events.flatMap((ev) => (ev.type === 'collision' && ev.otherKind === 'motorbike' ? [{ tick: f.tick, ev }] : [])))[0];
    expect(first?.ev).toMatchObject({ striker: 'ego' });
    h.game.quit();
    const report = h.states.at(-1)?.report;
    expect(report?.notices.some((n) => n.tick === first.tick)).toBe(false);
    expect(report?.breaches.map((b) => b.ruleId)).toContain('crash');
    expect(report?.score).toBeLessThan(10);
    expect(h.game.debugInfo().replayCheck).toMatchObject({ windowed: true, equal: true });
    expect(h.errors).toEqual([]);
  });

  it('halves the active traffic cap with agentScale 0.5 and reports traffic step time and draw calls', { timeout: 120_000 }, async () => {
    /** @type {(number | undefined)[]} */
    const caps = [];
    /** @type {import('../contracts/index.js').CreateSim} */
    const capturing = (rapier, map, vehicle, options) => {
      caps.push(map.traffic?.maxAgents);
      return createSim(rapier, map, vehicle, options);
    };
    const full = /** @type {NonNullable<GameMap['traffic']>} */ (PASTEUR.traffic).maxAgents;
    const h = trafficHarness({
      loadMap: async () => structuredClone(PASTEUR),
      createSim: capturing,
      createView: () => ({ renderer: { render() {}, resize() {}, dispose() {}, drawCalls: () => 42 }, dispose() {} }),
    });
    await h.game.start('osm-pasteur', 'car-sedan', { seed: 4242, agentScale: 0.5 });
    const half = Math.round(full * 0.5);
    expect(caps).toEqual([half]);
    let peak = 0;
    h.frames.tick(0);
    while (h.game.debugInfo().tick < 30 / DT) {
      h.frames.tick(1000 / 60);
      peak = Math.max(peak, h.game.debugInfo().agents);
    }
    expect(peak).toBeLessThanOrEqual(half);
    expect(peak).toBeGreaterThan(half / 2);
    const info = h.game.debugInfo();
    expect(info.trafficStepMs?.mean).toBeGreaterThanOrEqual(0);
    expect(info.drawCalls).toBe(42);
    h.game.quit();

    await h.game.start('osm-pasteur', 'car-sedan', { seed: 4242 });
    expect(caps).toEqual([half, full]);
    h.game.quit();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(h.game.start('osm-pasteur', 'car-sedan', { agentScale: bad })).rejects.toThrow(/agentScale/);
    }
    expect(h.errors).toEqual([]);
  });

  it('draws a fresh seed per run unless one is fixed, and lets the start option win over the dev query', async () => {
    const h = trafficHarness();
    await h.game.start('tutorial-02-nga-tu', 'car-sedan');
    const a = h.game.debugInfo().runSeed;
    await h.game.start('tutorial-02-nga-tu', 'car-sedan');
    const b = h.game.debugInfo().runSeed;
    h.game.quit();
    expect(Number.isInteger(a) && Number.isInteger(b)).toBe(true);
    expect(a).not.toBe(b);

    const q = trafficHarness({ devRunOptions: () => parseDevRunQuery('#/play?map=tutorial-02-nga-tu&vehicle=car-sedan&seed=77') });
    await q.game.start('tutorial-02-nga-tu', 'car-sedan');
    expect(q.game.debugInfo().runSeed).toBe(77);
    await q.game.start('tutorial-02-nga-tu', 'car-sedan', { seed: 5 });
    expect(q.game.debugInfo().runSeed).toBe(5);
    q.game.quit();

    const release = trafficHarness({ dev: false, devRunOptions: () => ({ seed: 77, traffic: 'off' }) });
    await release.game.start('tutorial-02-nga-tu', 'car-sedan');
    expect(release.game.debugInfo().runSeed).not.toBe(77);
    expect(release.game.debugInfo().traffic).toBe('map');
    release.game.quit();

    await expect(h.game.start('tutorial-02-nga-tu', 'car-sedan', { seed: -1 })).rejects.toThrow(RangeError);
  });

  it('runs the scripted actors only with traffic off, keeping the whole run for the replay', async () => {
    const h = trafficHarness({ devRunOptions: () => parseDevRunQuery('#/play?traffic=off') });
    await h.game.start('tutorial-02-nga-tu', 'car-sedan');
    h.frames.tick(0);
    for (let i = 0; i < CHECKPOINT_TICKS + 60; i += 1) h.frames.tick(1000 / 60);
    const live = h.game.debugInfo();
    expect(live.traffic).toBe('off');
    expect(live.agents).toBe(0);
    expect(live.actors.map((a) => a.id)).toEqual(TUTORIAL_02.actors.map((a) => a.id));
    expect(live.keptFrames).toBeGreaterThan(CHECKPOINT_TICKS);
    h.game.quit();
    expect(h.game.debugInfo().replayCheck).toMatchObject({ equal: true, windowed: false });
    expect(h.errors).toEqual([]);
  });

  it('runs traffic off in a session built without a traffic params loader', async () => {
    const h = trafficHarness({ loadTrafficParams: undefined });
    await h.game.start('tutorial-02-nga-tu', 'car-sedan');
    h.frames.tick(0);
    for (let i = 0; i < 120; i += 1) h.frames.tick(1000 / 60);
    expect(h.game.debugInfo()).toMatchObject({ traffic: 'off', agents: 0 });
    h.game.quit();
    await expect(h.game.start('tutorial-02-nga-tu', 'car-sedan', { traffic: 'map' })).rejects.toThrow(/loadTrafficParams/);
  });
});

describe('parseDevRunQuery', () => {
  it('reads traffic and seed from the play hash and rejects anything else', () => {
    expect(parseDevRunQuery('#/play?map=a&vehicle=b')).toEqual({});
    expect(parseDevRunQuery('#/play?map=a&vehicle=b&seed=42&traffic=off')).toEqual({ seed: 42, traffic: 'off' });
    expect(parseDevRunQuery('')).toEqual({});
    expect(() => parseDevRunQuery('#/play?seed=abc')).toThrow(RangeError);
    expect(() => parseDevRunQuery('#/play?seed=4294967296')).toThrow(RangeError);
    expect(() => parseDevRunQuery('#/play?traffic=on')).toThrow(RangeError);
  });
});

describe('session control presets', () => {
  /**
   * Real sim on the minimal map that records the options it was created with and its frames.
   * @param {Array<import('../contracts/index.js').SimOptions | undefined>} options Recorded options.
   * @param {Frame[]} out Recorded frames.
   * @returns {import('../contracts/index.js').CreateSim} Sim factory.
   */
  const spySim = (options, out) => (rapier, map, vehicle, o) => {
    options.push(o);
    return recordingSim(out)(rapier, map, vehicle, o);
  };
  /** Drives off, steers a little and brakes, the same for every run. */
  const script = scriptedInput((k) => ({ gearCmd: k === 0 ? 'up' : null, throttle: k < 120 ? 0.6 : 0, steer: k > 60 && k < 90 ? 0.2 : 0, brakeFront: k >= 120 ? 0.5 : 0 }));

  /**
   * Steps a started run for `n` animation frames.
   * @param {ReturnType<typeof harness>} h Harness.
   * @param {number} n Frames.
   */
  const stepFrames = (h, n) => {
    h.frames.tick(0);
    for (let i = 0; i < n; i += 1) h.frames.tick(1000 / 60);
  };

  it('starts in simple by default, with the sim assists on and thresholds from the turn-signal rule', async () => {
    /** @type {Array<import('../contracts/index.js').SimOptions | undefined>} */
    const options = [];
    const h = harness({ createSim: spySim(options, []) });
    await h.game.start('map-minimal', 'car-sedan');
    const rule = /** @type {import('../contracts/index.js').Rule} */ (BUNDLE.rules.find((r) => r.id === 'turn-signal'));
    expect(options[0]?.assists).toEqual({
      autoGearbox: true,
      signalAutoCancel: { turnMinDeg: rule.detection.params.turnMinDeg, clearM: rule.detection.params.signalFromM },
    });
    expect(h.states.at(-1)?.controlPreset).toBe('simple');
    expect(h.game.debugInfo().controlPreset).toBe('simple');
    expect(h.states.at(-1)?.gear).toBe('D');
    h.game.quit();
    expect(h.states.at(-1)?.report).toBeDefined();
  });

  it('real gives assists off and the frames of a sim created without assists', async () => {
    /** @type {Array<import('../contracts/index.js').SimOptions | undefined>} */
    const options = [];
    /** @type {Frame[]} */
    const real = [];
    const h = harness({ createSim: spySim(options, real), createInput: script });
    await h.game.start('map-minimal', 'car-sedan', { controlPreset: 'real', seed: 7 });
    expect(options[0]?.assists).toEqual({ autoGearbox: false, signalAutoCancel: null });
    expect(h.states.at(-1)?.controlPreset).toBe('real');
    stepFrames(h, 180);
    h.game.quit();

    /** @type {Frame[]} */
    const plain = [];
    const baseline = harness({
      createSim: (rapier, map, vehicle, o) => {
        const { assists: _assists, ...rest } = o ?? {};
        void _assists;
        return recordingSim(plain)(rapier, map, vehicle, rest);
      },
      createInput: script,
    });
    await baseline.game.start('map-minimal', 'car-sedan', { controlPreset: 'real', seed: 7 });
    stepFrames(baseline, 180);
    baseline.game.quit();
    expect(real.length).toBeGreaterThan(150);
    expect(JSON.stringify(real)).toBe(JSON.stringify(plain));
  });

  it('gives the same score and report under both presets for the same frames', async () => {
    const speeding = buildFrames({ map: MAP, vehicle: CAR, laneId: 'rw-e', startS: 5, durationS: 3, speed: 70 / 3.6 });
    /** @type {Array<import('../contracts/index.js').ScoreReport | undefined>} */
    const reports = [];
    for (const controlPreset of /** @type {const} */ (['simple', 'real'])) {
      const h = harness({ createSim: () => replaySim(speeding) });
      await h.game.start('map-minimal', 'car-sedan', { controlPreset });
      runUntil(h.frames, () => h.states.at(-1)?.runStatus === 'finished');
      reports.push(h.states.at(-1)?.report);
    }
    expect(reports[0]).toBeDefined();
    expect(reports[0]).toEqual(reports[1]);
  });

  it('restart keeps the preset, and an unknown preset is simple', async () => {
    /** @type {Array<import('../contracts/index.js').SimOptions | undefined>} */
    const options = [];
    const h = harness({ createSim: spySim(options, []) });
    await h.game.start('map-minimal', 'car-sedan', { controlPreset: 'real' });
    h.game.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options).toHaveLength(2);
    expect(options[1]?.assists?.autoGearbox).toBe(false);
    expect(h.states.at(-1)?.controlPreset).toBe('real');
    await h.game.start('map-minimal', 'car-sedan', { controlPreset: /** @type {never} */ ('arcade') });
    expect(h.states.at(-1)?.controlPreset).toBe('simple');
    h.game.quit();
  });

  it('forwards on-screen controls to the run input, and ignores them with no run', async () => {
    const h = harness({ createSim });
    h.game.controls.hold('throttle', true);
    h.game.controls.press('gearUp');
    h.game.controls.steer(0.5);
    await h.game.start('map-minimal', 'scooter');
    h.game.controls.hold('brake', true);
    stepFrames(h, 10);
    const braking = h.states.at(-1);
    expect(braking?.controls.throttle).toBe(0);
    expect(braking?.controls.brakeFront).toBeGreaterThan(0);
    expect(braking?.controls.brakeRear).toBeGreaterThan(0);
    h.game.controls.hold('brake', false);
    h.game.controls.hold('throttle', true);
    h.game.controls.steer(-0.4);
    stepFrames(h, 30);
    const driving = h.states.at(-1);
    expect(driving?.controls.throttle).toBe(1);
    expect(driving?.controls.steer).toBeCloseTo(-0.4, 10);
    expect(driving?.controls.brakeFront).toBe(0);
    h.game.controls.press('pause');
    expect(h.states.at(-1)?.runStatus).toBe('paused');
    h.game.quit();
    expect(() => h.game.controls.hold('horn', true)).not.toThrow();
    expect(h.errors).toEqual([]);
  });
});
