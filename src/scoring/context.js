/**
 * Per-step derived context shared by every detector, and the small "core" state it needs across
 * steps (previous position, odometer, speed trace, indicator history, junction traversal, last
 * known limit). The core state is plain JSON and lives inside the scorer state.
 */

import { DISCONTINUITY_EVENTS } from '../contracts/telemetry.js';
import { findSpeedDefault, isMultiLaneRoad } from '../contracts/speed-limit.js';
import { DT, mpsToKmh } from '../contracts/units.js';
import { angleDiff, headingVector, leftVector } from '../geometry/index.js';
import { crossedLines, laneById, laneHeadingAt, locate, zonesAt } from '../map-query/index.js';
import { actorInfo } from './detectors/common.js';

/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */
/** @typedef {import('../contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../contracts/index.js').Zone} Zone */
/** @typedef {import('../contracts/index.js').DecreeGroup} DecreeGroup */
/** @typedef {import('../contracts/index.js').Indicators} Indicators */
/** @typedef {import('../map-query/index.js').Location} Location */
/** @typedef {import('../map-query/index.js').Crossings} Crossings */

/** Odometer span of the kept speed trace, in metres; longer than any detector window. */
export const TRACE_SPAN_M = 60;

/**
 * Margin added to the largest detector distance when filtering actors: covers half the length
 * of the longest vehicle and the lateral reach of a range measured ahead.
 */
export const ACTOR_RANGE_MARGIN_M = 20;

/** Pose states of a wreck, which stands still whatever its pose speed says. */
const WRECK_STATES = Object.freeze(['crashed', 'fallen']);

/**
 * Speed of an actor as other road users see it: 0 for a wreck (`crashed`, `fallen`), which stands
 * still whatever its pose speed says (a car wreck still slides), else the pose speed magnitude.
 * @param {import('../contracts/index.js').ActorPose} pose Pose.
 * @returns {number} Speed in m/s.
 */
export function poseSpeed(pose) {
  return WRECK_STATES.includes(pose.state) ? 0 : Math.abs(pose.speed);
}

/**
 * Radius around the ego inside which actors enter the per-step actor list: the largest distance
 * parameter of any rule (a detection parameter whose name ends in `M`, metres by convention; today
 * the high-beam `rangeM`) plus `ACTOR_RANGE_MARGIN_M`.
 * @param {RulesBundle} bundle Bundle.
 * @returns {number} Radius in metres.
 */
export function actorRangeOf(bundle) {
  let max = 0;
  for (const rule of bundle.rules) {
    for (const [k, v] of Object.entries(rule.detection.params)) {
      if (k.endsWith('M') && typeof v === 'number' && Number.isFinite(v)) max = Math.max(max, v);
    }
  }
  return max + ACTOR_RANGE_MARGIN_M;
}

/**
 * An active actor near the ego, in the ego frame.
 * @typedef {object} NearActor
 * @property {import('../contracts/index.js').ActorPose} pose Pose.
 * @property {number} along Distance ahead of the ego centre along its heading (negative behind).
 * @property {number} lateral Distance to the left of the ego centre.
 * @property {number} lengthM Length, from the pose (or the map actor for frames without sizes).
 * @property {number} widthM Width.
 * @property {number} speed Speed in m/s; 0 for a wreck (`crashed`, `fallen`).
 */

/**
 * Static inputs of one scorer.
 * @typedef {object} ScorerEnv
 * @property {RulesBundle} bundle Rules bundle.
 * @property {GameMap} map Map.
 * @property {VehicleInfo} vehicle Vehicle.
 * @property {DecreeGroup} group Decree group of the vehicle.
 * @property {Map<string, import('../contracts/index.js').Clause>} clausesById Clauses.
 * @property {Map<string, import('../contracts/index.js').Source>} sourcesById Sources.
 * @property {number} actorRangeM Radius of the per-step actor list (`actorRangeOf`).
 */

