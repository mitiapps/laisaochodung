/**
 * Junction entry: an agent enters a connector only while it holds a claim on it, and it claims only
 * when the signal lets it go, the exit lane has room (keep-clear) and every conflict zone of the
 * connector is free:
 *
 * - **Claims are exclusive per conflict.** No agent claims a connector while an agent holding a
 *   claim on a conflicting connector has not yet cleared the shared zone. This holds at signalised
 *   junctions too: opposed arms share green (left turns cross the opposing straight), and agents
 *   still in the box at a phase change are yielded to.
 * - **Swing zones.** Where the map lists no conflict but two connectors pass close, a long
 *   vehicle's body ends swing over the other path; those zones are exclusive only when a long
 *   vehicle is involved, and take no part in gap acceptance.
 * - **Gap acceptance.** Against the leading unclaimed agent approaching a conflicting connector,
 *   an agent yields when that agent has priority and its true arrival time at the zone is earlier
 *   than the agent's own plus its critical gap.
 * - **Priority (design).** Unsignalled: a priority road first, then the agent coming from the
 *   right, then the turn rank (straight, right, left, U-turn). Signalised: the turn rank, then from
 *   the right. Remaining ties go to the earlier arrival, then the lower spawn index.
 * - **Deadlock breaker.** An agent that has waited longer than `behaviour.deadlockS`, and longer
 *   than every agent it yields to, stops yielding (claims are still respected).
 *
 * Claims are requested in the compute phase and granted in the apply phase, nearest the hold point
 * first, each grant re-checked against the claims granted before it, so two agents never take
 * conflicting claims in the same step.
 */

import { angleDiff, projectOntoPolyline } from '../../geometry/index.js';
import { TURN_RANK } from './lane-graph.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./lane-graph.js').Edge} Edge */

/** Below this share of its acceleration an agent is taken to cruise, for arrival estimates. */
const CRUISE_ACCEL_SHARE = 0.05;

/**
 * True time for an agent to cover `d` from its speed now, accelerating as IDM would on a free
 * road (`a · (1 − (v/v0)^δ)`, held constant) or cruising when that is negligible.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} d Distance, metres.
 * @returns {number} Seconds.
 */
export function arrivalTime(st, slot, d) {
  if (d <= 0) return 0;
  const v = st.v[slot];
  const v0 = Math.max(st.baseV0[slot] * st.v0Factor[slot], 0.5);
  const a = st.accelMax[slot] * Math.max(0, 1 - Math.pow(Math.min(1, v / v0), st.delta[slot]));
  if (a < CRUISE_ACCEL_SHARE * st.accelMax[slot]) return v > 0 ? d / v : Infinity;
  return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
}

/**
 * How far the slot's rear has progressed along a claimed connector, or −Infinity while still on
 * the approach lane.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector edge.
 * @returns {number} Rear progress, metres.
 */
export function claimProgress(st, slot, conn) {
  const e = st.edge[slot];
  const rear = st.s[slot] - st.lengthM[slot] / 2;
  if (e === conn) return rear;
  const c = st.graph.edges[conn];
  if (e === c.toEdge) return c.length + rear;
  return -Infinity;
}

/**
 * Whether a claim still covers some conflict zone (its holder has not cleared the last one).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector edge.
 * @returns {boolean} Still blocking.
 */
export function claimBlocking(st, slot, conn) {
  return claimProgress(st, slot, conn) <= st.graph.edges[conn].clearS;
}

/**
 * Whether a claimant of the conflicting connector still occupies or will occupy the shared zone.
 * A swing zone counts only when the asking agent or the claimant is a long vehicle.
 * @param {TrafficState} st State.
 * @param {import('./lane-graph.js').EdgeConflict} cf Conflict, seen from the asking agent's connector.
 * @param {number} self Slot asking, never counted.
 * @returns {boolean} Zone taken.
 */
export function zoneClaimed(st, cf, self) {
  const list = st.claimants[cf.other];
  const longM = st.params.behaviour.longVehicleM;
  const selfLong = st.lengthM[self] > longM;
  for (let i = 0; i < st.claimCount[cf.other]; i += 1) {
    const k = list[i];
    if (k === self || (cf.swing && !selfLong && st.lengthM[k] <= longM)) continue;
    if (claimProgress(st, k, cf.other) <= cf.otherToS) return true;
  }
  return false;
}

/**
 * Room on the exit lane of a connector for one more agent: from the exit lane start to the rear of
 * its last agent (or the ego standing on it), less what agents already holding claims onto that
 * lane will take. An empty lane always admits one agent.
 * @param {TrafficState} st State.
 * @param {number} conn Connector edge.
 * @param {number} self Slot asking.
 * @param {Float64Array} reserved Length reserved per lane by claims of agents not yet on it.
 * @param {{x: number, z: number, lengthM: number} | null} ego Ego centre and length, or null.
 * @returns {number} Room, metres.
 */
export function exitRoom(st, conn, self, reserved, ego) {
  const exit = st.graph.edges[st.graph.edges[conn].toEdge];
  const n = st.edgeCount[exit.index];
  let room = Infinity;
  if (n > 0) {
    const k = st.edgeAgents[exit.index][0];
    room = st.s[k] - st.lengthM[k] / 2;
  }
  if (ego) {
    const pr = projectOntoPolyline([ego.x, ego.z], exit.points);
    if (pr.distance < st.params.behaviour.egoOnLaneM && pr.s < exit.length) room = Math.min(room, pr.s - ego.lengthM / 2);
  }
  const mine = st.claim[self] >= 0 && st.graph.edges[st.claim[self]].toEdge === exit.index ? st.lengthM[self] + st.minGap[self] : 0;
  return room - (reserved[exit.index] - mine);
}

