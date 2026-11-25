/**
 * Traffic: seeded NPC agents on the map's lane graph, stepped at the fixed `DT`. Pure and
 * deterministic: the same map, parameters, run seed and inputs give the same poses.
 *
 * Each `stepTraffic` call, at the input time `t`:
 * 1. applies the step's events: ego contacts make wrecks that stop dead, an ego reset clears
 *    agents around the ego (and the perception of agents near it), wrecks clear, agents despawn,
 *    sources and the ring spawner spawn;
 * 2. returns the poses at `t` (like `stepActors`, so the frame of tick k shows the poses after k
 *    steps of motion), with each agent's latched violation flags;
 * 3. lateral decisions, in ascending spawn index: mandatory lane changes out of closed lanes
 *    (`lane-change.js`), discretionary lane changes of cars (`mobil.js`) and lateral slots of
 *    motorbikes (`moto-slots.js`), each signalled before it is made unless the driver drew none;
 * 4. computes every agent's acceleration and junction request from the state at `t`: IDM against
 *    the agent ahead on its route that overlaps it laterally, as the driver perceives it
 *    (`human-factors.js`: reaction delay, perception error, distraction), and against the stop
 *    line or keep-clear hold point, a red stop line just past the junction, and, perceived
 *    exactly, the ego, scripted actors, static map obstacles and agents moving across lanes in its
 *    corridor; an ego signalling into the agent's lane and moving across counts as a leader for
 *    agents that give way to it. Signal choices may break the rules (red-light run, early start,
 *    yellow by a logistic choice), drawn per approach;
 * 5. grants junction claims (the ego is a party to gap acceptance, `junctions.js`) and integrates
 *    every agent, in ascending spawn index (two phases); car wrecks slide to a stop;
 * 6. detects NPC contacts (`contacts.js`), which make wrecks and incidents, and latches the
 *    violation flags raised from the true state this step (`violations.js`).
 *
 * A lane that joins another lane (`map.laneJoins`) runs straight on into it with no hold point and
 * no claim.
 *
 * `stepWorld` is the one composite step, scripted actors then traffic, shared by the sim and
 * the test frame builder.
 */

import { ACTOR_LIGHTS } from '../../contracts/telemetry.js';
import { DT, TICK_HZ } from '../../contracts/units.js';
import { angleDiff, footprint, polygonsIntersect, projectOntoPolyline } from '../../geometry/index.js';
import { createActorState, stepActors } from '../actors.js';
import { createStream, hash32, uniform } from '../random.js';
import { trafficLightStates } from '../signals.js';
import { idmAcceleration, integrate } from './idm.js';
import { corridorObstacle } from './perception.js';
import { reachesBeforeRed, redRemaining, signalDecision, yellowRemaining, yellowStopProbability } from './signals.js';
import { HELD_BLOCKED, HELD_EXIT, breaksDeadlock, checkConflicts, claimBlocking, defersToWaiter, exitRoom, laneLight, mergesAhead, toExit, wreckInWay, zoneClaimed, zonesOccupied } from './junctions.js';
import { FLAG, draw, latch, raise, rateOf, violationsOf } from './violations.js';
import { distracted, perceiveLeader, resetPerception } from './human-factors.js';
import { GO_ROUND_AFTER_S, GO_ROUND_LOOK_M, chooseSlot, goRoundEgo, inTurnBand, moveTouches, overlapsAt, pathBlocked } from './moto-slots.js';
import { stepMobil } from './mobil.js';
import { detectContacts, makeWreck } from './contacts.js';
import { STOPPED_MPS, createSpawner, inViewCone, runSpawner } from './spawner.js';
import { queryGrid, rebuildGrid } from './grid.js';
import { changingLane, moveAcross, tryMandatoryLaneChange } from './lane-change.js';
import { edgeLateral, edgePoint, lanesUnder } from './lane-graph.js';
import {
  chooseNext,
  claimAdd,
  claimDrop,
  createTrafficState,
  despawnAgent,
  edgeInsert,
  posePreview,
  edgeRemove,
  refreshBaseSpeed,
  sortEdgeLists,
  updatePose,
} from './state.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/traffic.js').TrafficParams} TrafficParams */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('../../contracts/telemetry.js').LightState} LightState */
/** @typedef {import('../../contracts/telemetry.js').Pos2} Pos2 */
/** @typedef {import('../../contracts/telemetry.js').Vec2} Vec2 */
/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./perception.js').Obstacle} Obstacle */
/** @typedef {import('../actors.js').ActorState} ActorState */

export { DESPAWN_REASONS } from './state.js';

/**
 * The ego as traffic sees it this step: its pre-step pose.
 * @typedef {object} EgoInput
 * @property {Pos2} pos Centre.
 * @property {number} heading Heading.
 * @property {number} speed Signed speed along the heading (negative while reversing).
 * @property {number} lengthM Length.
 * @property {number} widthM Width.
 * @property {import('../../contracts/telemetry.js').Indicators} [indicators] Turn signals before
 *   the step; absent counts as `off` (the pre-roll and tests).
 */

/**
 * @typedef {object} TrafficStepInput
 * @property {EgoInput} ego Ego pre-step pose.
 * @property {boolean} egoReset The ego was placed back at a checkpoint this step.
 * @property {readonly ActorPose[]} scripted Scripted actor poses at `t`, perceived exactly.
 * @property {Record<string, LightState>} lights Light state of every map signal at `t`.
 * @property {readonly string[]} egoContacts Ids of actors the ego touched in the previous step;
 *   traffic ids among them become wrecks, other ids are ignored.
 * @property {number} t Run time of this step.
 */

/** @typedef {import('./contacts.js').TrafficIncident} TrafficIncident */

/**
 * @typedef {object} TrafficStep
 * @property {TrafficState} state The same state object, advanced by one DT.
 * @property {ActorPose[]} poses Agent poses at `t`, in ascending spawn index.
 * @property {TrafficIncident[]} incidents Incidents that started this step.
 */

/** Ego size assumed while pre-rolling, before the vehicle is known (design: the sedan). */
export const PREROLL_EGO_SIZE = Object.freeze({ lengthM: 4.5, widthM: 1.8 });
/**
 * Margin on every side of the ego footprint inside which an ego reset clears agents, metres
 * (design: with a 4.5 m car the cleared box is about 12.5 × 9.8 m).
 */
export const RESET_CLEAR_MARGIN_M = 4;
/**
 * An agent ahead on a sibling connector stops counting as a leader once its rear is clear of the
 * follower's own path, sideways, by this much beyond the follower's half width, metres (design).
 */
export const SIBLING_CLEAR_M = 0.3;
/** Leaders farther than this along the route are ignored, metres (design). */
export const LEADER_LOOK_M = 200;
/**
 * An agent held by a body in its way longer than this leaves once out of the player's view,
 * seconds (design). The flow test caps how often it happens, so it cannot hide a broken rule.
 */
export const STUCK_DESPAWN_S = 20;
/** A stopped agent this close to the end of a sink lane leaves the map once out of view, metres (design). */
export const SINK_EDGE_M = 10;
/** Small clearance kept to an obstacle when the advance is clamped, metres. */
const CLAMP_MARGIN_M = 0.05;
/**
 * The advance stops this far short of the true gap to the agent ahead, metres (design): a driver
 * acting on a delayed view creeps up in a queue but never into contact unless distracted.
 */
export const QUEUE_BUFFER_M = 0.3;
/** Below this speed an agent never counts as tailgating, m/s (design: queues creep close). */
export const TAILGATE_MIN_MPS = 3;
/** Deceleration the ego is taken to brake at for its stopping distance, m/s² (design). */
export const EGO_STOP_DECEL_MPS2 = 6;
/** Reaction time added to the ego's stopping distance, seconds (design). */
export const EGO_REACTION_S = 0.5;
/** An ego standing still this long closes the lane under it, like a parked vehicle, seconds (design: longer than a red phase). */
export const EGO_PARKED_S = 45;
/** A standing ego that shifts this far, metres, or turns this much, radians, is looked up again. */
const EGO_PARKED_SHIFT_M = 0.1;
const EGO_PARKED_TURN_RAD = 0.02;
/** Sideways speed above which a signalling ego counts as moving across, m/s (design). */
export const EGO_SIDEWAYS_MPS = 0.2;
/** A red stop line just past a junction is looked for this far beyond the braking distance, metres. */
const DOWNSTREAM_LOOK_M = 30;
/** Bits of `approachDraws`: red-light draw made, early-start draw made, running the red. */
const RED_DRAWN = 1;
const EARLY_DRAWN = 2;
const RUNNING = 4;
const VALID_INDICATORS = Object.freeze(['off', 'left', 'right', 'hazard']);

