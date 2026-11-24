/**
 * Physics autopilot for scenario tests (Node only). It drives the real sim (Rapier) along a path,
 * closed loop: pure pursuit for steering along the lane centreline, a speed controller that tracks
 * the target from the shared stop logic (`speedTarget`), and the turn signal, headlight and gear
 * commands a driver would give. It never overtakes; a lane change is only the one the route's
 * checkpoints draw, signalled as the kinematic plan signals it.
 *
 * With `aware` on (the default when traffic runs) it drives lawfully around other road users,
 * reading only the actor poses of the last frame:
 * - it follows the nearest body in its path (now or within a short prediction) with the traffic
 *   IDM (`src/world/traffic/idm.js`), so it waits behind queues and wrecks and lets riders cut in;
 * - before a lane line crossing it checks the gaps the `lane-change` rule judges, with a margin,
 *   and slows before the line until the target lane is clear;
 * - past a STOP or give-way line it enters the junction only when nothing crossing is inside it
 *   or will reach it before the ego has cleared it.
 *
 * The run is scored twice: live, one scorer step per sim frame, and replayed with `scoreRun` over
 * the recorded frames. The two must agree, `endedBy` included.
 */

import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { DT, mpsToKmh } from '../../../src/contracts/units.js';
import { locate } from '../../../src/map-query/index.js';
import { createSim } from '../../../src/sim/index.js';
import { createScorer, scoreRun } from '../../../src/scoring/index.js';
import {
  angleDiff,
  headingOf,
  headingVector,
  pointAtDistance,
  pointInPolygon,
  polylineLength,
  projectOntoPolyline,
  slicePolyline,
} from '../../../src/geometry/index.js';
import { idmAcceleration } from '../../../src/world/traffic/idm.js';
import { neutralInput } from '../../../src/contracts/controls.js';
import { SCOOTER_FRONT_BRAKE_PER_GRIP } from '../../../src/game/input.js';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { CLEAN_KMH, gatesOf, insideS, laneLineCrossings, routePath, signalWindows, speedTarget, vehicleOf } from '../kinematic/drive.js';

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

/** IDM of the ego against a leader: a lawful, unhurried driver. */
const IDM = { a: 1.5, b: 2.5, timeGap: 1.4, s0: 2.5, delta: 4 };
/** How far behind and ahead of the ego the path is searched for other road users, metres. */
const LOOK_BACK_M = 40;
const LOOK_AHEAD_M = 70;
/** Prediction instants for bodies moving into the path, seconds. */
const PREDICT_S = [0, 0.5, 1, 1.5, 2];
/** Lateral clearance added to both half widths before a body counts as in the path, metres. */
const CORRIDOR_MARGIN_M = 0.4;
/** Margins added to the `lane-change` rule's gaps before a merge, metres and seconds. */
const MERGE_MARGIN_M = 2;
const MERGE_MARGIN_S = 0.6;
/** The gap check runs from this far before a lane line crossing, metres. */
const MERGE_CHECK_M = 25;
/** Distance before a junction entry where the gap check at a STOP or give-way line runs, metres. */
const JUNCTION_CHECK_M = 10;
/** Time kept between the ego clearing a junction and another road user arriving in it, seconds. */
const JUNCTION_MARGIN_S = 2;
/** Speed the ego is assumed to cross a junction at when slower, m/s. */
const JUNCTION_CROSS_MPS = 3;
/** Deceleration used to stop before a merge or junction entry that is not clear, m/s². */
const HOLD_DECEL = 2.5;

/**
 * Bodies of the last frame near the ego, projected onto the path around the ego.
 * @param {object} c Controller state.
 * @param {Frame} frame Frame.
 * @param {number} s Ego distance along the path.
 * @returns {Array<{pose: import('../../../src/contracts/index.js').ActorPose, s: number, lateral: number, along: number, rel: number, window: Vec2[], from: number}>}
 *   Nearby bodies with their distance along the path, lateral offset (left positive), speed along
 *   the path and heading relative to the path, and the searched stretch starting at `from`.
 */
