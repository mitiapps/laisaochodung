/**
 * Kinematic driver for scenario tests (Node only). It plans a run over a shipped map: a path
 * through the route checkpoints, a speed profile that obeys signals, stop and give-way lines and
 * crosswalks, indicators for turns, and headlights at night or in rain. The plan is then built
 * into frames by `buildFrames` and scored with the real bundle, so each scenario runs the real
 * frame builder and the real scorer.
 *
 * The planner steps the actors with the same `stepActors` call the frame builder makes, so a
 * pedestrian that the ego would meet is seen in the forward pass. Break scenarios reuse a plan and
 * change one thing (`ignore`, `cruiseMps`), so a clean run and its break differ only where the
 * rule is about.
 */

import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import path from 'node:path';
import { DT, kmhToMps } from '../../../src/contracts/units.js';
import { buildFrames } from '../../../src/testing/index.js';
import { createScorer } from '../../../src/scoring/index.js';
import {
  angleDiff,
  footprint,
  headingOf,
  headingVector,
  leftVector,
  pointAtDistance,
  pointInPolygon,
  polylineLength,
  segmentIntersection,
} from '../../../src/geometry/index.js';
import { clockAt, createActorState, finishTarget, signalState, stepActors } from '../../../src/world/index.js';
import { distanceToPolygon } from '../../../src/map-query/index.js';
import { ROOT, realBundle, vehicle as catalogVehicle } from '../../../scripts/rules/lib/test-support.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../../../src/contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */
/** @typedef {import('../../../src/contracts/index.js').ScoreReport} ScoreReport */
/** @typedef {import('../../../src/contracts/index.js').ActorPose} ActorPose */
/** @typedef {import('../../../src/contracts/index.js').Lights} Lights */
/** @typedef {import('../../../src/testing/frame-builder.js').ForcedEvent} ForcedEvent */
/** @typedef {import('../../../src/testing/frame-builder.js').ControlChange} ControlChange */

/** Cruising speed of the clean runs: under every posted and default limit on the shipped maps. */
export const CLEAN_KMH = 30;
const ACCEL_MPS2 = 2.5;
const BRAKE_MPS2 = 2.5;
const STOP_WAIT_S = 1.5;
const SLOW_MPS = 2.5;
const GIVE_WAY_M = 9;
const TURN_SIGNAL_M = 45;
const TURN_SIGNAL_OFF_M = 15;
const HOLD_DECISION_M = 60;
const PEDESTRIAN_MARGIN_M = 1.5;
const CORNER_RADIUS_M = 4;

/** @typedef {'signal' | 'stop-sign' | 'give-way' | 'crosswalk'} GateKind */

/**
 * A stop requirement on the path.
 * @typedef {object} Gate
 * @property {GateKind} kind Stop-line control or a crosswalk.
 * @property {string} id Stop line or crosswalk id.
 * @property {string | null} signalId Signal of a signalised line.
 * @property {number} s Distance of the line (or crosswalk entry) on the path.
 * @property {number} sStop Distance where the ego halts or slows.
 * @property {boolean} latched The ego has committed to halt for this gate.
 * @property {number} haltedAt Time the ego first stood still at the gate, or -1.
 */

/**
 * @typedef {object} PlanOptions
 * @property {Vec2[]} [path] Path; defaults to the route.
 * @property {number} [cruiseMps] Cruising speed in m/s (default 30 km/h).
 * @property {GateKind[]} [ignore] Requirements not honoured by this plan.
 * @property {boolean} [turnSignals] Signal turns at junctions (default true).
 * @property {boolean} [laneChangeSignals] Signal lane changes (default true for `planDrive`, false
 *   for `constantPlan`, whose scripted paths set their own indicators).
 * @property {Lights} [lights] Headlights for the whole run; default on at night and in rain.
 * @property {ControlChange[]} [controls] Extra control changes, merged with the plan's own.
 * @property {ForcedEvent[]} [events] Injected events, such as a collision.
 */