/**
 * Per-step scratch, allocated once per state.
 * @typedef {object} Scratch
 * @property {Float64Array} accGo Acceleration when the agent may pass its hold point.
 * @property {Float64Array} accHold Acceleration when it must stop at it.
 * @property {Float64Array} advGo Furthest advance without touching an obstacle (go).
 * @property {Float64Array} advHold Furthest advance (hold).
 * @property {Uint8Array} holds 1 when a hold point applies unless a claim is granted.
 * @property {Uint8Array} drops 1 when the agent gives its claim back (signal changed).
 * @property {Uint8Array} inZone 1 when the agent is in its decision zone this step.
 * @property {Int8Array} commit Signal commit to store.
 * @property {Float64Array} holdDist Front distance to the hold point.
 * @property {Float64Array} reserved Length reserved by claims per exit lane.
 * @property {Int32Array} listPos Position of each slot in its edge list.
 * @property {Int32Array} requests Requesting slots.
 * @property {Float64Array} pair Scratch pair.
 * @property {{x: number, z: number, lengthM: number}} egoMid Ego centre and length.
 * @property {import('./junctions.js').ConflictCheck} check Conflict check result.
 * @property {Obstacle[]} near Obstacles near the agent being computed.
 * @property {{slot: number, obstacle: Obstacle}[]} movers Agents moving across after a lane change.
 * @property {Obstacle[]} perceived Ego, scripted actors and static obstacles, for lane changes.
 * @property {import('./lane-graph.js').LaneSpan[]} parked Lane stretches under scripted actors
 *   not moving along their path, for lane changes.
 * @property {{x: number, z: number, heading: number, spans: import('./lane-graph.js').LaneSpan[] | null}} egoParked
 *   Lane stretches under the standing ego, and the pose they were found at.
 * @property {Map<string, import('./lane-graph.js').LaneSpan[]>} parkedSpans Those stretches by
 *   actor id and place.
 * @property {Uint8Array} noYield 1 when going now enters inside another party's critical gap.
 * @property {Uint8Array} runner 1 when the request is a red-light run (only occupied zones stop it).
 * @property {Uint8Array} forcing 1 when going now forces the way in (a red run, or a gap shorter
 *   than the class critical gap taken by choice).
 * @property {Uint8Array} held Next value of `TrafficState.held`.
 * @property {Float64Array} perceived2 Perceived leader pair.
 * @property {Vec2[][]} feet Footprints by slot: before the step's motion, then where each agent
 *   has moved as the step goes on.
 * @property {Vec2[][]} feetBefore Footprints before the step's motion, by slot.
 * @property {import('./junctions.js').EgoParty} egoParty The ego at junctions this step.
 * @property {Float64Array} laneBox Bounding box per lane edge, 4 per lane, with `egoOnLaneM` margin.
 */

/** @type {WeakMap<TrafficState, Scratch>} */
const SCRATCH = new WeakMap();

/**
 * @param {TrafficState} st State.
 * @returns {Scratch} Scratch.
 */
function scratchOf(st) {
  let sc = SCRATCH.get(st);
  if (!sc) {
    const n = st.capacity;
    sc = {
      accGo: new Float64Array(n),
      accHold: new Float64Array(n),
      advGo: new Float64Array(n),
      advHold: new Float64Array(n),
      holds: new Uint8Array(n),
      drops: new Uint8Array(n),
      inZone: new Uint8Array(n),
      commit: new Int8Array(n),
      holdDist: new Float64Array(n),
      reserved: new Float64Array(st.graph.edges.length),
      listPos: new Int32Array(n),
      requests: new Int32Array(n),
      pair: new Float64Array(2),
      egoMid: { x: 0, z: 0, lengthM: 0 },
      check: { claimed: false, yields: false, noYield: false, egoYield: false, maxYieldWait: -1, minYieldIndex: Infinity },
      near: [],
      movers: [],
      perceived: [],
      parked: [],
      parkedSpans: new Map(),
      egoParked: { x: 0, z: 0, heading: 0, spans: null },
      noYield: new Uint8Array(n),
      runner: new Uint8Array(n),
      forcing: new Uint8Array(n),
      held: new Uint8Array(n),
      perceived2: new Float64Array(2),
      feet: new Array(n),
      feetBefore: new Array(n),
      egoParty: { lane: -1, toLaneEnd: 0, speed: 0 },
      laneBox: laneBoxes(st),
    };
    SCRATCH.set(st, sc);
  }
  return sc;
}

/**
 * Bounding boxes of the lane edges, grown by `behaviour.egoOnLaneM`.
 * @param {TrafficState} st State.
 * @returns {Float64Array} `[minX, minZ, maxX, maxZ]` per lane edge.
 */
function laneBoxes(st) {
  const m = st.params.behaviour.egoOnLaneM;
  const out = new Float64Array(st.graph.laneCount * 4);
  for (let i = 0; i < st.graph.laneCount; i += 1) {
    const e = st.graph.edges[i];
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let j = 0; j < e.xs.length; j += 1) {
      minX = Math.min(minX, e.xs[j]);
      maxX = Math.max(maxX, e.xs[j]);
      minZ = Math.min(minZ, e.zs[j]);
      maxZ = Math.max(maxZ, e.zs[j]);
    }
    out.set([minX - m, minZ - m, maxX + m, maxZ + m], i * 4);
  }
  return out;
}

/** @type {{x: number, z: number, heading: number}} */
const LANE_POINT = { x: 0, z: 0, heading: 0 };

/**
 * The ego as a junction party: the nearest lane within `behaviour.egoOnLaneM` of its centre whose
 * direction is within 60° of its heading; none in a junction, off the road or reversing.
 * @param {TrafficState} st State.
 * @param {EgoInput} ego Ego.
 * @param {Scratch} sc Scratch.
 * @returns {import('./junctions.js').EgoParty} The scratch party, filled.
 */
function egoPartyOf(st, ego, sc) {
  const party = sc.egoParty;
  party.lane = -1;
  party.toLaneEnd = 0;
  party.speed = Math.max(0, ego.speed);
  const { x, z } = ego.pos;
  const box = sc.laneBox;
  let best = st.params.behaviour.egoOnLaneM;
  for (let i = 0; i < st.graph.laneCount; i += 1) {
    if (x < box[i * 4] || z < box[i * 4 + 1] || x > box[i * 4 + 2] || z > box[i * 4 + 3]) continue;
    const e = st.graph.edges[i];
    const pr = projectOntoPolyline([x, z], e.points);
    if (pr.distance >= best || pr.s >= e.length) continue;
    edgePoint(e, pr.s, LANE_POINT);
    if (Math.abs(angleDiff(ego.heading, LANE_POINT.heading)) > Math.PI / 3) continue;
    best = pr.distance;
    party.lane = i;
    party.toLaneEnd = e.length - (pr.s + ego.lengthM / 2);
  }
  return party;
}

/**
 * The ego's forward corridor inside its stopping distance (reaction plus braking at
 * `EGO_STOP_DECEL_MPS2`), or null when it stands or reverses.
 * @param {EgoInput} ego Ego.
 * @returns {Vec2[] | null} Corridor.
 */
function egoCorridorOf(ego) {
  const v = ego.speed;
  if (v < STOPPED_MPS) return null;
  const reach = (v * v) / (2 * EGO_STOP_DECEL_MPS2) + v * EGO_REACTION_S;
  const hx = Math.cos(ego.heading);
  const hz = -Math.sin(ego.heading);
  const d = ego.lengthM / 2 + reach / 2;
  return footprint({ x: ego.pos.x + hx * d, z: ego.pos.z + hz * d }, ego.heading, reach, ego.widthM);
}

/**
 * Validates the step input at the module boundary.
 * @param {TrafficStepInput} input Input.
 * @returns {void}
 */
function checkInput(input) {
  const e = input?.ego;
  if (!e || !Number.isFinite(e.pos?.x) || !Number.isFinite(e.pos?.z) || !Number.isFinite(e.heading) || !Number.isFinite(e.speed)) {
    throw new TypeError('stepTraffic needs an ego pose with finite pos, heading and speed');
  }
  if (!(e.lengthM > 0) || !(e.widthM > 0)) throw new TypeError('stepTraffic needs a positive ego size');
  if (e.indicators !== undefined && !VALID_INDICATORS.includes(e.indicators)) throw new TypeError(`Unknown ego indicators ${String(e.indicators)}`);
  if (!Number.isFinite(input.t)) throw new TypeError('stepTraffic needs a finite t');
  if (!Array.isArray(input.scripted) || !Array.isArray(input.egoContacts) || typeof input.lights !== 'object' || input.lights === null) {
    throw new TypeError('stepTraffic needs scripted poses, ego contacts and light states');
  }
}

/**
 * Obstacles for exact perception from actor poses.
 * @param {readonly ActorPose[]} poses Poses.
 * @returns {Obstacle[]} Obstacles.
 */
function obstaclesOf(poses) {
  return poses.map((p) => ({
    footprint: footprint(p.pos, p.heading, p.lengthM, p.widthM),
    x: p.pos.x,
    z: p.pos.z,
    radius: Math.hypot(p.lengthM, p.widthM) / 2,
    vx: p.speed * Math.cos(p.heading),
    vz: -p.speed * Math.sin(p.heading),
  }));
}

/**
 * Pose of one agent.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {ActorPose} Pose.
 */
function poseOf(st, slot) {
  const key = st.modelKeys[st.model[slot]];
  const model = st.params.models[key];
  const wreck = st.wreck[slot] === 1;
  const v = st.v[slot];
  return {
    id: st.ids[slot],
    kind: model.kind,
    pos: { x: st.x[slot], z: st.z[slot] },
    heading: st.heading[slot],
    speed: v,
    active: true,
    model: key,
    variant: st.variant[slot],
    lengthM: st.lengthM[slot],
    widthM: st.widthM[slot],
    lights: lightsOf(st, slot),
    state: wreck ? (model.kind === 'motorbike' ? 'fallen' : 'crashed') : v > 0 ? 'moving' : 'stopped',
    violations: violationsOf(st, slot, st.t),
  };
}

/**
 * Lamps of one agent: hazards on a wreck; brake lamps while braking or stopped; the indicator of a
 * signalled lane change from its decision until the agent has settled in the new lane; else the
 * indicator of the next turn within `behaviour.indicatorLeadS` of the junction and through it.
 * A driver who drew no signal for the change or the turn shows none.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {Readonly<import('../../contracts/telemetry.js').ActorLights>} Shared lamp entry.
 */
function lightsOf(st, slot) {
  if (st.wreck[slot]) return ACTOR_LIGHTS.hazard;
  const brake = st.acc[slot] < -st.params.behaviour.brakeLampMps2 || st.v[slot] < STOPPED_MPS;
  if (st.intent[slot] !== 0) {
    if (st.intentQuiet[slot]) return brake ? ACTOR_LIGHTS.brake : ACTOR_LIGHTS.off;
    if (st.intent[slot] > 0) return brake ? ACTOR_LIGHTS['brake-left'] : ACTOR_LIGHTS.left;
    return brake ? ACTOR_LIGHTS['brake-right'] : ACTOR_LIGHTS.right;
  }
  const edges = st.graph.edges;
  const e = edges[st.edge[slot]];
  let turn = e.turn;
  if (e.kind === 'lane') {
    turn = null;
    const next = st.nextEdge[slot];
    if (next >= 0) {
      const toEnd = e.length - (st.s[slot] + st.lengthM[slot] / 2);
      if (toEnd <= Math.max(st.v[slot], STOPPED_MPS) * st.params.behaviour.indicatorLeadS || st.v[slot] < STOPPED_MPS) {
        turn = edges[next].turn;
      }
    }
  }
  if (st.noSignal[slot]) turn = null;
  if (turn === 'left' || turn === 'uturn') return brake ? ACTOR_LIGHTS['brake-left'] : ACTOR_LIGHTS.left;
  if (turn === 'right') return brake ? ACTOR_LIGHTS['brake-right'] : ACTOR_LIGHTS.right;
  return brake ? ACTOR_LIGHTS.brake : ACTOR_LIGHTS.off;
}