/**
 * A completed or running pass through a junction.
 * @typedef {object} JunctionPass
 * @property {string} id Junction id.
 * @property {string | null} entryLaneId Lane driven just before entering.
 * @property {string | null} entryRoadId Road of that lane.
 * @property {number} entryHeading Travel heading on entry (lane heading when known).
 * @property {number} entryOdo Odometer at entry.
 * @property {number} entryT Time of entry.
 * @property {number} [exitHeading] Heading on exit.
 * @property {string | null} [exitLaneId] Lane on exit.
 * @property {number} [exitT] Time of exit.
 */

/**
 * @typedef {object} LimitInfo
 * @property {number} kmh Limit.
 * @property {'sign' | 'default'} source A bound speed-limit zone, or a TT 38 default.
 * @property {boolean} verified The default row is verified (signs count as verified).
 */

/**
 * @typedef {object} CoreState
 * @property {{pos: Vec2, front: Vec2, heading: number, t: number, speed: number} | null} prev
 *   Previous step, null at the start and after a discontinuity.
 * @property {number} odo Distance travelled, metres.
 * @property {[number, number][]} trace `[odo, minimum speed at that odometer]`, oldest first.
 * @property {number} traceStartOdo Odometer where the trace starts (run start or discontinuity).
 * @property {{state: Indicators, sinceT: number, sinceOdo: number}} indicator Indicator and when
 *   it took its current state.
 * @property {JunctionPass | null} junction Junction being crossed.
 * @property {JunctionPass | null} lastExit Last completed junction pass.
 * @property {string | null} lastLaneId Last lane under the ego.
 * @property {LimitInfo | null} lastLimit Last limit found in a lane.
 */

/**
 * Per-step context handed to detectors.
 * @typedef {object} StepContext
 * @property {ScorerEnv} env Static inputs.
 * @property {Frame} frame Frame.
 * @property {number} t Time.
 * @property {number} dt Seconds since the previous step.
 * @property {Vec2} pos Body centre.
 * @property {Vec2} front Front bumper centre.
 * @property {number} heading Heading θ.
 * @property {number} speed Speed magnitude, m/s.
 * @property {number} speedKmh Speed magnitude, km/h.
 * @property {boolean} discontinuity A reset or fall happened this step.
 * @property {CoreState['prev']} prev Previous step, null across a discontinuity.
 * @property {Location} loc Location of the body centre.
 * @property {number | null} laneHeading Travel heading of the lane under the ego.
 * @property {boolean} against Heading more than 90° off the lane's travel heading.
 * @property {Zone[]} zones Zones at the centre (lane-bound when in a lane).
 * @property {boolean} builtUp Inside a built-up zone.
 * @property {boolean} lit Inside a lit zone.
 * @property {LimitInfo | null} limit Limit in force.
 * @property {Crossings} centerCrossings Lines crossed by the centre this step.
 * @property {Crossings} frontCrossings Lines crossed by the front this step.
 * @property {number} odo Odometer.
 * @property {number} startOdo Odometer at the run start or the last discontinuity.
 * @property {(windowM: number) => number} minSpeedWithin Lowest speed over the last `windowM`
 *   metres of travel (Infinity when the trace is shorter, e.g. right after a reset).
 * @property {CoreState['indicator']} indicator Indicator history.
 * @property {JunctionPass | null} junction Junction being crossed.
 * @property {boolean} junctionEntered Entered a junction this step.
 * @property {JunctionPass | null} junctionExit Junction pass completed this step.
 * @property {JunctionPass | null} lastExit Last completed junction pass.
 * @property {NearActor[]} actors Active actors within `env.actorRangeM` of the ego, in frame
 *   order; detectors read actors only from this list.
 * @property {import('../contracts/index.js').FrameEvent[]} [contacts] Collision and fall events
 *   the scorer charges this step, set for the collision detector only.
 */

/**
 * Active actors near the ego with their ego-frame coordinates, sizes and effective speed.
 * @param {ScorerEnv} env Static inputs.
 * @param {Frame} frame Frame.
 * @returns {NearActor[]} Actors in frame order.
 */
