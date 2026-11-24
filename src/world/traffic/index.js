/**
 * Traffic: seeded NPC agents on the map's lane graph, stepped at the fixed `DT`. Pure and
 * deterministic: the same map, parameters, run seed and inputs give the same poses.
 *
 * Each `stepTraffic` call, at the input time `t`:
 * 1. applies the step's events: ego contacts make wrecks that stop dead, an ego reset
 *    clears agents around the ego, wrecks clear, agents despawn, sources and the ring spawner
 *    spawn;
 * 2. returns the poses at `t` (like `stepActors`, so the frame of tick k shows the poses after k
 *    steps of motion);
 * 3. computes every agent's acceleration and junction request from the state at `t` (IDM with the
 *    nearest of: the agent ahead on its route, the stop line or keep-clear hold point, and the ego
 *    or scripted actors in its corridor), then grants junction claims and integrates every agent,
 *    in ascending spawn index (two phases).
 *
 * `stepWorld` is the one composite step, scripted actors then traffic, shared by the sim and
 * the test frame builder.
 *
 * Scope: collision-free traffic that moves, stops, turns and leaves. Agents obey signals and never
 * raise violation flags, so every pose carries `NO_VIOLATIONS` and `incidents` stays empty; there
 * are no human factors, violations, lateral manoeuvres or NPC–NPC contacts yet.
 */

import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../../contracts/telemetry.js';
import { DT } from '../../contracts/units.js';
import { footprint, polygonsIntersect } from '../../geometry/index.js';
import { createActorState, stepActors } from '../actors.js';
import { trafficLightStates } from '../signals.js';
import { idmAcceleration, integrate } from './idm.js';
import { corridorObstacle } from './perception.js';
import { reachesBeforeRed, signalDecision, yellowRemaining } from './signals.js';
import { breaksDeadlock, checkConflicts, claimBlocking, exitRoom, laneLight, zoneClaimed } from './junctions.js';
import { STOPPED_MPS, createSpawner, inViewCone, runSpawner } from './spawner.js';
import { rebuildGrid } from './grid.js';
import {
  chooseNext,
  claimAdd,
  claimDrop,
  createTrafficState,
  despawnAgent,
  edgeInsert,
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

/**
 * An NPC–NPC incident (none are emitted yet).
 * @typedef {object} TrafficIncident
 * @property {number} t Time.
 * @property {string[]} agentIds Agents involved.
 * @property {string[]} causes Human-factor and violation causes.
 */

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
/** Agent ahead on a sibling connector counts as a leader until its rear is this far in, metres. */
export const SIBLING_DIVERGE_M = 8;
/** Leaders farther than this along the route are ignored, metres (design). */
export const LEADER_LOOK_M = 200;
/** Small clearance kept to an obstacle when the advance is clamped, metres. */
const CLAMP_MARGIN_M = 0.05;

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
      check: { claimed: false, yields: false, maxYieldWait: -1, minYieldIndex: Infinity },
      near: [],
    };
    SCRATCH.set(st, sc);
  }
  return sc;
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
  const v = wreck ? 0 : st.v[slot];
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
    violations: NO_VIOLATIONS,
  };
}

/**
 * Lamps of one agent: hazards on a wreck; brake lamps while braking or stopped; the indicator of
 * the next turn within `behaviour.indicatorLeadS` of the junction and through it.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {Readonly<import('../../contracts/telemetry.js').ActorLights>} Shared lamp entry.
 */