/**
 * IDM acceleration of a slot against one obstacle, clamped at its limits.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} v0 Desired speed.
 * @param {number} gap Gap.
 * @param {number} vLead Obstacle speed along the heading.
 * @returns {number} Acceleration.
 */
function accel(st, slot, v0, gap, vLead) {
  const v = st.v[slot];
  if (gap <= 0) return -st.decelMax[slot];
  const a = idmAcceleration(v, v0, gap, v - vLead, st.accelMax[slot], st.decelComfort[slot], st.timeGap[slot], st.minGap[slot], st.delta[slot]);
  return Math.max(-st.decelMax[slot], Math.min(st.accelMax[slot], a));
}

/**
 * Whether the agent `k` on a sibling connector has parted from the path the slot follows: both
 * rear corners of its body lie to one side of the slot's band on `path` (its lateral offset ± half
 * its width), with `SIBLING_CLEAR_M` to spare. Sibling paths share their first metres and part as
 * they turn, so this is measured on the real geometry, not by a distance along the connector.
 * @param {TrafficState} st State.
 * @param {number} slot Follower.
 * @param {number} path Edge the follower is on, or will take next.
 * @param {number} k Agent on a sibling connector.
 * @returns {boolean} Parted.
 */
function siblingParted(st, slot, path, k) {
  const edge = st.graph.edges[path];
  const h = st.heading[k];
  const c = Math.cos(h);
  const sn = Math.sin(h);
  const half = st.lengthM[k] / 2;
  const hw = st.widthM[k] / 2;
  // Rear centre, then the two rear corners (left of heading θ is (−sin θ, −cos θ)).
  const rx = st.x[k] - c * half;
  const rz = st.z[k] + sn * half;
  const a = edgeLateral(edge, rx - sn * hw, rz - c * hw);
  const b = edgeLateral(edge, rx + sn * hw, rz + c * hw);
  const lo = st.lateral[slot] - st.widthM[slot] / 2;
  const hi = st.lateral[slot] + st.widthM[slot] / 2;
  return Math.min(a, b) > hi + SIBLING_CLEAR_M || Math.max(a, b) < lo - SIBLING_CLEAR_M;
}

/**
 * Takes the first agent of an edge that overlaps the slot laterally as the leader when it is
 * nearer than the one in `out`.
 * @param {TrafficState} st State.
 * @param {number} slot Asking slot.
 * @param {number} edge Edge.
 * @param {number} offset Path distance from the asking agent's front to the edge start.
 * @param {Float64Array} out `[gap, speed]`, updated.
 * @param {number} path −1 for an edge on the slot's route; for a sibling connector, the edge of
 *   the slot's own path: its first agent counts whatever its offset until it has parted from it.
 * @returns {void}
 */
function considerFirst(st, slot, edge, offset, out, path) {
  const list = st.edgeAgents[edge];
  for (let i = 0; i < st.edgeCount[edge]; i += 1) {
    const k = list[i];
    const rear = st.s[k] - st.lengthM[k] / 2;
    if (offset + rear >= out[0]) return;
    if (path >= 0) {
      if (siblingParted(st, slot, path, k) || st.heldBy[k] === slot) return;
    } else if (!overlapsAt(st, slot, st.lateral[slot], k)) continue;
    out[0] = offset + rear;
    out[1] = st.v[k];
    return;
  }
}

/**
 * The agent ahead on the slot's route that overlaps it laterally: on its edge (and, on a
 * connector, on its siblings until they diverge), else first on the next edge (and on sibling
 * connectors of a next connector, until they diverge), else first on the exit lane of a next
 * connector. Writes the true `[gap, speed]` into `out`; the gap is Infinity without one. A merging
 * agent going first is added by `mergeLeader`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {Int32Array} listPos Positions in edge lists.
 * @param {Float64Array} out Output pair.
 * @returns {void}
 */
function leaderAhead(st, slot, listPos, out) {
  out[0] = Infinity;
  out[1] = 0;
  const edges = st.graph.edges;
  const e = st.edge[slot];
  const front = st.s[slot] + st.lengthM[slot] / 2;
  const lat = st.lateral[slot];
  const list = st.edgeAgents[e];
  for (let i = listPos[slot] + 1; i < st.edgeCount[e]; i += 1) {
    const k = list[i];
    const gap = st.s[k] - st.lengthM[k] / 2 - front;
    if (gap > LEADER_LOOK_M) break;
    if (!overlapsAt(st, slot, lat, k)) continue;
    out[0] = gap;
    out[1] = st.v[k];
    break;
  }
  // Connectors leaving the same lane share their first metres: the nearest agent ahead on a
  // sibling counts until it has parted from this path, whatever its offset (the paths cross
  // there). Side by side, the lower spawn index goes first.
  for (const sib of edges[e].siblings) {
    const sl = st.edgeAgents[sib];
    for (let j = 0; j < st.edgeCount[sib]; j += 1) {
      const k = sl[j];
      if (st.s[k] < st.s[slot] || (st.s[k] === st.s[slot] && st.spawnIndex[k] > st.spawnIndex[slot])) continue;
      const rear = st.s[k] - st.lengthM[k] / 2;
      // One whose move this agent's body blocks waits for it to go first.
      if (rear - front < out[0] && st.heldBy[k] !== slot && !siblingParted(st, slot, e, k)) {
        out[0] = rear - front;
        out[1] = st.v[k];
      }
      break;
    }
  }
  const next = st.nextEdge[slot];
  if (out[0] === Infinity && next >= 0) {
    const rem = edges[e].length - front;
    considerFirst(st, slot, next, rem, out, -1);
    const ne = edges[next];
    if (ne.kind === 'connector') {
      for (const sib of ne.siblings) considerFirst(st, slot, sib, rem, out, next);
      if (out[0] === Infinity) considerFirst(st, slot, ne.toEdge, rem + ne.length, out, -1);
    }
    if (out[0] > LEADER_LOOK_M) {
      out[0] = Infinity;
      out[1] = 0;
    }
  }
}

/**
 * At a merge, the claimant of a merging connector that goes first into the shared exit lane is a
 * leader from the slot's claim until both are on the exit lane. Takes it when it is nearer than
 * the one in `out`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {Float64Array} out `[gap, speed]`, updated.
 * @returns {void}
 */
function mergeLeader(st, slot, out) {
  const edges = st.graph.edges;
  const e = st.edge[slot];
  const claim = st.claim[slot];
  const mine = edges[e].kind === 'connector' ? e : claim >= 0 && claim === st.nextEdge[slot] ? claim : -1;
  if (mine < 0) return;
  const dSelf = toExit(st, slot, mine);
  for (const cf of edges[mine].conflicts) {
    if (!cf.merge) continue;
    const list = st.claimants[cf.other];
    for (let i = 0; i < st.claimCount[cf.other]; i += 1) {
      const k = list[i];
      const dK = toExit(st, k, cf.other);
      if (dK === -Infinity || !mergesAhead(dSelf, dK, st.spawnIndex[slot], st.spawnIndex[k])) continue;
      const gap = dSelf - dK - st.lengthM[k];
      if (gap < out[0] && gap <= LEADER_LOOK_M) {
        out[0] = gap;
        out[1] = st.v[k];
      }
    }
  }
}

/** An agent moving across watches agents of the adjacent lanes within this distance along them, metres. */
const ACROSS_WATCH_M = 30;

/**
 * Adds the agents of a lane near `slot` (along the lane) to an obstacle list.
 * @param {TrafficState} st State.
 * @param {number} lane Lane edge.
 * @param {number} slot Asking slot.
 * @param {Obstacle[]} out Obstacles, appended to.
 * @returns {void}
 */
function pushNeighbours(st, lane, slot, out) {
  const list = st.edgeAgents[lane];
  for (let i = 0; i < st.edgeCount[lane]; i += 1) {
    const j = list[i];
    if (Math.abs(st.s[j] - st.s[slot]) > ACROSS_WATCH_M) continue;
    out.push({
      footprint: footprint({ x: st.x[j], z: st.z[j] }, st.heading[j], st.lengthM[j], st.widthM[j]),
      x: st.x[j],
      z: st.z[j],
      radius: Math.hypot(st.lengthM[j], st.widthM[j]) / 2,
      vx: st.v[j] * Math.cos(st.heading[j]),
      vz: -st.v[j] * Math.sin(st.heading[j]),
    });
  }
}

/**
 * Applies the step's events: ego contacts, ego reset, wreck clearing and despawns.
 * @param {TrafficState} st State.
 * @param {TrafficStepInput} input Input.
 * @param {import('./spawner.js').EgoView} ego Ego view.
 * @returns {void}
 */