function nearActors(env, frame) {
  const { pos, heading } = frame.ego;
  const [fx, fz] = headingVector(heading);
  const [lx, lz] = leftVector(heading);
  const r2 = env.actorRangeM * env.actorRangeM;
  /** @type {NearActor[]} */
  const out = [];
  for (const pose of frame.actors) {
    if (!pose.active) continue;
    const dx = pose.pos.x - pos.x;
    const dz = pose.pos.z - pos.z;
    if (dx * dx + dz * dz > r2) continue;
    let lengthM = pose.lengthM;
    let widthM = pose.widthM;
    if (lengthM === undefined || widthM === undefined) {
      const info = actorInfo(env.map, pose.id);
      if (!info) continue;
      lengthM = info.lengthM;
      widthM = info.widthM;
    }
    out.push({
      pose,
      along: dx * fx + dz * fz,
      lateral: dx * lx + dz * lz,
      lengthM,
      widthM,
      speed: poseSpeed(pose),
    });
  }
  return out;
}

/**
 * @returns {CoreState} Fresh core state.
 */
export function initialCore() {
  return {
    prev: null,
    odo: 0,
    trace: [],
    traceStartOdo: 0,
    indicator: { state: 'off', sinceT: 0, sinceOdo: 0 },
    junction: null,
    lastExit: null,
    lastLaneId: null,
    lastLimit: null,
  };
}

/**
 * Whether a frame carries a reset or fall event.
 * @param {Frame} frame Frame.
 * @returns {boolean} Discontinuity.
 */
export function isDiscontinuity(frame) {
  return frame.events.some((e) => DISCONTINUITY_EVENTS.includes(e.type));
}

/**
 * Speed limit for the ego at this point.
 * @param {ScorerEnv} env Static inputs.
 * @param {Location} loc Location.
 * @param {Zone[]} zones Zones.
 * @param {boolean} builtUp Built-up.
 * @returns {LimitInfo | null} Limit, null off the lanes.
 */
export function limitFor(env, loc, zones, builtUp) {
  if (!loc.laneId) return null;
  const signed = zones.filter((z) => z.type === 'speed-limit' && typeof z.valueKmh === 'number');
  if (signed.length > 0) {
    return { kmh: Math.min(...signed.map((z) => /** @type {number} */ (z.valueKmh))), source: 'sign', verified: true };
  }
  const entry = laneById(env.map, loc.laneId);
  if (!entry) return null;
  const row = findSpeedDefault(env.bundle.speedDefaults, env.vehicle.legalClass, builtUp, isMultiLaneRoad(entry.road));
  return row ? { kmh: row.maxKmh, source: 'default', verified: row.verified } : null;
}

/**
 * Advances the core state by one frame and derives the step context.
 * @param {ScorerEnv} env Static inputs.
 * @param {CoreState} core Core state before the frame (not mutated).
 * @param {Frame} frame Frame.
 * @returns {{core: CoreState, ctx: StepContext}} Next core state and the context.
 */