function nearbyBodies(c, frame, s) {
  const from = Math.max(0, s - LOOK_BACK_M);
  const window = slicePolyline(c.line, from, Math.min(c.total, s + LOOK_AHEAD_M));
  const out = [];
  const reach = LOOK_AHEAD_M + 10;
  for (const pose of frame.actors) {
    if (Math.hypot(pose.pos.x - frame.ego.pos.x, pose.pos.z - frame.ego.pos.z) > reach) continue;
    const pr = projectOntoPolyline([pose.pos.x, pose.pos.z], window);
    // Past either end of the searched stretch the nearest point is an end point, not abreast.
    if (pr.distance - Math.abs(pr.lateral) > 0.05) continue;
    const rel = angleDiff(pose.heading, pr.heading);
    out.push({ pose, s: from + pr.s, lateral: pr.lateral, along: pose.speed * Math.cos(rel), rel, window, from });
  }
  return out;
}

/**
 * Half extent of a body along and across a direction at angle `rel` to its heading.
 * @param {{lengthM: number, widthM: number}} body Body.
 * @param {number} rel Relative heading.
 * @returns {{along: number, across: number}} Half extents.
 */
function halfExtents(body, rel) {
  const cs = Math.abs(Math.cos(rel));
  const sn = Math.abs(Math.sin(rel));
  return { along: (body.lengthM * cs + body.widthM * sn) / 2, across: (body.lengthM * sn + body.widthM * cs) / 2 };
}

/**
 * Speed target from following the nearest body in the path, now or predicted, by the IDM.
 * @param {object} c Controller state.
 * @param {Frame} frame Frame.
 * @param {number} s Ego distance along the path.
 * @param {number} cruise Desired speed.
 * @param {ReturnType<typeof nearbyBodies>} bodies Nearby bodies.
 * @returns {number} Target speed, m/s.
 */
function followTarget(c, frame, s, cruise, bodies) {
  const v = frame.ego.speed;
  const egoHalfL = c.veh.lengthM / 2;
  const egoHalfW = c.veh.widthM / 2;
  let gap = Infinity;
  let leadV = 0;
  for (const b of bodies) {
    if (b.s <= s) continue;
    const [hx, hz] = headingVector(b.pose.heading);
    for (const tau of PREDICT_S) {
      let bs = b.s;
      let lat = b.lateral;
      if (tau > 0) {
        if (b.pose.speed < 0.3) break;
        const pr = projectOntoPolyline([b.pose.pos.x + hx * b.pose.speed * tau, b.pose.pos.z + hz * b.pose.speed * tau], b.window);
        if (pr.distance - Math.abs(pr.lateral) > 0.05) break;
        bs = b.from + pr.s;
        lat = pr.lateral;
      }
      const ext = halfExtents(b.pose, b.rel);
      if (Math.abs(lat) > egoHalfW + ext.across + CORRIDOR_MARGIN_M) continue;
      const g = bs - s - egoHalfL - ext.along;
      // A body already abreast that only the margin reaches is passed, not followed.
      if (g < 0 && Math.abs(lat) > egoHalfW + ext.across) break;
      if (g < gap) {
        gap = g;
        leadV = Math.max(0, b.along);
      }
      break;
    }
  }
  if (gap === Infinity) return cruise;
  if (gap < 0.8) return 0;
  const acc = idmAcceleration(v, Math.max(cruise, 0.5), gap, v - leadV, IDM.a, IDM.b, IDM.timeGap, IDM.s0, IDM.delta);
  return Math.max(0, v + acc * 0.6);
}

/**
 * Whether merging across the lane line at `crossing.s` would leave a vehicle too close, by the
 * `lane-change` rule's gap test plus a margin, predicted to the moment the ego reaches the line.
 * @param {object} c Controller state.
 * @param {Frame} frame Frame.
 * @param {number} s Ego distance along the path.
 * @param {{s: number, laneId: string | null}} crossing Crossing.
 * @param {ReturnType<typeof nearbyBodies>} bodies Nearby bodies.
 * @returns {boolean} True when the merge must wait.
 */