function applyEvents(st, input, ego) {
  for (const id of input.egoContacts) {
    if (typeof id !== 'string' || !id.startsWith('npc-')) continue;
    const slot = st.slotBySpawn.get(Number(id.slice(4)));
    if (slot === undefined) continue;
    // Struck by the ego (or striking it), a car stops dead instead of sliding on; a wreck already
    // sliding stops there too, as its slide does not see the ego.
    makeWreck(st, slot, input.t);
    st.v[slot] = 0;
    st.acc[slot] = 0;
  }
  if (input.egoReset) {
    const e = input.ego;
    const r = st.params.egoPerceptionM;
    for (let i = 0; i < st.activeCount; i += 1) {
      const k = st.active[i];
      if (Math.hypot(st.x[k] - e.pos.x, st.z[k] - e.pos.z) <= r) resetPerception(st, k);
    }
    const guard = footprint(e.pos, e.heading, e.lengthM + 2 * RESET_CLEAR_MARGIN_M, e.widthM + 2 * RESET_CLEAR_MARGIN_M);
    for (let i = st.activeCount - 1; i >= 0; i -= 1) {
      const k = st.active[i];
      if (polygonsIntersect(guard, footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]))) {
        despawnAgent(st, k, 'reset');
      }
    }
  }
  const p = st.params;
  const hx = Math.cos(ego.heading);
  const hz = -Math.sin(ego.heading);
  const outer = /** @type {import('../../contracts/map.js').TrafficConfig} */ (st.map.traffic).spawnRingM[1];
  for (let i = st.activeCount - 1; i >= 0; i -= 1) {
    const k = st.active[i];
    const dx = st.x[k] - ego.x;
    const dz = st.z[k] - ego.z;
    const ahead = dx * hx + dz * hz;
    const dist = Math.hypot(dx, dz);
    if (st.wreck[k]) {
      if (input.t - st.wreckT[k] >= p.wreckClearS || (dist > p.wreckClearDistM && ahead < 0)) despawnAgent(st, k, 'wreck');
      continue;
    }
    if (-ahead > p.despawnBehindM) {
      despawnAgent(st, k, 'behind');
      continue;
    }
    const receding = dx * Math.cos(st.heading[k]) - dz * Math.sin(st.heading[k]) > 0;
    if (dist > outer && receding) {
      despawnAgent(st, k, 'ring');
      continue;
    }
    const e = st.graph.edges[st.edge[k]];
    const toEnd = e.length - (st.s[k] + st.lengthM[k] / 2);
    if (st.v[k] >= STOPPED_MPS || inViewCone(ego, st.x[k], st.z[k], st.params)) continue;
    // Last resort: held by a body in its way for too long, out of the player's sight, it leaves
    // (as SUMO teleports a vehicle stuck past its time-to-teleport). Waiting at a light or a
    // claim is not a hold and never counts.
    if (st.frozenS[k] > STUCK_DESPAWN_S) despawnAgent(st, k, 'stuck');
    else if (e.deadEnd && toEnd < st.minGap[k] + 1) despawnAgent(st, k, 'dead-end');
    // Held up at the edge of the map (by a scripted actor parked at the end of its path): it
    // leaves as if it had reached the end, counted apart from the agents that drove off it.
    else if (e.sink && toEnd < SINK_EDGE_M) despawnAgent(st, k, 'edge-held');
  }
}

/**
 * Distance from the agent's front to the stop line of the lane just past its next junction (or
 * past the connector it is on) when that light tells it to stop there, else Infinity: red while it
 * can still stop with its braking limit, or yellow by the fixed stop rule. A short lane between two
 * junctions is braked for before the agent reaches it.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {Record<string, LightState>} lights Light states.
 * @param {number} t Time.
 * @returns {number} Metres.
 */
function downstreamStop(st, slot, lights, t) {
  const edges = st.graph.edges;
  const e = edges[st.edge[slot]];
  const front = st.s[slot] + st.lengthM[slot] / 2;
  let exit;
  let d;
  if (e.kind === 'connector') {
    exit = edges[e.toEdge];
    d = e.length - front;
  } else {
    const next = st.nextEdge[slot];
    if (next < 0 || edges[next].kind !== 'connector') return Infinity;
    exit = edges[edges[next].toEdge];
    d = e.length - front + edges[next].length;
  }
  if (exit.signalIndex < 0 || exit.next.length === 0) return Infinity;
  const dist = d + exit.holdS;
  const v = st.v[slot];
  if (dist < 0 || dist > (v * v) / (2 * st.decelComfort[slot]) + DOWNSTREAM_LOOK_M) return Infinity;
  const light = laneLight(st, exit, lights);
  if (light === 'green') return Infinity;
  const left = light === 'yellow' ? yellowRemaining(st.map.signals[exit.signalIndex], t) : 0;
  const decision = signalDecision(light, dist, v, left, st.yellowStop[slot], st.decelMax[slot], st.params.behaviour.yellowGoMarginS);
  return decision === 'stop' ? dist : Infinity;
}

/**
 * Agents an ego signalling into `lane` and moving across it makes way for: the ego, ahead of the
 * agent, counts as its leader. Writes `[gap, speed]` into `out` (Infinity when it does not apply).
 * A driver ignores it with its `cutIn` rate, drawn once per signalling episode of the ego.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {EgoInput} ego Ego.
 * @param {import('./junctions.js').EgoParty} party Ego party.
 * @param {number} egoDist Distance to the ego.
 * @param {Float64Array} out Output pair.
 * @returns {void}
 */
function signallingEgo(st, slot, ego, party, egoDist, out) {
  out[0] = Infinity;
  out[1] = 0;
  const ind = ego.indicators;
  if ((ind !== 'left' && ind !== 'right') || party.lane < 0 || egoDist > st.params.egoPerceptionM) return;
  const edges = st.graph.edges;
  const e = edges[st.edge[slot]];
  if (e.kind !== 'lane' || !edges[party.lane].neighbours.includes(e.index)) return;
  const pr = projectOntoPolyline([ego.pos.x, ego.pos.z], e.points);
  // Left of the agent's lane, the ego comes in signalling right, and the reverse.
  if ((pr.lateral > 0 ? 'right' : 'left') !== ind) return;
  edgePoint(e, Math.min(pr.s, e.length), LANE_POINT);
  const sideways = -Math.sign(pr.lateral) * ego.speed * Math.sin(ego.heading - LANE_POINT.heading);
  if (sideways < EGO_SIDEWAYS_MPS) return;
  const gap = pr.s - ego.lengthM / 2 - (st.s[slot] + st.lengthM[slot] / 2);
  if (gap < 0) return;
  const rng = createStream(hash32(st.decisionSeed[slot], st.egoSignalEpisode, 0x4b14));
  if (uniform(rng) < rateOf(st, slot, 'cutIn', egoDist)) return;
  out[0] = gap;
  out[1] = Math.max(0, ego.speed * Math.cos(ego.heading - LANE_POINT.heading));
}

/**
 * Computes every agent's accelerations and junction request from the state at `t`, and raises the
 * `tailgating` and `speeding` conditions.
 * @param {TrafficState} st State.
 * @param {TrafficStepInput} input Input.
 * @param {Obstacle[]} egoObs The ego as an obstacle (one entry).
 * @param {Obstacle[]} scriptedObs Scripted actors as obstacles.
 * @param {Scratch} sc Scratch.
 * @returns {number} Number of claim requests.
 */