/**
 * A shipped map from `public/maps`, built by `npm run build:maps`.
 * @param {string} id Map id.
 * @returns {GameMap} Map.
 */
export function loadShippedMap(id) {
  const file = path.join(ROOT, 'public', 'maps', `${id}.json`);
  if (!existsSync(file)) throw new Error(`Missing ${file}; run npm run build:maps first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * A catalogue vehicle by id.
 * @param {'car-sedan' | 'scooter'} id Vehicle id.
 * @returns {VehicleInfo} Vehicle.
 */
export function vehicleOf(id) {
  return catalogVehicle(id);
}

/**
 * Path between two route poses. Each pose leaves along its heading; where the two rays meet ahead
 * of both, the path turns at that corner (a junction crossing), otherwise it runs straight. Aligned
 * poses on one road therefore stay on the lane centre.
 * @param {{pos: {x: number, z: number} | Vec2, heading: number}} a Start pose.
 * @param {{pos: {x: number, z: number} | Vec2, heading: number}} b End pose.
 * @returns {Vec2[]} Points from `a` to `b`, both included.
 */
function joinPoses(a, b) {
  const p0 = toVec(a.pos);
  const p1 = toVec(b.pos);
  const [ax, az] = headingVector(a.heading);
  const [bx, bz] = headingVector(b.heading);
  // Solve p0 + t·da = p1 − u·db for t and u.
  const det = ax * bz - az * bx;
  const rx = p1[0] - p0[0];
  const rz = p1[1] - p0[1];
  if (Math.abs(det) > 1e-9) {
    const t = (rx * bz - rz * bx) / det;
    const u = (ax * rz - az * rx) / det;
    if (t >= -1e-9 && u >= -1e-9) {
      // Round the corner with a quadratic Bezier of up to 4 m, so a physics car can follow it.
      const corner = /** @type {Vec2} */ ([p0[0] + ax * t, p0[1] + az * t]);
      const r = Math.min(CORNER_RADIUS_M, 0.5 * Math.min(t, u));
      if (r < 0.5) return [...sample(p0, corner), ...sample(corner, p1).slice(1)];
      const a0 = /** @type {Vec2} */ ([corner[0] - ax * r, corner[1] - az * r]);
      const a1 = /** @type {Vec2} */ ([corner[0] + bx * r, corner[1] + bz * r]);
      return [...sample(p0, a0), ...bezier(a0, corner, a1).slice(1), ...sample(a1, p1).slice(1)];
    }
  }
  return sample(p0, p1);
}

/**
 * Quadratic Bezier from `a` to `b` with control `c`, about 0.2 m apart.
 * @param {Vec2} a Start.
 * @param {Vec2} c Control point.
 * @param {Vec2} b End.
 * @returns {Vec2[]} Points, both ends included.
 */
function bezier(a, c, b) {
  const n = Math.max(4, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2));
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    const m = 1 - u;
    out.push([m * m * a[0] + 2 * m * u * c[0] + u * u * b[0], m * m * a[1] + 2 * m * u * c[1] + u * u * b[1]]);
  }
  return out;
}

/**
 * Points from `a` to `b` about 0.5 m apart, both included.
 * @param {Vec2} a Start.
 * @param {Vec2} b End.
 * @returns {Vec2[]} Points.
 */
function sample(a, b) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  return out;
}

/**
 * A `{x, z}` or `[x, z]` point as `[x, z]`.
 * @param {{x: number, z: number} | Vec2} p Point.
 * @returns {Vec2} Point.
 */
function toVec(p) {
  return Array.isArray(p) ? p : [p.x, p.z];
}

/**
 * The route as one polyline: start, every checkpoint, then the navigation target of the finish
 * area (the point of the finish band straight ahead of the last checkpoint).
 * @param {GameMap} map Map.
 * @returns {Vec2[]} Path.
 */
export function routePath(map) {
  const last = map.route.checkpoints.at(-1);
  const finishPose = { pos: finishTarget(map), heading: last.heading };
  const poses = [map.route.start, ...map.route.checkpoints, finishPose];
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i < poses.length - 1; i += 1) {
    const leg = joinPoses(poses[i], poses[i + 1]);
    out.push(...(i === 0 ? leg : leg.slice(1)));
  }
  return out;
}

/**
 * Distance along a polyline of the first crossing with a segment.
 * @param {Vec2[]} line Polyline.
 * @param {Vec2} q1 Segment start.
 * @param {Vec2} q2 Segment end.
 * @returns {number | null} Distance, or null when the polyline does not cross.
 */
function crossingS(line, q1, q2) {
  let acc = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const len = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    const hit = segmentIntersection(line[i], line[i + 1], q1, q2);
    if (hit) return acc + hit.t * len;
    acc += len;
  }
  return null;
}

/**
 * Interval of the polyline inside a polygon: first entry and first exit, with headings.
 * @param {Vec2[]} line Polyline.
 * @param {Vec2[]} polygon Polygon.
 * @returns {{enter: number, exit: number, enterHeading: number, exitHeading: number} | null}
 *   Interval, or null when the polyline never enters.
 */
export function insideS(line, polygon) {
  const total = polylineLength(line);
  const step = 0.25;
  /** @type {{s: number, heading: number} | null} */
  let enter = null;
  /** @type {{s: number, heading: number} | null} */
  let exit = null;
  for (let s = 0; s <= total; s += step) {
    const at = pointAtDistance(line, s);
    const inside = pointInPolygon(at.point, polygon);
    if (inside && enter === null) enter = { s, heading: at.heading };
    if (!inside && enter !== null) {
      exit = { s, heading: at.heading };
      break;
    }
  }
  if (enter === null) return null;
  const end = exit ?? { s: total, heading: pointAtDistance(line, total).heading };
  return { enter: enter.s, exit: end.s, enterHeading: enter.heading, exitHeading: end.heading };
}

/**
 * Stop requirements along the path, in path order. The ego halts with its front 1 m behind the
 * line, so the stop point sits half a vehicle length plus 1 m before it.
 * @param {GameMap} map Map.
 * @param {Vec2[]} line Path.
 * @param {number} halfLengthM Half the vehicle length.
 * @returns {Gate[]} Gates.
 */
export function gatesOf(map, line, halfLengthM) {
  const back = halfLengthM + 1;
  /** @type {Gate[]} */
  const gates = [];
  for (const sl of map.stopLines) {
    const s = crossingS(line, sl.segment[0], sl.segment[1]);
    if (s === null) continue;
    gates.push({
      kind: /** @type {GateKind} */ (sl.control),
      id: sl.id,
      signalId: sl.signalId ?? null,
      s,
      sStop: s - back,
      latched: false,
      haltedAt: -1,
    });
  }
  for (const cw of map.crosswalks) {
    const r = insideS(line, cw.polygon);
    if (r) gates.push({ kind: 'crosswalk', id: cw.id, signalId: null, s: r.enter, sStop: r.enter - back, latched: false, haltedAt: -1 });
  }
  return gates.sort((a, b) => a.s - b.s);
}

/**
 * Whether a pedestrian stands on or next to a crosswalk.
 * @param {GameMap} map Map.
 * @param {string} crosswalkId Crosswalk id.
 * @param {ActorPose[]} poses Actor poses of the last step.
 * @returns {boolean} True when a pedestrian is within the margin of the crosswalk.
 */
function pedestrianOn(map, crosswalkId, poses) {
  const cw = map.crosswalks.find((c) => c.id === crosswalkId);
  if (!cw) return false;
  return poses.some((p) => p.kind === 'pedestrian' && p.active && distanceToPolygon([p.pos.x, p.pos.z], cw.polygon) <= PEDESTRIAN_MARGIN_M);
}

/**
 * Whether the map's start is dark or wet, when headlights are due.
 * @param {GameMap} map Map.
 * @returns {boolean} True when headlights are due at the start.
 */
function lightsAtNight(map) {
  const c = clockAt(map.environment, 0);
  return map.environment.weather === 'rain' || c >= 1080 || c < 360;
}

/**
 * Plans speed, indicators and lights for a run over the map.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {PlanOptions} [options] Options.
 * @returns {Plan} Plan.
 */
export function planDrive(map, vehicleInfo, options = {}) {
  const line = options.path ?? routePath(map);
  const total = polylineLength(line);
  const cruise = options.cruiseMps ?? kmhToMps(CLEAN_KMH);
  const ignore = new Set(options.ignore ?? []);
  const gates = gatesOf(map, line, vehicleInfo.lengthM / 2);
  const signals = new Map(map.signals.map((sig) => [sig.id, sig]));
  const lightsOn = lightsAtNight(map);

  /** @type {Array<{t: number, value: number}>} */
  const speed = [];
  /** @type {number[]} */
  const sPerTick = [];
  let s = 0;
  let v = 0;
  let actorState = createActorState(map);
  /** @type {ActorPose[]} */
  let poses = [];
  const maxTicks = Math.ceil((map.route.timeLimitS * 2) / DT);

  for (let tick = 0; tick < maxTicks && s < total - 1e-6; tick += 1) {
    const t = tick * DT;
    // Footprint exactly as buildFrames computes it, so the actors see the same ego.
    const here = pointAtDistance(line, s);
    const ahead = pointAtDistance(line, Math.min(total, s + v * DT));
    const moved = Math.hypot(ahead.point[0] - here.point[0], ahead.point[1] - here.point[1]);
    const heading = moved > 1e-6 ? headingOf(ahead.point[0] - here.point[0], ahead.point[1] - here.point[1]) : here.heading;
    const fp = footprint({ x: here.point[0], z: here.point[1] }, heading, vehicleInfo.lengthM, vehicleInfo.widthM);

    const target = speedTarget(gates, { t, s, v, poses }, { cruise, ignore, signals, map });

    const vNext = target > v ? Math.min(target, v + ACCEL_MPS2 * DT) : Math.max(target, v - 4 * DT);
    v = Math.max(0, vNext);
    speed.push({ t, value: v });
    sPerTick.push(s);

    const step = stepActors(actorState, map, [fp], v, DT);
    actorState = step.state;
    poses = step.poses;
    s = Math.min(total, s + v * DT);
  }
  if (s < total - 1e-6) throw new Error(`Planner did not reach the path end (s=${s.toFixed(1)} of ${total.toFixed(1)} m)`);

  const controls = controlsFor(map, line, sPerTick, lightsOn, options, cruise);
  return { path: line, speed, controls, events: options.events ?? [], durationS: speed.length * DT, sPerTick };
}

/**
 * Indicator lead time the lane-change rule asks for, from the built rules bundle.
 * @returns {number} Seconds.
 */
function laneChangeLeadS() {
  const file = path.join(ROOT, 'src', 'generated', 'rules.json');
  if (!existsSync(file)) throw new Error(`Missing ${file}; run npm run build:rules first`);
  /** @type {import('../../../src/contracts/index.js').RulesBundle} */
  const bundle = JSON.parse(readFileSync(file, 'utf8'));
  const lead = bundle.rules.find((r) => r.id === 'lane-change')?.detection.params.signalLeadS;
  if (typeof lead !== 'number') throw new Error('The lane-change rule has no signalLeadS');
  return lead;
}

/**
 * Points where a path crosses a painted line between two lanes of the same direction, with the
 * side the path moves to and the lane line crossed.
 * @param {GameMap} map Map.
 * @param {Vec2[]} line Path.
 * @returns {Array<{s: number, side: 'left' | 'right', line: Vec2[]}>} Crossings in path order.
 */
export function laneLineCrossings(map, line) {
  /** @type {Map<string, 'forward' | 'backward'>} */
  const dirOf = new Map();
  for (const road of map.roads) for (const lane of road.lanes) dirOf.set(lane.id, lane.dir);
  /** @type {Array<{s: number, side: 'left' | 'right', line: Vec2[]}>} */
  const out = [];
  let acc = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (const road of map.roads) {
      for (const ll of road.laneLines) {
        if (!ll.left || !ll.right || dirOf.get(ll.left) !== dirOf.get(ll.right)) continue;
        for (let k = 0; k < ll.polyline.length - 1; k += 1) {
          const q1 = ll.polyline[k];
          const q2 = ll.polyline[k + 1];
          const hit = segmentIntersection(a, b, q1, q2);
          if (!hit) continue;
          // Line direction aligned with the travel direction; the move is to its left or right.
          let dx = q2[0] - q1[0];
          let dz = q2[1] - q1[1];
          if (dx * (b[0] - a[0]) + dz * (b[1] - a[1]) < 0) {
            dx = -dx;
            dz = -dz;
          }
          const [lx, lz] = leftVector(headingOf(dx, dz));
          out.push({ s: acc + hit.t * len, side: (b[0] - a[0]) * lx + (b[1] - a[1]) * lz > 0 ? 'left' : 'right', line: ll.polyline });
        }
      }
    }
    acc += len;
  }
  return out.sort((x, y) => x.s - y.s).filter((c, i, all) => i === 0 || c.s - all[i - 1].s > 0.5);
}

/**
 * Where along a path the indicator must be on: each junction turn from 45 m before its entry until
 * 15 m after its exit, and each lane change from the distance covered at `cruiseMps` in the
 * lane-change rule's lead time plus a second until 15 m after the crossing. Overlapping windows of
 * one side merge, so the indicator never goes off between a lane change and the turn it leads to.
 * @param {GameMap} map Map.
 * @param {Vec2[]} line Path.
 * @param {number} cruiseMps Highest planned speed, so the lead in time is at least the rule's.
 * @param {{turns?: boolean, laneChanges?: boolean}} [which] Which windows to include (both default).
 * @returns {Array<{side: 'left' | 'right', from: number, to: number}>} Windows in path order.
 */
export function signalWindows(map, line, cruiseMps, which = {}) {
  /** @type {Array<{side: 'left' | 'right', from: number, to: number}>} */
  const raw = [];
  if (which.turns !== false) {
    for (const j of map.junctions) {
      const r = insideS(line, j.polygon);
      if (!r) continue;
      const delta = angleDiff(r.exitHeading, r.enterHeading);
      if (Math.abs(delta) < (45 * Math.PI) / 180) continue;
      const [lx, lz] = leftVector(r.enterHeading);
      const [ex, ez] = headingVector(r.exitHeading);
      const uTurn = Math.abs(delta) >= (135 * Math.PI) / 180;
      const side = uTurn || ex * lx + ez * lz > 0 ? 'left' : 'right';
      raw.push({ side, from: Math.max(0, r.enter - TURN_SIGNAL_M), to: r.exit + TURN_SIGNAL_OFF_M });
    }
  }
  if (which.laneChanges !== false) {
    const leadM = cruiseMps * (laneChangeLeadS() + 1);
    for (const c of laneLineCrossings(map, line)) raw.push({ side: c.side, from: Math.max(0, c.s - leadM), to: c.s + TURN_SIGNAL_OFF_M });
  }
  raw.sort((a, b) => a.from - b.from);
  /** @type {Array<{side: 'left' | 'right', from: number, to: number}>} */
  const out = [];
  for (const w of raw) {
    const last = out.at(-1);
    if (last && last.side === w.side && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else if (last && w.from <= last.to) {
      // A window of the other side starts: the earlier one ends there.
      last.to = w.from;
      out.push({ ...w });
    } else out.push({ ...w });
  }
  return out;
}

/**
 * Indicators and headlights of a run: lights from the options or the night and rain rule, and the
 * indicator over every signal window of the path (`signalWindows`).
 * @param {GameMap} map Map.
 * @param {Vec2[]} line Path.
 * @param {number[]} sPerTick Distance along the path at each tick.
 * @param {boolean} lightsOn Default headlight state.
 * @param {PlanOptions} options Options.
 * @param {number} cruiseMps Highest planned speed.
 * @returns {ControlChange[]} Controls, sorted by time, with the extra controls of the options.
 */
function controlsFor(map, line, sPerTick, lightsOn, options, cruiseMps) {
  /** @type {ControlChange[]} */
  const controls = [{ t: 0, lights: options.lights ?? (lightsOn ? 'low' : 'off'), indicators: 'off' }];
  const which = { turns: options.turnSignals !== false, laneChanges: options.laneChangeSignals !== false };
  for (const w of signalWindows(map, line, cruiseMps, which)) {
    controls.push({ t: tAtS(sPerTick, w.from), indicators: w.side });
    controls.push({ t: tAtS(sPerTick, w.to), indicators: 'off' });
  }
  controls.push(...(options.controls ?? []));
  return controls.sort((a, b) => a.t - b.t);
}

/**
 * A plan at constant speed along a path, for scenarios that do not need the planner (no stops, no
 * signals). The run lasts until the path end plus one second.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {Vec2[]} line Path.
 * @param {number} speedMps Speed in m/s.
 * @param {PlanOptions & {speedAt?: Array<{t: number, value: number}>, durationS?: number}} [options]
 *   Options; `speedAt` replaces the constant speed with keyframes, and `durationS` sets the run
 *   length (required at zero speed).
 * @returns {Plan} Plan.
 */
export function constantPlan(map, vehicleInfo, line, speedMps, options = {}) {
  const total = polylineLength(line);
  const durationS = options.durationS ?? (speedMps > 0 ? total / speedMps + 1 : null);
  if (durationS === null) throw new Error('constantPlan at zero speed needs durationS');
  const n = Math.round(durationS / DT);
  /** @type {Array<{t: number, value: number}>} */
  const speed = [];
  /** @type {number[]} */
  const sPerTick = [];
  let s = 0;
  for (let k = 0; k < n; k += 1) {
    const t = k * DT;
    const v = options.speedAt ? scriptAt(options.speedAt, t) : speedMps;
    speed.push({ t, value: v });
    sPerTick.push(s);
    s = Math.min(total, s + v * DT);
  }
  // A scripted path sets its own lane-change indicators; only junction turns are signalled for it.
  const scripted = { laneChangeSignals: false, ...options };
  const controls = controlsFor(map, line, sPerTick, lightsAtNight(map), scripted, Math.max(speedMps, ...speed.map((k) => k.value)));
  return { path: line, speed, controls, events: options.events ?? [], durationS: n * DT, sPerTick };
}

/**
 * Value of keyframes at `t` (step-free linear interpolation, held at the ends).
 * @param {Array<{t: number, value: number}>} keys Keyframes.
 * @param {number} t Time.
 * @returns {number} Value.
 */
function scriptAt(keys, t) {
  if (t <= keys[0].t) return keys[0].value;
  for (let i = 1; i < keys.length; i += 1) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return b.t > a.t ? a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t) : b.value;
    }
  }
  return keys.at(-1).value;
}

/**
 * @typedef {object} Plan
 * @property {Vec2[]} path Path.
 * @property {Array<{t: number, value: number}>} speed Speed keyframes, one per tick.
 * @property {ControlChange[]} controls Control changes.
 * @property {ForcedEvent[]} events Injected events.
 * @property {number} durationS Run length in seconds.
 * @property {number[]} sPerTick Distance along the path at each tick.
 */

/**
 * Target speed at one instant, given the gates on the path and the state of the ego. A gate that
 * needs a halt latches: the ego brakes to the stop point, and releases when the requirement clears
 * (the light turns green, the sign has been obeyed, the crosswalk is clear). Used by the kinematic
 * planner and by the physics driver, so both obey the same rules.
 * @param {Gate[]} gates Gates in path order.
 * @param {{t: number, s: number, v: number, poses: ActorPose[]}} state Ego state.
 * @param {{cruise: number, ignore: Set<GateKind>, signals: Map<string, import('../../../src/contracts/index.js').Signal>, map: GameMap}} ctx Context.
 * @returns {number} Target speed in m/s.
 */
export function speedTarget(gates, state, ctx) {
  const { t, s, v, poses } = state;
  const { cruise, ignore, signals, map } = ctx;
  let target = cruise;
  for (const g of gates) {
    if (g.s < s - 0.5) continue;
    const d = g.sStop - s;
    if (d < -0.5) continue;
    // A light the ego was released at may change before it reaches the line (it crawls behind a
    // slow queue): it holds again for a yellow or red it can still stop for comfortably.
    if (g.haltedAt === -2 && !(g.kind === 'signal' && d > 0 && signalLeftGreen(g, t, signals) && v * v <= 2 * BRAKE_MPS2 * d)) continue;
    if (g.haltedAt === -2) g.haltedAt = -1;
    if (g.kind === 'give-way') {
      if (!ignore.has('give-way') && d < GIVE_WAY_M && s < g.s) target = Math.min(target, SLOW_MPS);
      continue;
    }
    if (ignore.has(g.kind)) continue;
    if (d > HOLD_DECISION_M) break;
    if (!g.latched) {
      if (!mustHold(g, t, v, d, signals, poses, map)) break;
      g.latched = true;
    }
    const stopped = v < 0.05 && d < 0.1;
    if (stopped && g.haltedAt < 0) g.haltedAt = t;
    const release = g.kind === 'stop-sign' ? stopped && t - g.haltedAt >= STOP_WAIT_S : !mustHold(g, t, v, d, signals, poses, map);
    if (release) {
      g.haltedAt = -2;
      continue;
    }
    target = stopped ? 0 : Math.min(target, Math.sqrt(2 * BRAKE_MPS2 * Math.max(0, d)));
    break;
  }
  return target;
}

/**
 * Whether the light of a signal gate shows other than green now.
 * @param {Gate} g Signal gate.
 * @param {number} t Time.
 * @param {Map<string, import('../../../src/contracts/index.js').Signal>} signals Signals by id.
 * @returns {boolean} Yellow or red.
 */
function signalLeftGreen(g, t, signals) {
  const sig = signals.get(g.signalId ?? '');
  return sig !== undefined && signalState(sig, t) !== 'green';
}

/**
 * Whether a gate requires the ego to hold now.
 * @param {Gate} g Gate.
 * @param {number} t Time.
 * @param {number} v Speed.
 * @param {number} d Distance to the stop point.
 * @param {Map<string, import('../../../src/contracts/index.js').Signal>} signals Signals by id.
 * @param {ActorPose[]} poses Actor poses of the last step.
 * @param {GameMap} map Map.
 * @returns {boolean} True to hold.
 */
function mustHold(g, t, v, d, signals, poses, map) {
  if (g.kind === 'stop-sign') return true;
  if (g.kind === 'crosswalk') return pedestrianOn(map, g.id, poses);
  // Signal: hold unless it stays green on arrival and for a moment after.
  const sig = signals.get(g.signalId ?? '');
  if (!sig) return false;
  const arrive = t + d / Math.max(v, 2);
  return [0, 2].some((extra) => signalState(sig, arrive + extra) !== 'green');
}

/**
 * Time of the first tick at or after distance `sTarget`.
 * @param {number[]} sPerTick Distance per tick.
 * @param {number} sTarget Distance.
 * @returns {number} Time in seconds.
 */
function tAtS(sPerTick, sTarget) {
  const k = sPerTick.findIndex((x) => x >= sTarget);
  return (k < 0 ? sPerTick.length - 1 : k) * DT;
}

/**
 * Builds the frames of a plan and scores them with the real bundle.
 * @param {GameMap} map Map.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 * @param {Plan} plan Plan.
 * @returns {Promise<{report: ScoreReport, frames: Frame[]}>} Result.
 */
export async function runPlan(map, vehicleId, plan) {
  const veh = vehicleOf(vehicleId);
  const frames = buildFrames({
    map,
    vehicle: veh,
    path: plan.path,
    speed: plan.speed,
    controls: plan.controls,
    events: plan.events,
    durationS: plan.durationS,
  });
  const scorer = createScorer(await realBundle(), map, veh);
  let state = scorer.initial;
  for (const f of frames) state = scorer.step(state, f).state;
  return { report: scorer.report(state, { quit: false }), frames };
}

/**
 * Breaches of one rule in a report.
 * @param {ScoreReport} report Report.
 * @param {string} ruleId Rule id.
 * @returns {ScoreReport['breaches']} Breaches.
 */
export function breachesOf(report, ruleId) {
  return report.breaches.filter((b) => b.ruleId === ruleId);
}

/**
 * Points of a straight run at constant `z`, from `x0` to `x1`, 0.5 m apart.
 * @param {number} x0 Start x.
 * @param {number} x1 End x.
 * @param {number} z Lateral z.
 * @returns {Vec2[]} Path.
 */
export function straightLine(x0, x1, z) {
  return sample([x0, z], [x1, z]);
}

/**
 * Path through stations `[x, z]`, joined by smooth lateral steps: z eases from one station to the
 * next over the x span between them (smoothstep), so a lane change has no kink.
 * @param {Vec2[]} stations Stations, in increasing x.
 * @returns {Vec2[]} Path, 0.25 m apart in x.
 */
export function stepsLine(stations) {
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i < stations.length - 1; i += 1) {
    const [x0, z0] = stations[i];
    const [x1, z1] = stations[i + 1];
    const n = Math.max(1, Math.ceil((x1 - x0) / 0.25));
    for (let k = i === 0 ? 0 : 1; k <= n; k += 1) {
      const u = k / n;
      const e = u * u * (3 - 2 * u);
      out.push([x0 + (x1 - x0) * u, z0 + (z1 - z0) * e]);
    }
  }
  return out;
}

/**
 * The clause id a bundle rule cites for one tier, for the legal group of the vehicle.
 * @param {import('../../../src/contracts/index.js').RulesBundle} bundle Bundle.
 * @param {string} ruleId Rule id.
 * @param {number} tierIndex Tier index.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 * @returns {string | null} Clause id.
 */
export function clauseIdOf(bundle, ruleId, tierIndex, vehicleId) {
  const rule = bundle.rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No rule ${ruleId}`);
  const group = vehicleId === 'car-sedan' ? 'D6' : 'D7';
  return rule.tiers[tierIndex]?.clause?.[group] ?? null;
}

/**
 * A polyline through the given points, 0.5 m apart.
 * @param {Vec2[]} points Corners, in order.
 * @returns {Vec2[]} Path.
 */
export function polyLine(points) {
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) out.push(...(i === 0 ? sample(points[i], points[i + 1]) : sample(points[i], points[i + 1]).slice(1)));
  return out;
}

/**
 * Asserts that a report holds a breach of a rule whose first hit is at the given tier, and that
 * the hit cites the clause the bundle names for that tier (unless `clause` is false).
 * @param {ScoreReport} report Report.
 * @param {string} ruleId Rule id.
 * @param {{tier: number, vehicleId?: 'car-sedan' | 'scooter', clause?: boolean}} expected Expected tier.
 * @returns {Promise<void>}
 */
export async function expectBreach(report, ruleId, expected) {
  const hits = breachesOf(report, ruleId);
  expect(hits.length, `${ruleId} breaches`).toBeGreaterThan(0);
  expect(hits[0].tierIndex, `${ruleId} tier`).toBe(expected.tier);
  if (expected.clause !== false) {
    expect(hits[0].clause?.id, `${ruleId} clause`).toBe(clauseIdOf(await realBundle(), ruleId, expected.tier, expected.vehicleId ?? 'car-sedan'));
  }
}
