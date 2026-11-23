/**
 * Physics autopilot for scenario tests (Node only). It drives the real sim (Rapier) along a path,
 * closed loop: pure pursuit for steering along the lane centreline, a speed controller that tracks
 * the target from the shared stop logic (`speedTarget`), and the turn signal, headlight and gear
 * commands a driver would give. It is kept small on purpose: no overtaking; a lane change is only
 * the one the route's checkpoints draw, signalled as the kinematic plan signals it.
 *
 * The run is scored twice: live, one scorer step per sim frame, and replayed with `scoreRun` over
 * the recorded frames. The two must agree, `endedBy` included.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { DT, mpsToKmh } from '../../../src/contracts/units.js';
import { createSim } from '../../../src/sim/index.js';
import { createScorer, scoreRun } from '../../../src/scoring/index.js';
import { angleDiff, headingOf, pointAtDistance, polylineLength, projectOntoPolyline } from '../../../src/geometry/index.js';
import { neutralInput } from '../../../src/contracts/controls.js';
import { SCOOTER_FRONT_BRAKE_PER_GRIP } from '../../../src/game/input.js';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { CLEAN_KMH, gatesOf, routePath, signalWindows, speedTarget, vehicleOf } from '../kinematic/drive.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */
/** @typedef {import('../../../src/contracts/index.js').ControlInput} ControlInput */
/** @typedef {import('../../../src/contracts/index.js').Indicators} Indicators */
/** @typedef {import('../kinematic/drive.js').GateKind} GateKind */

const SHIFT_UP_KMH = [15, 30, 45, 60];
const LOCK_RAD = 0.6;
const LOCK_REF_MPS = 15;
const WHEELBASE_M = { car: 2.7, motorbike: 1.3 };
/** Speed through a corner of the route, where the path bends tighter than about 10 m radius. */
const CORNER_MPS = 4;
const CORNER_CURVATURE = 0.1;

/**
 * Rapier, initialised once per test process.
 * @returns {Promise<typeof RAPIER>} Rapier module.
 */
export async function initRapier() {
  await RAPIER.init();
  return RAPIER;
}

/**
 * @param {number} x Value.
 * @param {number} lo Low.
 * @param {number} hi High.
 * @returns {number} Clamped value.
 */
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Stretches of the path that bend tighter than the corner curvature, as distance intervals.
 * @param {Vec2[]} line Path.
 * @returns {Array<{from: number, to: number}>} Corners, 5 m padded at each end.
 */
function cornerStretches(line) {
  const total = polylineLength(line);
  /** @type {Array<{from: number, to: number}>} */
  const out = [];
  for (let s = 0; s <= total; s += 0.5) {
    const a = pointAtDistance(line, Math.max(0, s - 1)).heading;
    const b = pointAtDistance(line, Math.min(total, s + 1)).heading;
    if (Math.abs(angleDiff(a, b)) / 2 < CORNER_CURVATURE) continue;
    const last = out.at(-1);
    if (last && s - last.to < 1) last.to = s;
    else out.push({ from: Math.max(0, s - 5), to: s });
  }
  for (const k of out) k.to += 5;
  return out;
}

/**
 * Control input for one step from the last frame.
 * @param {object} c Controller state.
 * @param {Frame} frame Last frame.
 * @returns {Partial<ControlInput>} Input.
 */
function decide(c, frame) {
  const { map, line, total, gates, cruise, ignore, signals, veh, lightsWanted, windows } = c;
  const x = frame.ego.pos.x;
  const z = frame.ego.pos.z;
  const v = frame.ego.speed;
  const s = projectOntoPolyline([x, z], line).s;
  let target = speedTarget(gates, { t: frame.t, s, v, poses: frame.actors }, { cruise, ignore, signals, map });
  if (c.corners.some((k) => s >= k.from && s <= k.to)) target = Math.min(target, CORNER_MPS);

  /** @type {Partial<ControlInput>} */
  const input = { ...neutralInput() };
  if (target <= 0.01 && v < 0.5) {
    input.brakeFront = 1;
    input.brakeRear = 0.7;
  } else {
    const err = target - v;
    if (err > 0) input.throttle = clamp(0.15 + err * 0.4, 0, 1);
    else {
      input.brakeFront = clamp(0.2 - err * 0.8, 0, 1);
      input.brakeRear = input.brakeFront * 0.5;
    }
  }

  if (veh.legalClass !== 'car') {
    // A key cannot be squeezed halfway, so the rider's front brake is capped as the game caps S.
    const cap = Math.min(1, SCOOTER_FRONT_BRAKE_PER_GRIP * map.environment.surfaceGrip);
    input.brakeFront = Math.min(input.brakeFront ?? 0, cap);
  }

  const ld = 4 + 0.4 * v;
  const look = pointAtDistance(line, Math.min(total, s + ld)).point;
  // Positive when the target lies to the left of the heading.
  const alpha = angleDiff(frame.ego.heading, headingOf(look[0] - x, look[1] - z));
  const wheelbase = veh.legalClass === 'car' ? WHEELBASE_M.car : WHEELBASE_M.motorbike;
  const delta = Math.atan2(2 * wheelbase * Math.sin(alpha), ld);
  const lock = LOCK_RAD / (1 + v / LOCK_REF_MPS);
  input.steer = clamp(-delta / lock, -1, 1);

  // The indicator toggles on each command, so send one only when the state must change.
  const active = windows.find((w) => s >= w.from && s <= w.to);
  const wantSide = active ? active.side : 'off';
  if (frame.ego.indicators !== wantSide) input.signalCmd = wantSide === 'off' ? frame.ego.indicators : wantSide;

  if (frame.ego.lights !== lightsWanted && c.lightsPressed < 4) {
    input.lightsCmd = 'cycle';
    c.lightsPressed += 1;
  }

  if (veh.legalClass === 'car' && typeof frame.ego.gear === 'number' && frame.t - c.lastShiftT > 0.6) {
    const kmh = mpsToKmh(v);
    const g = frame.ego.gear;
    if (g < 5 && kmh > SHIFT_UP_KMH[g - 1] + 2) {
      input.gearCmd = 'up';
      c.lastShiftT = frame.t;
    } else if (g > 1 && kmh < SHIFT_UP_KMH[g - 2] - 6) {
      input.gearCmd = 'down';
      c.lastShiftT = frame.t;
    }
  } else if (veh.legalClass === 'car' && frame.ego.gear === 'N' && target > 0 && frame.t - c.lastShiftT > 0.6) {
    input.gearCmd = 'up';
    c.lastShiftT = frame.t;
  }
  return input;
}