function computePhase(st, input, egoObs, scriptedObs, sc) {
  const edges = st.graph.edges;
  const yellowMargin = st.params.behaviour.yellowGoMarginS;
  const viol = st.params.violations;
  const pair = sc.pair;
  const seen = sc.perceived2;
  const ego = input.ego;
  const t = input.t;
  const egoMid = sc.egoMid;
  egoMid.x = ego.pos.x;
  egoMid.z = ego.pos.z;
  egoMid.lengthM = ego.lengthM;
  const party = sc.egoParty;
  const check = sc.check;
  const near = sc.near;
  const statics = st.graph.staticObstacles;
  const movers = sc.movers;
  movers.length = 0;
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    if (st.wreck[k]) continue;
    // Moving across lanes, or a rider out on the lane line: perceived exactly by everyone.
    const out = Math.abs(st.lateral[k]) + st.widthM[k] / 2 > st.halfWidth[st.edge[k]];
    if (!changingLane(st, k) && !out) continue;
    movers.push({
      slot: k,
      obstacle: {
        footprint: footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]),
        x: st.x[k],
        z: st.z[k],
        radius: Math.hypot(st.lengthM[k], st.widthM[k]) / 2,
        vx: st.v[k] * Math.cos(st.heading[k]),
        vz: -st.v[k] * Math.sin(st.heading[k]),
      },
    });
  }
  let nReq = 0;

  sc.reserved.fill(0);
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    const c = st.claim[k];
    if (c >= 0 && st.edge[k] !== edges[c].toEdge) sc.reserved[edges[c].toEdge] += st.lengthM[k] + st.minGap[k];
  }

  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    sc.holds[k] = 0;
    sc.drops[k] = 0;
    sc.inZone[k] = 0;
    sc.noYield[k] = 0;
    sc.forcing[k] = 0;
    sc.runner[k] = 0;
    sc.held[k] = 0;
    sc.commit[k] = st.signalCommit[k];
    const e = edges[st.edge[k]];
    const v = st.v[k];
    if (st.wreck[k]) {
      // A sliding wreck stops at anything ahead of it.
      leaderAhead(st, k, sc.listPos, pair);
      sc.accGo[k] = v > 0 ? -st.params.behaviour.wreckSlideDecelMps2 : 0;
      sc.advGo[k] = e.kind === 'lane' && st.nextEdge[k] >= 0 && edges[st.nextEdge[k]].kind === 'connector' && st.claim[k] !== st.nextEdge[k] ? Math.min(pair[0], e.length - (st.s[k] + st.lengthM[k] / 2)) : pair[0];
      continue;
    }
    const half = st.lengthM[k] / 2;
    const front = st.s[k] + half;
    const b = st.decelComfort[k];
    const next = st.nextEdge[k];

    // Desired speed, anticipating the turn speed of the next connector.
    let v0 = st.baseV0[k] * st.v0Factor[k];
    if (e.kind === 'lane' && next >= 0 && Number.isFinite(edges[next].turnSpeedMps)) {
      const vt = edges[next].turnSpeedMps;
      v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * b * Math.max(0, e.length - front)));
    }
    v0 = Math.max(v0, 0.5);

    // The agent ahead, as the driver perceives it; the advance stops at the true gap unless the
    // driver is distracted.
    leaderAhead(st, k, sc.listPos, pair);
    // A leader overlapping the body already (a rider alongside that the clearance at this speed
    // counts as in the way) is a contact to avoid, not a gap kept too short.
    if (pair[0] > 0 && pair[0] < Infinity && v > TAILGATE_MIN_MPS && pair[0] / v < st.tailgateGap[k]) raise(st, k, FLAG.tailgating);
    // Joining the exit lane behind a merging agent is not following it too closely.
    mergeLeader(st, k, pair);
    const trueGap = pair[0];
    if (e.limitKmh !== null && v > e.limitKmh / 3.6) raise(st, k, FLAG.speeding);
    perceiveLeader(st, k, trueGap, pair[1], t, seen);
    let gapGo = distracted(st, k, t) ? Infinity : trueGap - QUEUE_BUFFER_M;
    let accGo = accel(st, k, v0, seen[0], seen[1]);

    // Exact perception of the ego, scripted actors, static obstacles and agents moving across.
    near.length = 0;
    const edx = ego.pos.x - st.x[k];
    const edz = ego.pos.z - st.z[k];
    const egoDist = Math.hypot(edx, edz);
    if (egoDist <= st.params.egoPerceptionM) near.push(egoObs[0]);
    for (const o of scriptedObs) near.push(o);
    for (const o of statics) near.push(o);
    // Agents of its own lane are leaders already; only those moving across are not. One moving
    // across is in the way only once wholly ahead: alongside, the agent keeps going and the one
    // moving across waits (its contact guard holds it). Between two moving across, the later
    // spawned gives way to the other wherever it is.
    const across = changingLane(st, k);
    const hx = Math.cos(st.heading[k]);
    const hz = -Math.sin(st.heading[k]);
    for (const m of movers) {
      const j = m.slot;
      if (j === k || (st.edge[j] === st.edge[k] && !changingLane(st, j))) continue;
      const rearAhead = (st.x[j] - st.x[k]) * hx + (st.z[j] - st.z[k]) * hz - st.lengthM[j] / 2 > half;
      if (rearAhead || (across && changingLane(st, j) && st.spawnIndex[k] > st.spawnIndex[j])) near.push(m.obstacle);
    }
    // Moving across, it still overlaps the lane it left: it keeps watching the agents there.
    if (across) for (const n of e.neighbours) pushNeighbours(st, n, k, near);
    if (near.length > 0) {
      const look = Math.max(8, Math.min(st.params.egoPerceptionM, (v * v) / (2 * b) + v * st.timeGap[k] + st.minGap[k] + 5));
      corridorObstacle(st, k, near, look, pair);
      if (pair[0] < Infinity) {
        gapGo = Math.min(gapGo, pair[0]);
        accGo = Math.min(accGo, accel(st, k, v0, pair[0], pair[1]));
      }
    }
    // An ego signalling into this lane and moving across: make way.
    signallingEgo(st, k, ego, party, egoDist, pair);
    if (pair[0] < Infinity) accGo = Math.min(accGo, accel(st, k, v0, pair[0], pair[1]));
    // A red stop line just past the junction ahead.
    const dDown = downstreamStop(st, k, input.lights, t);
    if (dDown < Infinity) {
      accGo = Math.min(accGo, accel(st, k, v0, dDown, 0));
      gapGo = Math.min(gapGo, dDown);
    }
    sc.accGo[k] = accGo;
    sc.advGo[k] = gapGo;

    // Hold point before the next connector, or the end of a dead-end lane. A lane that joins
    // another has none, except for an agent still moving across, which keeps to its lane until it
    // has settled.
    if (e.kind !== 'lane' || e.sink) continue;
    if (next >= 0 && edges[next].kind === 'lane') {
      if (across) {
        const dEnd = e.length - front;
        sc.accGo[k] = Math.min(accGo, accel(st, k, v0, dEnd, 0));
        sc.advGo[k] = Math.min(gapGo, dEnd);
      }
      continue;
    }
    const holdAt = next < 0 ? e.length : front > e.holdS + 0.01 ? e.length : e.holdS;
    const dHold = holdAt - front;
    sc.holdDist[k] = dHold;
    const holdAcc = Math.min(accGo, accel(st, k, v0, dHold, 0));
    if (next < 0) {
      sc.accGo[k] = holdAcc;
      sc.advGo[k] = Math.min(gapGo, dHold);
      continue;
    }
    const zone = dHold <= (v * v) / (2 * b) + st.minGap[k] + 0.5 * v + 3;
    const light = laneLight(st, e, input.lights);
    let signalGo = true;
    if (light !== null && front <= e.holdS + 0.01 && distracted(st, k, t) && sc.commit[k] !== 1) {
      // Distracted, the driver misses the change of light and goes on as before.
      signalGo = true;
    } else if (light !== null && front <= e.holdS + 0.01) {
      const d = Math.max(0, e.holdS - front);
      const signal = st.map.signals[e.signalIndex];
      if (light === 'green') {
        sc.commit[k] = 0;
        st.approachDraws[k] &= ~RUNNING;
      } else if (light === 'red') {
        if (!(sc.commit[k] === 2 && st.approachDraws[k] & RUNNING)) {
          sc.commit[k] = signalDecision('red', d, v, 0, st.yellowStop[k], st.decelMax[k], yellowMargin) === 'go' ? 2 : 1;
          // Rule breaking, each drawn once per approach: running the red from the decision zone,
          // or starting early from the stop line when the red is nearly over.
          if (sc.commit[k] === 1 && zone && !(st.approachDraws[k] & RED_DRAWN)) {
            st.approachDraws[k] |= RED_DRAWN;
            if (draw(st, k, rateOf(st, k, 'redLight', egoDist))) st.approachDraws[k] |= RUNNING;
          }
          if (sc.commit[k] === 1 && v < STOPPED_MPS && d < st.minGap[k] + 1.5 && redRemaining(signal, t) < viol.earlyStartRedRemainingS && !(st.approachDraws[k] & EARLY_DRAWN)) {
            st.approachDraws[k] |= EARLY_DRAWN;
            if (draw(st, k, rateOf(st, k, 'earlyStart', egoDist))) st.approachDraws[k] |= RUNNING;
          }
          if (st.approachDraws[k] & RUNNING) sc.commit[k] = 2;
        }
      } else {
        const left = yellowRemaining(signal, t);
        if (sc.commit[k] === 0) {
          // Stop or go at the yellow onset. Where both are lawful (the front reaches the line before
          // the red, and a stop is within the braking limit) the choice is logistic around the
          // driver's b_stop; otherwise the fixed stop rule decides.
          const need = d > 0.05 ? (v * v) / (2 * d) : v > 0.05 ? Infinity : 0;
          if (need <= st.decelMax[k] && reachesBeforeRed(d, v, left, yellowMargin)) {
            const p = yellowStopProbability(d, v, st.yellowStop[k], st.decelMax[k], viol.yellowLogisticK);
            sc.commit[k] = draw(st, k, p) ? 1 : 2;
          } else {
            sc.commit[k] = signalDecision('yellow', d, v, left, st.yellowStop[k], st.decelMax[k], yellowMargin) === 'go' ? 2 : 1;
          }
        } else if (sc.commit[k] === 2 && !(st.approachDraws[k] & RUNNING) && !reachesBeforeRed(d, v, left, yellowMargin) && (v * v) / (2 * Math.max(d, 0.05)) <= st.decelMax[k]) {
          // Went for the yellow, but slowed (a queue, a yield): stop while it still can.
          sc.commit[k] = 1;
        }
      }
      signalGo = light === 'green' || sc.commit[k] === 2;
    }
    const running = light === 'red' && signalGo;

    // Stopped by what lies ahead (the ego, a scripted actor, the agent in front) and able to move
    // no further: no claim, so a held-up agent never blocks the junction.
    const blockedAhead = v < STOPPED_MPS && accGo <= 0;
    if (st.claim[k] === next) {
      // Already claimed: give it back for a signal the agent can still stop for, while it stands
      // blocked before the hold point, or for a wreck in its way while it can still stop before
      // the junction.
      const wreckAhead = front <= e.holdS + 0.01 && (v * v) / (2 * b) <= dHold && wreckInWay(st, next);
      if (!signalGo || blockedAhead || wreckAhead) {
        sc.drops[k] = 1;
        sc.holds[k] = 1;
        sc.accHold[k] = holdAcc;
        sc.advHold[k] = Math.min(gapGo, dHold);
      }
      continue;
    }

    sc.holds[k] = 1;
    sc.accHold[k] = holdAcc;
    sc.advHold[k] = Math.min(gapGo, dHold);
    // Outside the decision zone, only a light the agent will stop for brakes it early.
    if (!zone) {
      if (signalGo) {
        sc.holds[k] = 0;
      }
      continue;
    }
    sc.inZone[k] = 1;
    if (!signalGo) continue;
    // A long vehicle may still cover a zone of the junction behind it: claim one at a time, but a
    // vehicle standing on the exit lane of its claim asks for the next one (its tail stays where it
    // is, so holding on would lock both junctions).
    if ((st.claim[k] >= 0 && st.edge[k] !== edges[st.claim[k]].toEdge) || across) continue;
    if (blockedAhead) {
      sc.held[k] = HELD_BLOCKED;
      continue;
    }
    if (e.control === 'stop-sign' && !st.haltedAtLine[k]) continue;
    // A rider turning from the wrong side of its lane waits to get across first (it would cut
    // across the riders beside it).
    if (!inTurnBand(st, k, next)) continue;
    const egoNear = Math.abs(edx) + Math.abs(edz) < 200 ? egoMid : null;
    if (exitRoom(st, next, k, sc.reserved, egoNear, input.lights) < st.lengthM[k] + st.minGap[k]) {
      sc.held[k] = HELD_EXIT;
      continue;
    }
    if (running) {
      // A red runner looks only at the box itself.
      checkConflicts(st, k, next, input.lights, party, check);
      if (zonesOccupied(st, next, k)) continue;
      sc.noYield[k] = check.claimed || check.noYield ? 1 : 0;
      sc.forcing[k] = 1;
      sc.runner[k] = 1;
      sc.requests[nReq++] = k;
      continue;
    }
    if (defersToWaiter(st, k, next, dHold, input.lights)) continue;
    checkConflicts(st, k, next, input.lights, party, check);
    if (check.claimed) continue;
    if (check.yields && !breaksDeadlock(st, k, check)) continue;
    sc.noYield[k] = check.noYield ? 1 : 0;
    // A driver going by the deadlock breaker creeps in watching; one taking a short gap forces it.
    sc.forcing[k] = check.noYield && !check.yields ? 1 : 0;
    sc.requests[nReq++] = k;
  }
  return nReq;
}