/**
 * Whether the agent on connector `b` (approaching from the lane of `b`) has priority over the
 * agent on connector `a`. Antisymmetric for distinct connectors except where the from-the-right
 * rule cycles (a four-way standoff), which the deadlock breaker resolves.
 * @param {TrafficState} st State.
 * @param {Edge} a Asking agent's connector.
 * @param {Edge} b Other agent's connector.
 * @returns {-1 | 0 | 1} 1: `b` has priority; −1: `a` has; 0: undecided by the rules.
 */
export function priorityOf(st, a, b) {
  const junction = a.junctionIndex >= 0 ? st.map.junctions[a.junctionIndex] : null;
  const rankA = TURN_RANK[/** @type {keyof typeof TURN_RANK} */ (a.turn)];
  const rankB = TURN_RANK[/** @type {keyof typeof TURN_RANK} */ (b.turn)];
  const d = angleDiff(a.startHeading, b.startHeading);
  // `b` travels towards a's left, so it comes from a's right (and the reverse).
  const bFromRight = d > Math.PI / 4 && d < (3 * Math.PI) / 4;
  const aFromRight = d < -Math.PI / 4 && d > (-3 * Math.PI) / 4;
  const byRight = bFromRight ? 1 : aFromRight ? -1 : 0;
  const byRank = rankB < rankA ? 1 : rankA < rankB ? -1 : 0;
  if (junction && !junction.signalized) {
    const roads = junction.priorityRoadIds;
    const pa = roads.includes(st.graph.roadIds[a.roadIndex]);
    const pb = roads.includes(st.graph.roadIds[b.roadIndex]);
    if (pa !== pb) return pb ? 1 : -1;
    return byRight !== 0 ? byRight : byRank;
  }
  return byRank !== 0 ? byRank : byRight;
}

/**
 * Light state the approach lane of a connector faces, or null without a signal.
 * @param {TrafficState} st State.
 * @param {Edge} lane Approach lane.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Light states.
 * @returns {import('../../contracts/telemetry.js').LightState | null} State.
 */
export function laneLight(st, lane, lights) {
  if (lane.signalIndex < 0) return null;
  const state = lights[st.map.signals[lane.signalIndex].id];
  if (state === undefined) throw new Error(`No light state for signal ${st.map.signals[lane.signalIndex].id}`);
  return state;
}

/**
 * Outcome of the conflict check.
 * @typedef {object} ConflictCheck
 * @property {boolean} claimed A conflicting claim still covers a zone.
 * @property {boolean} yields Gap acceptance says wait.
 * @property {number} maxYieldWait Longest wait among the agents yielded to.
 * @property {number} minYieldIndex Lowest spawn index among those with that wait.
 */

/**
 * Checks the conflicts of connector `conn` for the agent in `slot`, approaching it with its front
 * `dHold` before the hold point (the distance to each zone adds the rest of the lane).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Light states.
 * @param {ConflictCheck} out Output, overwritten.
 * @returns {ConflictCheck} `out`.
 */
export function checkConflicts(st, slot, conn, lights, out) {
  out.claimed = false;
  out.yields = false;
  out.maxYieldWait = -1;
  out.minYieldIndex = Infinity;
  const edges = st.graph.edges;
  const a = edges[conn];
  const lane = edges[a.fromEdge];
  const toLaneEnd = lane.length - (st.s[slot] + st.lengthM[slot] / 2);
  for (const cf of a.conflicts) {
    if (zoneClaimed(st, cf, slot)) {
      out.claimed = true;
      return out;
    }
  }
  for (const cf of a.conflicts) {
    if (cf.swing) continue;
    const b = edges[cf.other];
    const bLane = edges[b.fromEdge];
    const n = st.edgeCount[bLane.index];
    if (n === 0) continue;
    const y = st.edgeAgents[bLane.index][n - 1];
    if (y === slot || st.nextEdge[y] !== b.index || st.claim[y] >= 0 || st.wreck[y]) continue;
    const yToEnd = bLane.length - (st.s[y] + st.lengthM[y] / 2);
    const dY = yToEnd + cf.otherFromS;
    if (dY > st.params.behaviour.gapLookM) continue;
    const light = laneLight(st, bLane, lights);
    if (light === 'red' || (light === 'yellow' && st.signalCommit[y] === 1)) continue;
    const tY = arrivalTime(st, y, dY);
    const tX = arrivalTime(st, slot, toLaneEnd + cf.fromS);
    let p = priorityOf(st, a, b);
    if (p === 0) p = tY < tX || (tY === tX && st.spawnIndex[y] < st.spawnIndex[slot]) ? 1 : -1;
    if (p === 1 && tY < tX + st.criticalGap[slot]) {
      out.yields = true;
      const w = st.waitS[y];
      if (w > out.maxYieldWait || (w === out.maxYieldWait && st.spawnIndex[y] < out.minYieldIndex)) {
        out.maxYieldWait = w;
        out.minYieldIndex = st.spawnIndex[y];
      }
    }
  }
  return out;
}

/**
 * Whether the deadlock breaker lets a yielding agent go: it has waited longer than
 * `behaviour.deadlockS` and longer than every agent it yields to (ties: lower spawn index).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {ConflictCheck} check Result of `checkConflicts`.
 * @returns {boolean} Go anyway.
 */
export function breaksDeadlock(st, slot, check) {
  const w = st.waitS[slot];
  if (w <= st.params.behaviour.deadlockS) return false;
  return w > check.maxYieldWait || (w === check.maxYieldWait && st.spawnIndex[slot] < check.minYieldIndex);
}