/**
 * @typedef {object} PhysicsOptions
 * @property {Vec2[]} [path] Path; defaults to the route.
 * @property {number} [cruiseMps] Cruising speed (default 30 km/h).
 * @property {GateKind[]} [ignore] Requirements the driver ignores.
 * @property {boolean} [lights] Headlights on for the run; default on at night and in rain.
 * @property {number} [maxS] Stop once the ego is this far along the path.
 */

/**
 * A driver for one run: `next(frame)` gives the input for the next sim step, and `next(null)` the
 * first one. The driver reads only the frame it is given, so it can sit in any loop that feeds
 * frames back.
 * @param {GameMap} map Map.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 * @param {PhysicsOptions} [options] Options.
 * @returns {{next: (frame: Frame | null) => Partial<ControlInput>, vehicle: VehicleInfo, line: Vec2[], total: number}}
 *   Driver.
 */
export function createDriver(map, vehicleId, options = {}) {
  const veh = vehicleOf(vehicleId);
  const line = options.path ?? routePath(map);
  const total = polylineLength(line);
  const env = map.environment;
  const night = env.startClockMin >= 1080 || env.startClockMin < 360;
  const lightsWanted = (options.lights ?? (env.weather === 'rain' || night)) ? 'low' : 'off';
  const cruise = options.cruiseMps ?? CLEAN_KMH / 3.6;
  const controller = {
    map,
    line,
    total,
    gates: gatesOf(map, line, veh.lengthM / 2),
    cruise,
    ignore: new Set(options.ignore ?? []),
    signals: new Map(map.signals.map((sig) => [sig.id, sig])),
    veh,
    lightsWanted,
    lightsPressed: 0,
    lastShiftT: -10,
    windows: signalWindows(map, line, cruise),
    corners: cornerStretches(line),
  };
  return {
    vehicle: veh,
    line,
    total,
    next(frame) {
      if (frame) return decide(controller, frame);
      return { ...neutralInput(), gearCmd: veh.legalClass === 'car' ? /** @type {const} */ ('up') : null };
    },
  };
}

/**
 * Drives the sim along the path and scores the run live and by replay.
 * @param {GameMap} map Map.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 * @param {PhysicsOptions} [options] Options.
 * @returns {Promise<{frames: Frame[], live: import('../../../src/contracts/index.js').ScoreReport, replay: import('../../../src/contracts/index.js').ScoreReport, finalS: number, total: number}>}
 *   Frames, the live and replayed reports, and how far the run got.
 */
export async function drivePhysics(map, vehicleId, options = {}) {
  const R = await initRapier();
  const bundle = await realBundle();
  const driver = createDriver(map, vehicleId, options);
  const veh = driver.vehicle;
  const { line, total } = driver;
  const sim = createSim(R, map, veh);
  const scorer = createScorer(bundle, map, veh);
  const maxSteps = Math.ceil((map.route.timeLimitS + 5) / DT);
  const maxS = options.maxS ?? total;
  /** @type {Frame[]} */
  const frames = [];
  let live = scorer.initial;
  /** @type {Frame | null} */
  let prev = null;
  let finalS = 0;
  try {
    for (let k = 0; k < maxSteps; k += 1) {
      const input = driver.next(prev);
      const f = sim.step(input);
      frames.push(f);
      live = scorer.step(live, f).state;
      prev = f;
      finalS = projectOntoPolyline([f.ego.pos.x, f.ego.pos.z], line).s;
      if (f.events.some((e) => e.type === 'finish' || e.type === 'timeout')) break;
      if (finalS >= maxS - 0.5 && f.ego.speed < 0.2) break;
    }
  } finally {
    if (typeof sim.dispose === 'function') sim.dispose();
  }
  const liveReport = scorer.report(live, { quit: false });
  const replay = scoreRun(bundle, map, veh, frames, { quit: false });
  return { frames, live: liveReport, replay, finalS, total };
}