/**
 * Footprints of every active agent before this step's motion, by slot.
 * @param {TrafficState} st State.
 * @param {Scratch} sc Scratch.
 * @returns {Vec2[][]} Footprints by slot.
 */
function bodiesOf(st, sc) {
  const feet = sc.feet;
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    feet[k] = footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]);
    // Motion replaces `feet[k]` with a new polygon, so this keeps the body before the step.
    sc.feetBefore[k] = feet[k];
  }
  return feet;
}

/**
 * Whether the driver of `slot` acts on what it sees: not distracted, not past a stop line on red,
 * not forcing its way into a junction inside another party's critical gap, not cutting in. Each
 * of those carries an incident cause from the moment the guard is off.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time.
 * @returns {boolean} Guarded.
 */
function guarded(st, slot, t) {
  return !distracted(st, slot, t) && !st.heedless[slot];
}

/** Largest half diagonal of any agent body, metres. */
const MAX_BODY_RADIUS_M = 6;

/**
 * Whether moving `slot` by `ds` along its route, at its new lateral offset, would make its body
 * touch another agent's body that it does not touch now (others as they stand after the moves
 * made before it this step).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ds Advance along its edge (its lateral offset is already moved).
 * @param {Vec2[][]} feet Footprints before the motion, by slot.
 * @returns {boolean} A new touch.
 */
function touchesNew(st, slot, ds, feet) {
  posePreview(st, slot, st.edge[slot], st.s[slot] + ds, st.lateral[slot], st.latRate[slot], st.v[slot], PREVIEW);
  const { x, z } = PREVIEW;
  const moved = footprint(PREVIEW, PREVIEW.heading, st.lengthM[slot], st.widthM[slot]);
  const now = feet[slot];
  const r = Math.hypot(st.lengthM[slot], st.widthM[slot]) / 2 + MAX_BODY_RADIUS_M;
  return queryGrid(st.grid, x, z, r, (k) => {
    if (k === slot) return false;
    const dx = st.x[k] - x;
    const dz = st.z[k] - z;
    const rr = (Math.hypot(st.lengthM[k], st.widthM[k]) + Math.hypot(st.lengthM[slot], st.widthM[slot])) / 2;
    if (dx * dx + dz * dz > rr * rr) return false;
    if (!polygonsIntersect(moved, feet[k]) || polygonsIntersect(now, feet[k])) return false;
    TOUCHED.slot = k;
    return true;
  });
}

/** @type {{x: number, z: number, heading: number}} */
const PREVIEW = { x: 0, z: 0, heading: 0 };
/** The body the last `touchesNew` found in the way. */
const TOUCHED = { slot: -1 };
/** An agent held by the body in its way this long starts to edge away from it, seconds (design). */
export const NUDGE_AFTER_S = 1;
/** How far a held agent edges sideways at a time, metres (design). */
const NUDGE_M = 0.4;
/** A rider that edged aside for a held one keeps its place this long, seconds (design). */
const MAKE_ROOM_S = 3;

/**
 * Moves a held agent's lateral target away from the body in its way, within its lane.
 * @param {TrafficState} st State.
 * @param {number} slot Held agent.
 * @param {number} other Body in its way.
 * @returns {void}
 */
function nudgeAway(st, slot, other) {
  if (other < 0) return;
  // Left of heading θ is (−sin θ, −cos θ); the other on the left means edging right.
  const h = st.heading[slot];
  const left = -(st.x[other] - st.x[slot]) * Math.sin(h) - (st.z[other] - st.z[slot]) * Math.cos(h);
  const hw = st.halfWidth[st.edge[slot]] - st.widthM[slot] / 2;
  const target = st.lateral[slot] + (left > 0 ? -NUDGE_M : NUDGE_M);
  st.lateralBase[slot] = Math.max(-hw, Math.min(hw, target));
}

/**
 * Grants claim requests nearest the hold point first, each re-checked against claims granted
 * before it (a red runner only against zones physically taken); then integrates every agent,
 * moves it along its route and raises the `red-light`, `no-yield` and `unsafe-lane-change`
 * conditions from what it did.
 * @param {TrafficState} st State.
 * @param {TrafficStepInput} input Input.
 * @param {Scratch} sc Scratch.
 * @param {number} nReq Requests.
 * @returns {void}
 */