export function stepCore(env, core, frame) {
  const discontinuity = isDiscontinuity(frame);
  const base = discontinuity ? { ...initialCore(), odo: core.odo, traceStartOdo: core.odo, lastLimit: core.lastLimit } : core;
  const { ego } = frame;
  /** @type {Vec2} */
  const pos = [ego.pos.x, ego.pos.z];
  const [hx, hz] = headingVector(ego.heading);
  const half = env.vehicle.lengthM / 2;
  /** @type {Vec2} */
  const front = [pos[0] + hx * half, pos[1] + hz * half];
  const speed = Math.abs(ego.speed);
  const prev = base.prev;
  const dt = prev ? Math.max(0, frame.t - prev.t) : DT;
  const odo = base.odo + (prev ? Math.hypot(pos[0] - prev.pos[0], pos[1] - prev.pos[1]) : 0);

  const loc = locate(env.map, pos, ego.heading);
  const laneHeading = loc.laneId ? laneHeadingAt(env.map, loc.laneId, pos) : null;
  const against = laneHeading !== null && Math.abs(angleDiff(laneHeading, ego.heading)) > Math.PI / 2;
  const zones = zonesAt(env.map, pos, loc.laneId);
  const builtUp = zones.some((z) => z.type === 'built-up');
  const lit = zones.some((z) => z.type === 'lit');
  const laneLimit = limitFor(env, loc, zones, builtUp);
  const limit = laneLimit ?? (loc.junctionId ? base.lastLimit : null);

  const empty = { laneLines: [], stopLines: [], entries: [] };
  const centerCrossings = prev ? crossedLines(env.map, prev.pos, pos) : empty;
  const frontCrossings = prev ? crossedLines(env.map, prev.front, front) : empty;

  // Speed trace: one sample per distinct odometer value, keeping the minimum speed there.
  const trace = base.trace.filter(([o]) => o >= odo - TRACE_SPAN_M);
  const last = trace[trace.length - 1];
  if (last && last[0] === odo) trace[trace.length - 1] = [odo, Math.min(last[1], speed)];
  else trace.push([odo, speed]);
  const traceStartOdo = base.traceStartOdo;
  /**
   * @param {number} windowM Window.
   * @returns {number} Lowest speed in the window.
   */
  const minSpeedWithin = (windowM) => {
    if (odo - traceStartOdo < windowM - 1e-9) return Infinity;
    let m = Infinity;
    for (const [o, v] of trace) if (o >= odo - windowM - 1e-9 && v < m) m = v;
    return m;
  };

  const indicator =
    base.indicator.state === ego.indicators && prev ? base.indicator : { state: ego.indicators, sinceT: frame.t, sinceOdo: odo };

  /** @type {JunctionPass | null} */
  let junction = base.junction;
  let junctionEntered = false;
  /** @type {JunctionPass | null} */
  let junctionExit = null;
  let lastExit = base.lastExit;
  if (junction && loc.junctionId !== junction.id) {
    // The lane heading is the cleaner travel heading, unless the ego drives against that lane.
    const exitHeading = laneHeading !== null && !against ? laneHeading : ego.heading;
    junctionExit = { ...junction, exitHeading, exitLaneId: loc.laneId, exitT: frame.t };
    lastExit = junctionExit;
    junction = null;
  }
  if (!junction && loc.junctionId && prev) {
    const entryLaneId = base.lastLaneId;
    const entryLane = entryLaneId ? laneById(env.map, entryLaneId) : null;
    const entryLaneHeading = entryLane ? laneHeadingAt(env.map, entryLane.lane.id, prev.pos) : null;
    const withLane = entryLaneHeading !== null && Math.abs(angleDiff(entryLaneHeading, prev.heading)) <= Math.PI / 2;
    junction = {
      id: loc.junctionId,
      entryLaneId,
      entryRoadId: entryLane ? entryLane.road.id : null,
      entryHeading: withLane ? /** @type {number} */ (entryLaneHeading) : prev.heading,
      entryOdo: odo,
      entryT: frame.t,
    };
    junctionEntered = true;
  }

  /** @type {CoreState} */
  const next = {
    prev: { pos, front, heading: ego.heading, t: frame.t, speed },
    odo,
    trace,
    traceStartOdo,
    indicator,
    junction,
    lastExit,
    lastLaneId: loc.laneId ?? base.lastLaneId,
    lastLimit: laneLimit ?? base.lastLimit,
  };
  /** @type {StepContext} */
  const ctx = {
    env,
    frame,
    t: frame.t,
    dt,
    pos,
    front,
    heading: ego.heading,
    speed,
    speedKmh: mpsToKmh(speed),
    discontinuity,
    prev,
    loc,
    laneHeading,
    against,
    zones,
    builtUp,
    lit,
    limit,
    centerCrossings,
    frontCrossings,
    odo,
    startOdo: traceStartOdo,
    minSpeedWithin,
    indicator,
    junction,
    junctionEntered,
    junctionExit,
    lastExit,
    actors: nearActors(env, frame),
  };
  return { core: next, ctx };
}