function lightsOf(st, slot) {
  if (st.wreck[slot]) return ACTOR_LIGHTS.hazard;
  const brake = st.acc[slot] < -st.params.behaviour.brakeLampMps2 || st.v[slot] < STOPPED_MPS;
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
 * Takes the first agent of an edge as the leader when it is nearer than the one in `out`.
 * @param {TrafficState} st State.
 * @param {number} edge Edge.
 * @param {number} offset Path distance from the asking agent's front to the edge start.
 * @param {number} maxRear Ignore an agent whose rear is farther along the edge than this.
 * @param {Float64Array} out `[gap, speed]`, updated.
 * @returns {void}
 */
function considerFirst(st, edge, offset, maxRear, out) {
  if (st.edgeCount[edge] === 0) return;
  const k = st.edgeAgents[edge][0];
  const rear = st.s[k] - st.lengthM[k] / 2;
  if (rear > maxRear) return;
  const gap = offset + rear;
  if (gap < out[0]) {
    out[0] = gap;
    out[1] = st.v[k];
  }
}

/**
 * The agent ahead on the slot's route: on its edge (and, on a connector, on its siblings until
 * they diverge), else first on the next edge (and on sibling connectors of a next connector, until
 * they diverge), else first on the exit lane of a next connector. Writes `[gap, speed]` into `out`; the gap is Infinity without one.
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
  const i = listPos[slot];
  if (i + 1 < st.edgeCount[e]) {
    const k = st.edgeAgents[e][i + 1];
    out[0] = st.s[k] - st.lengthM[k] / 2 - front;
    out[1] = st.v[k];
  }
  // Connectors leaving the same lane share their first metres: the nearest agent ahead on a
  // sibling counts until it has diverged.
  for (const sib of edges[e].siblings) {
    const list = st.edgeAgents[sib];
    for (let j = 0; j < st.edgeCount[sib]; j += 1) {
      const k = list[j];
      if (st.s[k] <= st.s[slot]) continue;
      const rear = st.s[k] - st.lengthM[k] / 2;
      if (rear <= SIBLING_DIVERGE_M && rear - front < out[0]) {
        out[0] = rear - front;
        out[1] = st.v[k];
      }
      break;
    }
  }
  if (out[0] < Infinity) return;
  const next = st.nextEdge[slot];
  if (next < 0) return;
  const rem = edges[e].length - front;
  considerFirst(st, next, rem, Infinity, out);
  const ne = edges[next];
  if (ne.kind === 'connector') {
    for (const sib of ne.siblings) considerFirst(st, sib, rem, SIBLING_DIVERGE_M, out);
    if (out[0] === Infinity) considerFirst(st, ne.toEdge, rem + ne.length, Infinity, out);
  }
  if (out[0] > LEADER_LOOK_M) {
    out[0] = Infinity;
    out[1] = 0;
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
    if (slot === undefined || st.wreck[slot]) continue;
    st.wreck[slot] = 1;
    st.wreckT[slot] = input.t;
    st.v[slot] = 0;
    st.acc[slot] = 0;
    // A wreck still on its approach lane never enters the junction: free its claim.
    const c = st.claim[slot];
    if (c >= 0 && st.edge[slot] === st.graph.edges[c].fromEdge) claimDrop(st, slot);
  }
  if (input.egoReset) {
    const e = input.ego;
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
    if (e.deadEnd && st.v[k] < STOPPED_MPS && e.length - (st.s[k] + st.lengthM[k] / 2) < st.minGap[k] + 1 && !inViewCone(ego, st.x[k], st.z[k], st.params)) {
      despawnAgent(st, k, 'dead-end');
    }
  }
}

/**
 * Computes every agent's accelerations and junction request from the state at `t`.
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
  const pair = sc.pair;
  const ego = input.ego;
  const egoMid = sc.egoMid;
  egoMid.x = ego.pos.x;
  egoMid.z = ego.pos.z;
  egoMid.lengthM = ego.lengthM;
  const check = sc.check;
  const near = sc.near;
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
    sc.commit[k] = st.signalCommit[k];
    if (st.wreck[k]) {
      sc.accGo[k] = 0;
      sc.advGo[k] = 0;
      continue;
    }
    const e = edges[st.edge[k]];
    const v = st.v[k];
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

    leaderAhead(st, k, sc.listPos, pair);
    let gapGo = pair[0];
    let accGo = accel(st, k, v0, pair[0], pair[1]);

    // Exact perception of the ego and scripted actors.
    near.length = 0;
    const edx = ego.pos.x - st.x[k];
    const edz = ego.pos.z - st.z[k];
    if (edx * edx + edz * edz <= st.params.egoPerceptionM * st.params.egoPerceptionM) near.push(egoObs[0]);
    for (const o of scriptedObs) near.push(o);
    if (near.length > 0) {
      const look = Math.max(8, Math.min(st.params.egoPerceptionM, (v * v) / (2 * b) + v * st.timeGap[k] + st.minGap[k] + 5));
      corridorObstacle(st, k, near, look, pair);
      if (pair[0] < Infinity) {
        gapGo = Math.min(gapGo, pair[0]);
        accGo = Math.min(accGo, accel(st, k, v0, pair[0], pair[1]));
      }
    }
    sc.accGo[k] = accGo;
    sc.advGo[k] = gapGo;

    // Hold point before the next connector, or the end of a dead-end lane.
    if (e.kind !== 'lane' || e.sink) continue;
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
    if (light !== null && front <= e.holdS + 0.01) {
      if (light === 'green') sc.commit[k] = 0;
      else if (light === 'red') sc.commit[k] = signalDecision('red', Math.max(0, e.holdS - front), v, 0, st.yellowStop[k], st.decelMax[k], yellowMargin) === 'go' ? 2 : 1;
      else {
        const left = yellowRemaining(st.map.signals[e.signalIndex], input.t);
        const d = Math.max(0, e.holdS - front);
        if (sc.commit[k] === 0) {
          sc.commit[k] = signalDecision('yellow', d, v, left, st.yellowStop[k], st.decelMax[k], yellowMargin) === 'go' ? 2 : 1;
        } else if (sc.commit[k] === 2 && !reachesBeforeRed(d, v, left, yellowMargin) && (v * v) / (2 * Math.max(d, 0.05)) <= st.decelMax[k]) {
          // Went for the yellow, but slowed (a queue, a yield): stop while it still can.
          sc.commit[k] = 1;
        }
      }
      signalGo = light === 'green' || sc.commit[k] === 2;
    }

    // Stopped by what lies ahead (the ego, a scripted actor, the agent in front) and able to move
    // no further: no claim, so a held-up agent never blocks the junction.
    const blockedAhead = v < STOPPED_MPS && accGo <= 0;
    if (st.claim[k] === next) {
      // Already claimed: give it back for a signal the agent can still stop for, or while it stands
      // blocked before the hold point.
      if (!signalGo || blockedAhead) {
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
    // A long vehicle may still cover a zone of the junction behind it; claim one at a time.
    if (st.claim[k] >= 0 || blockedAhead) continue;
    if (e.control === 'stop-sign' && !st.haltedAtLine[k]) continue;
    const egoNear = Math.abs(edx) + Math.abs(edz) < 200 ? egoMid : null;
    if (exitRoom(st, next, k, sc.reserved, egoNear) < st.lengthM[k] + st.minGap[k]) continue;
    checkConflicts(st, k, next, input.lights, check);
    if (check.claimed) continue;
    if (check.yields && !breaksDeadlock(st, k, check)) continue;
    sc.requests[nReq++] = k;
  }
  return nReq;
}

/**
 * Grants claim requests nearest the hold point first, each re-checked against claims granted
 * before it; then integrates every agent and moves it along its route.
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
    for (const cf of edges[conn].conflicts) {
      if (zoneClaimed(st, cf, k)) {
        ok = false;
        break;
      }
    }
    if (ok && exitRoom(st, conn, k, sc.reserved, egoMid) < st.lengthM[k] + st.minGap[k]) ok = false;
    if (!ok) continue;
    claimDrop(st, k);
    claimAdd(st, conn, k);
    sc.reserved[edges[conn].toEdge] += st.lengthM[k] + st.minGap[k];
    sc.holds[k] = 0;
    st.waitS[k] = 0;
  }

  const dt = DT;
  const pair = sc.pair;
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    st.signalCommit[k] = sc.commit[k];
    if (st.wreck[k]) continue;
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
    // Waiting and the stop-sign halt.
    if (sc.inZone[k] && hold && vNext < STOPPED_MPS) {
      st.waitS[k] += dt;
      if (sc.holdDist[k] < st.minGap[k] + 1.5) st.haltedAtLine[k] = 1;
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
      if (next < 0 || (e.kind === 'lane' && st.claim[k] !== next)) {
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
  for (let i = 0; i < st.activeCount; i += 1) updatePose(st, st.active[i]);
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
    footprint: fp,
    spawnGuard: footprint(e.pos, e.heading, e.lengthM + 2 * st.params.spawnEgoMarginM, e.widthM + 2 * st.params.spawnEgoMarginM),
  };
  const scriptedObs = obstaclesOf(input.scripted);

  applyEvents(st, input, egoView);
  rebuildGrid(st.grid, st.active, st.activeCount, st.x, st.z);
  runSpawner(st, input.t, egoView, scriptedObs);

  /** @type {ActorPose[]} */
  const poses = new Array(st.activeCount);
  for (let i = 0; i < st.activeCount; i += 1) poses[i] = poseOf(st, st.active[i]);

  refreshListPositions(st, sc.listPos);
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
  st.tick += 1;
  return { state: st, poses, incidents: [] };
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
 * at `t = 0`. Lights follow the map cycles at negative `t` (`signalState` wraps them).
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
  st.preRolling = false;
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