function applyPhase(st, input, sc, nReq) {
  const edges = st.graph.edges;
  const req = sc.requests;
  // Insertion sort by hold distance, then spawn index.
  for (let i = 1; i < nReq; i += 1) {
    const k = req[i];
    let j = i - 1;
    while (j >= 0 && (sc.holdDist[req[j]] > sc.holdDist[k] || (sc.holdDist[req[j]] === sc.holdDist[k] && st.spawnIndex[req[j]] > st.spawnIndex[k]))) {
      req[j + 1] = req[j];
      j -= 1;
    }
    req[j + 1] = k;
  }
  const egoMid = sc.egoMid;
  for (let i = 0; i < nReq; i += 1) {
    const k = req[i];
    const conn = st.nextEdge[k];
    let ok = true;
    if (sc.runner[k]) ok = !zonesOccupied(st, conn, k);
    else {
      for (const cf of edges[conn].conflicts) {
        if (zoneClaimed(st, conn, cf, k)) {
          ok = false;
          break;
        }
      }
    }
    if (ok && exitRoom(st, conn, k, sc.reserved, egoMid, input.lights) < st.lengthM[k] + st.minGap[k]) ok = false;
    if (!ok) continue;
    claimDrop(st, k);
    claimAdd(st, conn, k);
    sc.reserved[edges[conn].toEdge] += st.lengthM[k] + st.minGap[k];
    sc.holds[k] = 0;
    st.waitS[k] = 0;
    // The flag is raised as the claim is taken, so a contact in this very step already has its
    // cause; a red runner stops heeding what it sees only once past the stop line.
    if (sc.noYield[k]) {
      st.noYieldConn[k] = conn;
      raise(st, k, FLAG['no-yield']);
    }
    if (sc.forcing[k] && !sc.runner[k]) st.heedless[k] = 1;
  }

  const dt = DT;
  const pair = sc.pair;
  const feet = bodiesOf(st, sc);
  rebuildGrid(st.grid, st.active, st.activeCount, st.x, st.z);
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    st.signalCommit[k] = sc.commit[k];
    st.held[k] = sc.held[k];
    if (st.wreck[k]) {
      // A car wreck slides on and stops at anything ahead; a fallen rider stays.
      if (st.v[k] > 0) {
        integrate(st.v[k], sc.accGo[k], dt, pair);
        const adv = Math.max(0, sc.advGo[k] - CLAMP_MARGIN_M);
        let ds = Math.min(pair[0], adv);
        st.v[k] = pair[0] > adv ? 0 : pair[1];
        if (ds > 0 && touchesNew(st, k, ds, feet)) {
          ds = 0;
          st.v[k] = 0;
        }
        st.s[k] += ds;
      }
      continue;
    }
    if (sc.drops[k]) claimDrop(st, k);
    const hold = sc.holds[k] === 1;
    const acc = hold ? sc.accHold[k] : sc.accGo[k];
    const adv = Math.max(0, (hold ? sc.advHold[k] : sc.advGo[k]) - CLAMP_MARGIN_M);
    integrate(st.v[k], acc, dt, pair);
    let ds = pair[0];
    let vNext = pair[1];
    if (ds > adv) {
      ds = adv;
      vNext = 0;
    }
    st.acc[k] = acc;
    st.v[k] = vNext;
    // A rider stops moving across when someone has come alongside in the way.
    if (st.isMoto[k] && !st.crossing[k] && st.lateral[k] !== st.lateralBase[k]) {
      const next = st.lateral[k] + Math.sign(st.lateralBase[k] - st.lateral[k]) * Math.min(Math.abs(st.lateralBase[k] - st.lateral[k]), 0.1);
      if (pathBlocked(st, k, next) || moveTouches(st, k, next)) st.lateralBase[k] = st.lateral[k];
    }
    const latBefore = st.lateral[k];
    const rateBefore = st.latRate[k];
    st.heldBy[k] = -1;
    moveAcross(st, k, dt);
    // A driver who sees what is around it never drives into it; one distracted or breaking a rule
    // may (that is how an accident happens).
    const dLat = st.lateral[k] - latBefore;
    // A change of lateral speed turns the body (lane-change yaw), which can swing it into another.
    if (ds > 0 || dLat !== 0 || st.latRate[k] !== rateBefore) {
      let held = guarded(st, k, input.t) && touchesNew(st, k, ds, feet);
      const turned = dLat !== 0 || st.latRate[k] !== rateBefore;
      if (held && turned && ds > 0) {
        // Forward only: the sideways move is what touches, so give it up and keep going.
        const lat = st.lateral[k];
        const rate = st.latRate[k];
        st.lateral[k] = latBefore;
        st.latRate[k] = rateBefore;
        held = touchesNew(st, k, ds, feet);
        if (held) {
          st.lateral[k] = lat;
          st.latRate[k] = rate;
        }
      }
      if (held) {
        ds = 0;
        st.v[k] = 0;
        const blocker = TOUCHED.slot;
        // Held where it is; it may still move sideways, its body kept straight as when edged across
        // at a standstill, if that alone touches nothing; else its body stays turned as it was.
        st.latRate[k] = 0;
        if (dLat === 0 || touchesNew(st, k, 0, feet)) {
          st.lateral[k] = latBefore;
          st.latRate[k] = rateBefore;
        } else {
          // Later agents of this step check against where it has moved sideways.
          posePreview(st, k, st.edge[k], st.s[k], st.lateral[k], 0, 0, PREVIEW);
          feet[k] = footprint(PREVIEW, PREVIEW.heading, st.lengthM[k], st.widthM[k]);
        }
        TOUCHED.slot = blocker;
        st.heldBy[k] = blocker;
        st.frozenS[k] += dt;
        // Held this way for a while, an agent edges sideways within its lane, away from the body in
        // its way, so two agents cannot hold each other for ever. One moving across keeps its
        // target: it still watches the lane it is leaving, and others see it as moving across.
        if (!st.crossing[k] && st.frozenS[k] > NUDGE_AFTER_S) {
          nudgeAway(st, k, TOUCHED.slot);
          // A rider standing on its lane in the way edges aside as well, and keeps that place a
          // while, to let the held one through (a turning rider's swinging body can be pinned
          // between two standing ones).
          const b = TOUCHED.slot;
          if (b >= 0 && st.isMoto[b] && !st.wreck[b] && !st.crossing[b] && st.v[b] < STOPPED_MPS && edges[st.edge[b]].kind === 'lane') {
            nudgeAway(st, b, k);
            st.makeRoomUntil[b] = input.t + MAKE_ROOM_S;
          }
        }
      } else {
        st.frozenS[k] = 0;
        // Later agents of this step check against where this one has moved.
        posePreview(st, k, st.edge[k], st.s[k] + ds, st.lateral[k], st.latRate[k], st.v[k], PREVIEW);
        feet[k] = footprint(PREVIEW, PREVIEW.heading, st.lengthM[k], st.widthM[k]);
      }
    }
    // Waiting and the stop-sign halt.
    if (sc.inZone[k] && hold && vNext < STOPPED_MPS) {
      st.waitS[k] += dt;
      if (sc.holdDist[k] < st.minGap[k] + 1.5) st.haltedAtLine[k] = 1;
    }
    // The front crossing the stop line on red.
    const e = edges[st.edge[k]];
    if (e.kind === 'lane' && e.signalIndex >= 0 && st.nextEdge[k] >= 0 && edges[st.nextEdge[k]].kind === 'connector') {
      const front = st.s[k] + st.lengthM[k] / 2;
      if (front <= e.holdS && front + ds > e.holdS && laneLight(st, e, input.lights) === 'red') {
        st.redConn[k] = st.nextEdge[k];
        st.heedless[k] = 1;
        raise(st, k, FLAG['red-light']);
      }
    }
    st.s[k] += ds;
  }
  // Edge transitions, in spawn order; despawns at sinks compact the active list afterwards.
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    let e = edges[st.edge[k]];
    while (st.alive[k] && st.s[k] > e.length) {
      const next = st.nextEdge[k];
      if (e.kind === 'lane' && e.sink) {
        despawnAgent(st, k, 'sink');
        i -= 1;
        break;
      }
      if (next < 0 || (e.kind === 'lane' && edges[next].kind === 'connector' && st.claim[k] !== next)) {
        // Only rounding can get here: the advance is clamped at the hold point.
        st.s[k] = e.length;
        break;
      }
      edgeRemove(st, e.index, k);
      st.s[k] -= e.length;
      st.edge[k] = next;
      edgeInsert(st, next, k);
      e = edges[next];
      if (e.kind === 'lane') {
        st.signalCommit[k] = 0;
        st.haltedAtLine[k] = 0;
        st.waitS[k] = 0;
        st.approachDraws[k] = 0;
      }
      refreshBaseSpeed(st, k);
      chooseNext(st, k);
    }
  }
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    const c = st.claim[k];
    if (c >= 0 && st.edge[k] !== c && st.edge[k] !== edges[c].fromEdge && st.edge[k] !== edges[c].toEdge) claimDrop(st, k);
    else if (c >= 0 && !claimBlocking(st, k, c)) claimDrop(st, k);
  }
  sortEdgeLists(st);
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    updatePose(st, k);
    // Conditions that last while the agent is still in what it did wrong.
    const rc = st.redConn[k];
    if (rc >= 0) {
      if (st.edge[k] === rc || st.edge[k] === edges[rc].fromEdge) raise(st, k, FLAG['red-light']);
      else st.redConn[k] = -1;
    }
    const ny = st.noYieldConn[k];
    if (ny >= 0) {
      if (st.claim[k] === ny) raise(st, k, FLAG['no-yield']);
      else st.noYieldConn[k] = -1;
    }
    if (st.unsafeChange[k] && st.crossing[k]) raise(st, k, FLAG['unsafe-lane-change']);
    st.heedless[k] = (st.heedless[k] && (st.redConn[k] >= 0 || st.noYieldConn[k] >= 0)) || (st.unsafeChange[k] && st.crossing[k]) ? 1 : 0;
  }
  // A rider moving its slot into the ego's path inside the ego's stopping distance: raised on the
  // step its own motion takes its body into the corridor from outside, so a rider already in the
  // ego's path, or one the corridor grows or swings over as the ego speeds up or steers, is not
  // cutting in.
  const corridor = egoCorridorOf(input.ego);
  if (corridor) {
    const ex = input.ego.pos.x;
    const ez = input.ego.pos.z;
    for (let i = 0; i < st.activeCount; i += 1) {
      const k = st.active[i];
      const lr = st.latRate[k];
      if (!st.isMoto[k] || lr === 0 || st.wreck[k]) continue;
      const toward = (-(ex - st.x[k]) * Math.sin(st.heading[k]) - (ez - st.z[k]) * Math.cos(st.heading[k])) * lr > 0;
      if (toward && !polygonsIntersect(corridor, sc.feetBefore[k]) && polygonsIntersect(corridor, footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]))) {
        raise(st, k, FLAG['unsafe-lane-change']);
      }
    }
  }
}

/**
 * What a rider going round the ego must also keep clear of: the scripted actors and static
 * obstacles of `perceived` (all but its first entry, the ego) and every other agent within
 * `radius`, from the grid.
 * @param {TrafficState} st State, with the grid built over the agents' current centres.
 * @param {number} slot Rider.
 * @param {readonly Obstacle[]} perceived The ego, then scripted actors and static obstacles.
 * @param {number} radius Search radius, metres.
 * @returns {Obstacle[]} Obstacles.
 */
function nearbyObstacles(st, slot, perceived, radius) {
  const out = perceived.slice(1);
  queryGrid(st.grid, st.x[slot], st.z[slot], radius, (k) => {
    if (k === slot) return false;
    out.push({
      footprint: footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]),
      x: st.x[k],
      z: st.z[k],
      radius: Math.hypot(st.lengthM[k], st.widthM[k]) / 2,
      vx: st.v[k] * Math.cos(st.heading[k]),
      vz: -st.v[k] * Math.sin(st.heading[k]),
    });
    return false;
  });
  return out;
}

/**
 * Positions of every slot in its edge list.
 * @param {TrafficState} st State.
 * @param {Int32Array} listPos Output.
 * @returns {void}
 */
function refreshListPositions(st, listPos) {
  for (let e = 0; e < st.edgeAgents.length; e += 1) {
    const list = st.edgeAgents[e];
    for (let i = 0; i < st.edgeCount[e]; i += 1) listPos[list[i]] = i;
  }
}

/**
 * Advances traffic by one DT. Mutates and returns `state`.
 * @param {TrafficState} state State from `createTraffic`.
 * @param {TrafficStepInput} input Step input.
 * @returns {TrafficStep} Poses at `input.t` and the advanced state.
 */