function mergeBlocked(c, frame, s, crossing, bodies) {
  if (crossing.laneId === null) return false;
  const v = Math.max(frame.ego.speed, 1);
  const tc = (crossing.s - s) / v;
  const gp = c.gapParams;
  for (const b of bodies) {
    const p = b.pose;
    if (p.kind === 'pedestrian' || Math.abs(b.rel) > Math.PI / 2) continue;
    if (locate(c.map, [p.pos.x, p.pos.z], p.heading).laneId !== crossing.laneId) continue;
    const along = b.s + b.along * tc - crossing.s;
    const gap = Math.abs(along) - (c.veh.lengthM + p.lengthM) / 2;
    const ahead = along >= 0;
    const floor = p.speed < gp.stoppedSpeedMps || p.kind !== 'motorbike' ? (ahead ? gp.gapAheadM : gp.gapBehindM) : gp.gapMotorbikeMinM;
    const timeGap = p.speed < gp.stoppedSpeedMps ? 0 : (gp.gapTimeS + MERGE_MARGIN_S) * (ahead ? frame.ego.speed : b.along);
    if (gap < Math.max(floor + MERGE_MARGIN_M, timeGap)) return true;
  }
  return false;
}

/**
 * Whether a junction the ego must yield at is not clear to enter: a crossing road user is moving
 * inside it, or will reach it before the ego has crossed it plus a margin.
 * @param {object} c Controller state.
 * @param {Frame} frame Frame.
 * @param {number} s Ego distance along the path.
 * @param {PathJunction} j Junction on the path.
 * @param {ReturnType<typeof nearbyBodies>} bodies Nearby bodies.
 * @returns {boolean} True when the ego must wait.
 */
function junctionBlocked(c, frame, s, j, bodies) {
  const clearS = (j.exit - s + c.veh.lengthM) / Math.max(frame.ego.speed, JUNCTION_CROSS_MPS) + JUNCTION_MARGIN_S;
  for (const b of bodies) {
    const p = b.pose;
    // A body travelling the ego's way is a leader or a neighbour, not a conflict.
    if (Math.abs(b.rel) < 0.5) continue;
    const at = /** @type {Vec2} */ ([p.pos.x, p.pos.z]);
    if (pointInPolygon(at, j.polygon)) {
      if (p.speed > 0.3 || p.kind === 'pedestrian') return true;
      continue;
    }
    if (p.speed < 0.5) continue;
    const [hx, hz] = headingVector(p.heading);
    for (let tau = 0.5; tau <= clearS; tau += 0.5) {
      if (pointInPolygon([at[0] + hx * p.speed * tau, at[1] + hz * p.speed * tau], j.polygon)) return true;
    }
  }
  return false;
}

/**
 * Speed target from other road users: following, merge gaps and junction gaps.
 * @param {object} c Controller state.
 * @param {Frame} frame Frame.
 * @param {number} s Ego distance along the path.
 * @param {number} target Target from the stop logic.
 * @returns {number} Target speed, m/s.
 */
function trafficTarget(c, frame, s, target) {
  if (frame.actors.length === 0) return target;
  const bodies = nearbyBodies(c, frame, s);
  if (bodies.length === 0) return target;
  let out = Math.min(target, followTarget(c, frame, s, target, bodies));
  const front = s + c.veh.lengthM / 2;
  for (const x of c.crossings) {
    if (s < x.s - MERGE_CHECK_M || s > x.s - 1) continue;
    if (mergeBlocked(c, frame, s, x, bodies)) out = Math.min(out, Math.sqrt(2 * HOLD_DECEL * Math.max(0, x.s - 3 - s)));
  }
  for (const j of c.junctions) {
    if (front < j.enter - JUNCTION_CHECK_M || front > j.enter - 0.5) continue;
    if (junctionBlocked(c, frame, s, j, bodies)) out = Math.min(out, Math.sqrt(2 * HOLD_DECEL * Math.max(0, j.enter - 1 - front)));
  }
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
  if (c.aware) target = trafficTarget(c, frame, s, target);

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
 * Gap parameters of the `lane-change` rule, read from the built rules bundle.
 * @returns {{gapAheadM: number, gapBehindM: number, gapTimeS: number, gapMotorbikeMinM: number, stoppedSpeedMps: number}}
 *   Parameters.
 */
function laneChangeGaps() {
  const file = new URL('../../../src/generated/rules.json', import.meta.url);
  const bundle = JSON.parse(readFileSync(file, 'utf8'));
  const p = bundle.rules.find((/** @type {{id: string}} */ r) => r.id === 'lane-change')?.detection.params;
  const keys = ['gapAheadM', 'gapBehindM', 'gapTimeS', 'gapMotorbikeMinM', 'stoppedSpeedMps'];
  if (!p || keys.some((k) => typeof p[k] !== 'number')) throw new Error('The lane-change rule lacks its gap params');
  return p;
}

/**
 * @typedef {object} PathJunction
 * @property {number} enter Distance along the path where it enters the junction.
 * @property {number} exit Distance where it leaves.
 * @property {Vec2[]} polygon Junction polygon.
 */

/**
 * Junctions on the path whose approach the ego must yield at (a STOP or give-way line), with the
 * path interval inside.
 * @param {GameMap} map Map.
 * @param {Vec2[]} line Path.
 * @returns {PathJunction[]} Junctions in path order.
 */
function yieldJunctions(map, line) {
  const yieldLines = gatesOf(map, line, 0).filter((g) => g.kind === 'stop-sign' || g.kind === 'give-way');
  /** @type {PathJunction[]} */
  const out = [];
  for (const j of map.junctions) {
    const r = insideS(line, j.polygon);
    if (!r || !yieldLines.some((g) => Math.abs(g.s - r.enter) < 15)) continue;
    out.push({ enter: r.enter, exit: r.exit, polygon: j.polygon });
  }
  return out.sort((a, b) => a.enter - b.enter);
}

/**
 * @typedef {object} PhysicsOptions
 * @property {Vec2[]} [path] Path; defaults to the route.
 * @property {number} [cruiseMps] Cruising speed (default 30 km/h).
 * @property {GateKind[]} [ignore] Requirements the driver ignores.
 * @property {boolean} [lights] Headlights on for the run; default on at night and in rain.
 * @property {number} [maxS] Stop once the ego is this far along the path.
 * @property {import('../../../src/contracts/index.js').SimOptions} [sim] Options passed to
 *   `createSim` (traffic, run seed, parameters, assists); default none.
 * @property {boolean} [aware] Drive around other road users (following, merge and junction gaps);
 *   default on when `sim.traffic` is `map`. Off, the driver sees only crosswalk pedestrians, which
 *   the contact scenarios rely on to reach a scripted actor.
 * @property {number} [leaveIndicatorAfterExitM] For this distance after each junction exit the
 *   driver sends no indicator command, leaving the indicator to the auto-cancel; default 0 (off).
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
    aware: options.aware ?? options.sim?.traffic === 'map',
    gapParams: laneChangeGaps(),
    crossings: laneLineCrossings(map, line).map((x) => {
      const after = pointAtDistance(line, Math.min(total, x.s + 6));
      return { s: x.s, laneId: locate(map, after.point, after.heading).laneId };
    }),
    junctions: yieldJunctions(map, line),
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
 * @returns {Promise<{frames: Frame[], live: import('../../../src/contracts/index.js').ScoreReport, replay: import('../../../src/contracts/index.js').ScoreReport, finalS: number, total: number, vehicle: import('../../../src/contracts/index.js').VehicleInfo}>}
 *   Frames, the live and replayed reports, how far the run got, and the vehicle.
 */
export async function drivePhysics(map, vehicleId, options = {}) {
  const R = await initRapier();
  const bundle = await realBundle();
  const driver = createDriver(map, vehicleId, options);
  const veh = driver.vehicle;
  const { line, total } = driver;
  const sim = createSim(R, map, veh, options.sim ?? {});
  const scorer = createScorer(bundle, map, veh);
  const maxSteps = Math.ceil((map.route.timeLimitS + 5) / DT);
  const maxS = options.maxS ?? total;
  /** @type {Frame[]} */
  const frames = [];
  let live = scorer.initial;
  /** @type {Frame | null} */
  let prev = null;
  let finalS = 0;
  const quietM = options.leaveIndicatorAfterExitM ?? 0;
  /** @type {string | null} */
  let inJunction = null;
  let sinceExitM = Infinity;
  try {
    for (let k = 0; k < maxSteps; k += 1) {
      let input = driver.next(prev);
      if (sinceExitM < quietM) input = { ...input, signalCmd: null };
      const f = sim.step(input);
      if (quietM > 0) {
        if (prev) sinceExitM += Math.hypot(f.ego.pos.x - prev.ego.pos.x, f.ego.pos.z - prev.ego.pos.z);
        const j = locate(map, [f.ego.pos.x, f.ego.pos.z], f.ego.heading).junctionId;
        if (inJunction !== null && j !== inJunction) sinceExitM = 0;
        inJunction = j;
      }
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
  return { frames, live: liveReport, replay, finalS, total, vehicle: veh };
}