export function stepTraffic(state, input) {
  checkInput(input);
  const st = state;
  const sc = scratchOf(st);
  st.t = input.t;
  const e = input.ego;
  const fp = footprint(e.pos, e.heading, e.lengthM, e.widthM);
  const egoView = {
    x: e.pos.x,
    z: e.pos.z,
    heading: e.heading,
    speed: e.speed,
    // Turn rate from the last step; none across a reset (the ego is put back somewhere else).
    yawRate: Number.isNaN(st.egoHeadingBefore) || input.egoReset ? 0 : angleDiff(st.egoHeadingBefore, e.heading) / DT,
    footprint: fp,
    spawnGuard: footprint(e.pos, e.heading, e.lengthM + 2 * st.params.spawnEgoMarginM, e.widthM + 2 * st.params.spawnEgoMarginM),
  };
  const scriptedObs = obstaclesOf(input.scripted);

  st.egoHeadingBefore = e.heading;
  applyEvents(st, input, egoView);
  rebuildGrid(st.grid, st.active, st.activeCount, st.x, st.z);
  runSpawner(st, input.t, egoView, scriptedObs);

  /** @type {ActorPose[]} */
  const poses = new Array(st.activeCount);
  for (let i = 0; i < st.activeCount; i += 1) poses[i] = poseOf(st, st.active[i]);

  const perceived = sc.perceived;
  perceived.length = 0;
  perceived.push({
    footprint: fp,
    x: e.pos.x,
    z: e.pos.z,
    radius: Math.hypot(e.lengthM, e.widthM) / 2,
    vx: e.speed * Math.cos(e.heading),
    vz: -e.speed * Math.sin(e.heading),
  });
  for (const o of scriptedObs) perceived.push(o);
  for (const o of st.graph.staticObstacles) perceived.push(o);
  const parked = sc.parked;
  parked.length = 0;
  input.scripted.forEach((pose, i) => {
    if (pose.active) return;
    // A parked actor stays put, so the lanes under it are found once per place.
    const key = `${pose.id} ${pose.pos.x} ${pose.pos.z} ${pose.heading}`;
    let spans = sc.parkedSpans.get(key);
    if (!spans) {
      spans = lanesUnder(st.map, st.graph.edgeIndex, scriptedObs[i].footprint);
      sc.parkedSpans.set(key, spans);
    }
    for (const sp of spans) parked.push(sp);
  });
  // An ego standing still for longer than a red phase closes the lane under it, as a parked
  // vehicle does: traffic behind changes lane round it instead of queueing for ever.
  st.egoStillS = Math.abs(e.speed) < STOPPED_MPS && !input.egoReset ? st.egoStillS + DT : 0;
  if (st.egoStillS > EGO_PARKED_S) {
    // The ego only jitters while it stands, so the lanes under it are found again only once it has
    // shifted noticeably.
    const ep = sc.egoParked;
    if (ep.spans === null || Math.hypot(e.pos.x - ep.x, e.pos.z - ep.z) > EGO_PARKED_SHIFT_M || Math.abs(angleDiff(e.heading, ep.heading)) > EGO_PARKED_TURN_RAD) {
      ep.x = e.pos.x;
      ep.z = e.pos.z;
      ep.heading = e.heading;
      ep.spans = lanesUnder(st.map, st.graph.edgeIndex, fp);
    }
    for (const sp of ep.spans) parked.push(sp);
  }
  // The ego's signalling episodes, for agents that make way for it.
  const ind = e.indicators ?? 'off';
  if ((ind === 'left' || ind === 'right') && ind !== st.egoIndicator) st.egoSignalEpisode += 1;
  st.egoIndicator = ind;
  egoPartyOf(st, e, sc);

  // Lateral decisions.
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    if (tryMandatoryLaneChange(st, k, perceived, parked, input.t)) continue;
    // A distracted driver makes no lane or slot choice.
    if (!st.isMoto[k] && !distracted(st, k, input.t)) stepMobil(st, k, perceived, input.t, Math.hypot(st.x[k] - e.pos.x, st.z[k] - e.pos.z));
  }
  refreshListPositions(st, sc.listPos);
  const slotPeriod = Math.max(1, Math.round(TICK_HZ / st.params.motorbike.slotHz));
  const corridor = egoCorridorOf(e);
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    if (!st.isMoto[k] || st.wreck[k] || st.crossing[k] || input.t < st.makeRoomUntil[k] || distracted(st, k, input.t) || (st.tick + st.spawnIndex[k]) % slotPeriod !== 0) continue;
    const edge = st.graph.edges[st.edge[k]];
    if (edge.kind !== 'lane') continue;
    edgePoint(edge, Math.min(st.s[k], edge.length), LANE_POINT);
    chooseSlot(st, k, sc.listPos[k], LANE_POINT.heading, corridor, Math.hypot(st.x[k] - e.pos.x, st.z[k] - e.pos.z));
  }
  // A rider on a connector has no slot to choose, so one held by an ego that has stood in its way
  // for a while goes round it (a car keeps waiting).
  if (st.egoStillS >= GO_ROUND_AFTER_S) {
    for (let i = 0; i < st.activeCount; i += 1) {
      const k = st.active[i];
      if (!st.isMoto[k] || st.wreck[k] || st.crossing[k] || distracted(st, k, input.t) || (st.tick + st.spawnIndex[k]) % slotPeriod !== 0) continue;
      if (st.graph.edges[st.edge[k]].kind !== 'connector') continue;
      const reach = GO_ROUND_LOOK_M + st.lengthM[k] + perceived[0].radius;
      if (Math.hypot(st.x[k] - e.pos.x, st.z[k] - e.pos.z) > reach) continue;
      goRoundEgo(st, k, perceived[0], nearbyObstacles(st, k, perceived, reach + GO_ROUND_LOOK_M));
    }
  }

  /** @type {Obstacle[]} */
  const egoObs = [
    {
      footprint: fp,
      x: e.pos.x,
      z: e.pos.z,
      radius: Math.hypot(e.lengthM, e.widthM) / 2,
      vx: e.speed * Math.cos(e.heading),
      vz: -e.speed * Math.sin(e.heading),
    },
  ];
  const nReq = computePhase(st, input, egoObs, scriptedObs, sc);
  applyPhase(st, input, sc, nReq);
  const incidents = detectContacts(
    st,
    input.scripted,
    scriptedObs.map((o) => o.footprint),
    input.t,
  );
  for (let i = 0; i < st.activeCount; i += 1) latch(st, st.active[i], input.t);
  st.tick += 1;
  return { state: st, poses, incidents };
}

/**
 * Ego pose assumed while pre-rolling: a car at the map's start pose, standing still.
 * @param {GameMap} map Map.
 * @returns {EgoInput} Ego.
 */
function preRollEgo(map) {
  return { pos: { ...map.route.start.pos }, heading: map.route.start.heading, speed: 0, ...PREROLL_EGO_SIZE };
}

/**
 * Creates the traffic of a run and pre-rolls it for `params.preRollS` with the ego as a static
 * blocker at the map's start pose and the ring spawner reaching the ego, so the road is populated
 * at `t = 0`. Lights follow the map cycles at negative `t` (`signalState` wraps them). Wrecks left
 * by the pre-roll are removed, and the time its ego stood still is not handed over.
 * @param {GameMap} map Map with a `traffic` block.
 * @param {TrafficParams} params Compiled traffic parameters.
 * @param {number} runSeed Run seed, a 32-bit integer.
 * @returns {TrafficState} State at `t = 0`.
 */
export function createTraffic(map, params, runSeed) {
  const st = createTrafficState(map, params, runSeed);
  const steps = Math.round(params.preRollS / DT);
  st.spawner = createSpawner(st, -steps * DT);
  st.preRolling = true;
  const ego = preRollEgo(map);
  const scripted = map.actors.length > 0 ? stepActors(createActorState(map), map, [footprint(ego.pos, ego.heading, ego.lengthM, ego.widthM)], 0, DT).poses : [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i - steps) * DT;
    stepTraffic(st, { ego, egoReset: false, scripted, lights: trafficLightStates(map, t), egoContacts: [], t });
  }
  // The run opens on no crash the player did not see: wrecks still standing leave with their flags.
  for (let i = st.activeCount - 1; i >= 0; i -= 1) if (st.wreck[st.active[i]]) despawnAgent(st, st.active[i], 'wreck');
  st.preRolling = false;
  // The pre-roll ego stood all along; the player's ego has not stood yet.
  st.egoStillS = 0;
  st.egoHeadingBefore = Number.NaN;
  scratchOf(st).egoParked.spans = null;
  st.t = 0;
  return st;
}

/**
 * Footprints of every traffic agent now, in spawn order.
 * @param {TrafficState} st State.
 * @returns {Vec2[][]} Footprints.
 */
export function trafficFootprints(st) {
  /** @type {Vec2[][]} */
  const out = [];
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    out.push(footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]));
  }
  return out;
}

/**
 * World state of a run: scripted actors and, when enabled, traffic.
 * @typedef {object} WorldState
 * @property {GameMap} map Map.
 * @property {ActorState} actors Scripted actor state.
 * @property {TrafficState | null} traffic Traffic, or null when off or the map has none.
 */

/**
 * @typedef {object} WorldOptions
 * @property {'map' | 'off'} [traffic] `map` runs the map's traffic block; `off` (the default)
 *   runs scripted actors only.
 * @property {TrafficParams} [params] Compiled traffic parameters; required with `traffic: 'map'`
 *   on a map with a traffic block.
 * @property {number} [runSeed] Run seed, default 0.
 */

/**
 * Creates the world state of a run (traffic pre-rolled when on).
 * @param {GameMap} map Map.
 * @param {WorldOptions} [options] Options.
 * @returns {WorldState} State at `t = 0`.
 */
export function createWorld(map, options = {}) {
  const mode = options.traffic ?? 'off';
  if (mode !== 'map' && mode !== 'off') throw new RangeError(`Unknown traffic mode ${String(mode)}`);
  let traffic = null;
  if (mode === 'map' && map.traffic) {
    if (!options.params) throw new TypeError('createWorld needs traffic params with traffic: map');
    traffic = createTraffic(map, options.params, options.runSeed ?? 0);
  }
  return { map, actors: createActorState(map), traffic };
}

/**
 * @typedef {object} WorldStepInput
 * @property {EgoInput} ego Ego pre-step pose.
 * @property {boolean} egoReset The ego was placed back at a checkpoint this step.
 * @property {Record<string, LightState>} lights Light state of every map signal at `t`.
 * @property {readonly string[]} egoContacts Actor ids the ego touched in the previous step.
 * @property {number} t Run time of this step.
 */

/**
 * @typedef {object} WorldStep
 * @property {WorldState} worldState Next world state (the traffic state object is advanced in place).
 * @property {ActorPose[]} scriptedPoses Scripted poses at `t`, in map order.
 * @property {ActorPose[]} trafficPoses Traffic poses at `t`, ascending spawn index.
 * @property {TrafficIncident[]} incidents NPC–NPC incidents started this step.
 */

/**
 * One world step: scripted actors (held by the ego and by traffic agents), then traffic
 * (perceiving the ego and the scripted poses). Without traffic this is exactly
 * `stepActors(actors, map, [egoFootprint], |ego.speed|, DT)`.
 * @param {WorldState} worldState State.
 * @param {WorldStepInput} input Input.
 * @returns {WorldStep} Poses at `t` and the next state.
 */
export function stepWorld(worldState, input) {
  const { map } = worldState;
  const e = input.ego;
  const egoFp = footprint(e.pos, e.heading, e.lengthM, e.widthM);
  const traffic = worldState.traffic;
  const blockers = traffic && map.actors.length > 0 ? [egoFp, ...trafficFootprints(traffic)] : [egoFp];
  const actors = stepActors(worldState.actors, map, blockers, Math.abs(e.speed), DT);
  if (!traffic) {
    return { worldState: { map, actors: actors.state, traffic: null }, scriptedPoses: actors.poses, trafficPoses: [], incidents: [] };
  }
  const step = stepTraffic(traffic, { ...input, scripted: actors.poses });
  return { worldState: { map, actors: actors.state, traffic: step.state }, scriptedPoses: actors.poses, trafficPoses: step.poses, incidents: step.incidents };
}
