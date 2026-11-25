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
 *   vehicle is involved, and take no part in gap acceptance. Straight connectors of one road into
 *   different exit lanes run side by side and have none.
 * - **Merges.** Two connectors from different lanes of one road into the same exit lane join it
 *   one behind the other: a merge is not exclusive and takes no part in gap acceptance or
 *   fairness. They go in order of distance to the start of the exit lane (ties to the lower spawn
 *   index): an agent may claim unless a claimant of the merging connector is abreast of it, that
 *   is, unless the one ahead lacks its length plus the follower's minimum gap clear, nor while
 *   the head of the merging approach, free to go, goes first by that order (of two heads abreast,
 *   the one that has waited longer goes first). From the claim on, the one behind follows the
 *   one ahead until both are on the exit lane.
 * - **Gap acceptance.** Against the leading unclaimed agent approaching a conflicting connector,
 *   an agent yields when that agent has priority and its true arrival time at the zone is earlier
 *   than the agent's own plus its critical gap.
 * - **Priority (design).** Unsignalled: a priority road first, then the agent coming from the
 *   right, then the turn rank (straight, right, left, U-turn). Signalised: the turn rank, then from
 *   the right. Remaining ties go to the earlier arrival, then the lower spawn index.
 * - **The ego is a party.** On a lane (within `behaviour.egoOnLaneM` of its centre, heading along
 *   it) and moving, the ego may take any connector out of that lane; an agent yields to it by the
 *   same priority and gap rule. The ego facing red, or standing, is not waited for.
 * - **No-yield.** The same computation tells whether a party with priority arrives inside the
 *   class critical gap (the unscaled one). An agent that goes anyway, with a personality gap below
 *   it or by the deadlock breaker, enters inside another party's critical gap.
 * - **Held agents are not waited for.** An agent standing at its hold point that cannot claim
 *   because its exit lane is full, or because what lies ahead blocks it, takes no part in gap
 *   acceptance until it can go. At a merge, a head waiting for exit room keeps its turn.
 * - **Deadlock breaker.** An agent that has waited longer than `behaviour.deadlockS`, and longer
 *   than every agent it yields to, stops yielding (claims are still respected). It never stops
 *   yielding to a moving ego.
 * - **Fairness.** An agent that can still stop well does not ask for a claim while the head
 *   of a crossing approach, free to go, has waited longer than `behaviour.deadlockS` and longer
 *   than it: claims taken one after another by a platoon cannot starve that head.
 * - **Keep-clear at a red exit.** While the light at the end of a short exit lane is not green,
 *   the exit room ends at its stop line, so a vehicle that does not fit before it waits before the
 *   junction instead of stopping in it.
 * - **Keep-clear behind a wreck.** A connector has no exit room while a wreck stands on it, or on
 *   a connector merging with it with its body in or past the merge zone: agents wait at the hold
 *   point until the wreck is cleared instead of stopping in the box behind it. One already holding
 *   the claim gives it back while it can still stop at the hold point.
 *
 * Claims are requested in the compute phase and granted in the apply phase, nearest the hold point
 * first, each grant re-checked against the claims granted before it, so two agents never take
 * conflicting claims in the same step.
 */

import { angleDiff, projectOntoPolyline } from '../../geometry/index.js';
import { TURN_RANK } from './lane-graph.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./lane-graph.js').Edge} Edge */

/** `TrafficState.held`: standing at the hold point because the exit lane has no room. */
export const HELD_EXIT = 1;
/** `TrafficState.held`: standing at the hold point, blocked by what lies ahead. */
export const HELD_BLOCKED = 2;

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
 * Distance from the slot's front to the start of the exit lane of connector `conn`, while the
 * slot is on that connector or on its approach lane; −Infinity anywhere else.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector edge.
 * @returns {number} Metres.
 */
export function toExit(st, slot, conn) {
  const edges = st.graph.edges;
  const c = edges[conn];
  const front = st.s[slot] + st.lengthM[slot] / 2;
  if (st.edge[slot] === conn) return c.length - front;
  if (st.edge[slot] === c.fromEdge) return edges[c.fromEdge].length - front + c.length;
  return -Infinity;
}

/**
 * Whether agent `k` goes ahead of `slot` into the shared exit lane of a merge: nearer its start,
 * ties to the lower spawn index.
 * @param {number} dSlot Distance of `slot` to the exit lane.
 * @param {number} dK Distance of `k` to the exit lane.
 * @param {number} slotIndex Spawn index of `slot`.
 * @param {number} kIndex Spawn index of `k`.
 * @returns {boolean} `k` goes first.
 */
export function mergesAhead(dSlot, dK, slotIndex, kIndex) {
  return dK < dSlot || (dK === dSlot && kIndex < slotIndex);
}

/**
 * Merge order for an agent not yet holding a claim: whether the foremost agent of the merging
 * approach that will take the merging connector, free to go (no claim yet, not a wreck, not
 * blocked ahead, its light letting it go), goes first. The one nearer the shared exit lane goes
 * first (ties to the lower spawn index), except that of two abreast the one that has waited
 * longer does. So a waiting head is never passed by a stream rolling up on the lane beside it,
 * also while it waits for room on the exit lane (the stream would take that room as it opens).
 * @param {TrafficState} st State.
 * @param {number} conn Connector the asking agent would take.
 * @param {import('./lane-graph.js').EdgeConflict} cf Merge conflict, seen from `conn`.
 * @param {number} self Slot asking.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Light states.
 * @returns {boolean} The other head goes first.
 */
export function mergeHeadFirst(st, conn, cf, self, lights) {
  const b = st.graph.edges[cf.other];
  const bLane = st.graph.edges[b.fromEdge];
  const y = headFor(st, bLane.index, b.index);
  if (y < 0 || y === self || st.claim[y] >= 0 || st.wreck[y] || st.held[y] === HELD_BLOCKED) return false;
  const light = laneLight(st, bLane, lights);
  if (light === 'red' || (light === 'yellow' && st.signalCommit[y] !== 2)) return false;
  const dSelf = toExit(st, self, conn);
  const dY = toExit(st, y, cf.other);
  const yAhead = mergesAhead(dSelf, dY, st.spawnIndex[self], st.spawnIndex[y]);
  const abreast = yAhead ? dSelf - dY - st.lengthM[y] < st.minGap[self] : dY - dSelf - st.lengthM[self] < st.minGap[y];
  if (!abreast) return yAhead;
  const wy = st.waitS[y];
  const ws = st.waitS[self];
  return wy > ws || (wy === ws && yAhead);
}

/**
 * Whether a claimant of the conflicting connector still occupies or will occupy the shared zone.
 * A swing zone counts only when the asking agent or the claimant is a long vehicle. At a merge a
 * claimant counts only while it is abreast of the asking agent: the one going first must have its
 * length plus the follower's minimum gap clear of the follower's front.
 * @param {TrafficState} st State.
 * @param {number} conn Connector the asking agent would take.
 * @param {import('./lane-graph.js').EdgeConflict} cf Conflict, seen from `conn`.
 * @param {number} self Slot asking, never counted.
 * @returns {boolean} Zone taken.
 */
export function zoneClaimed(st, conn, cf, self) {
  const list = st.claimants[cf.other];
  const longM = st.params.behaviour.longVehicleM;
  const selfLong = st.lengthM[self] > longM;
  const dSelf = cf.merge ? toExit(st, self, conn) : 0;
  for (let i = 0; i < st.claimCount[cf.other]; i += 1) {
    const k = list[i];
    if (k === self || (cf.swing && !selfLong && st.lengthM[k] <= longM)) continue;
    if (cf.merge) {
      const dK = toExit(st, k, cf.other);
      if (dK === -Infinity) continue;
      const clear = mergesAhead(dSelf, dK, st.spawnIndex[self], st.spawnIndex[k]) ? dSelf - dK - st.lengthM[k] >= st.minGap[self] : dK - dSelf - st.lengthM[self] >= st.minGap[k];
      if (!clear) return true;
      continue;
    }
    if (claimProgress(st, k, cf.other) <= cf.otherToS) return true;
  }
  return false;
}

/**
 * Whether a wreck stands where an agent taking connector `conn` would have to stop inside the
 * junction: on `conn` itself, or on a connector merging with it with its front in or past the
 * merge zone.
 * @param {TrafficState} st State.
 * @param {number} conn Connector edge.
 * @returns {boolean} A wreck in the way.
 */
export function wreckInWay(st, conn) {
  if (wreckFrom(st, conn, -Infinity)) return true;
  for (const cf of st.graph.edges[conn].conflicts) if (cf.merge && wreckFrom(st, cf.other, cf.otherFromS)) return true;
  return false;
}

/**
 * Whether a wreck on `edge` has its front at `fromS` or beyond.
 * @param {TrafficState} st State.
 * @param {number} edge Edge.
 * @param {number} fromS Distance along the edge.
 * @returns {boolean} Such a wreck.
 */
function wreckFrom(st, edge, fromS) {
  const list = st.edgeAgents[edge];
  for (let i = 0; i < st.edgeCount[edge]; i += 1) {
    const k = list[i];
    if (st.wreck[k] && st.s[k] + st.lengthM[k] / 2 >= fromS) return true;
  }
  return false;
}

/**
 * Room on the exit lane of a connector for one more agent: from the exit lane start to the rear of
 * its last agent (or the ego standing on it), and to its stop line while that light is not green,
 * less what agents already holding claims onto that lane will take. An empty lane with a green
 * light or none always admits one agent. None (−Infinity) while a wreck is in the way
 * (`wreckInWay`).
 * @param {TrafficState} st State.
 * @param {number} conn Connector edge.
 * @param {number} self Slot asking.
 * @param {Float64Array} reserved Length reserved per lane by claims of agents not yet on it.
 * @param {{x: number, z: number, lengthM: number} | null} ego Ego centre and length, or null.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Light states.
 * @returns {number} Room, metres.
 */
export function exitRoom(st, conn, self, reserved, ego, lights) {
  if (wreckInWay(st, conn)) return -Infinity;
  const exit = st.graph.edges[st.graph.edges[conn].toEdge];
  const n = st.edgeCount[exit.index];
  let room = Infinity;
  if (n > 0) {
    const k = st.edgeAgents[exit.index][0];
    room = st.s[k] - st.lengthM[k] / 2;
  }
  if (exit.signalIndex >= 0 && exit.next.length > 0 && laneLight(st, exit, lights) !== 'green') room = Math.min(room, exit.holdS);
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
 * The ego as a junction party this step.
 * @typedef {object} EgoParty
 * @property {number} lane Lane edge it drives on, or −1 (in a junction, off the road, reversing).
 * @property {number} toLaneEnd Distance from its front to the end of that lane.
 * @property {number} speed Forward speed, at least 0.
 */

/** Below this speed the ego is taken to wait, not to arrive, m/s. */
export const EGO_ARRIVING_MPS = 0.5;

/**
 * Outcome of the conflict check.
 * @typedef {object} ConflictCheck
 * @property {boolean} claimed A conflicting claim still covers a zone.
 * @property {boolean} yields Gap acceptance says wait.
 * @property {boolean} noYield A party with priority arrives inside the class critical gap, so going
 *   now enters inside another party's critical gap.
 * @property {boolean} egoYield The ego is among the parties the agent yields to.
 * @property {number} maxYieldWait Longest wait among the agents yielded to (Infinity for the ego).
 * @property {number} minYieldIndex Lowest spawn index among those with that wait.
 */

/**
 * Records one party with priority arriving `margin` seconds after the agent would.
 * @param {TrafficState} st State.
 * @param {number} slot Asking slot.
 * @param {number} margin Party arrival minus the agent's, seconds.
 * @param {number} wait Party's wait (Infinity for the ego).
 * @param {number} index Party's spawn index (−1 for the ego).
 * @param {ConflictCheck} out Output, updated.
 * @returns {void}
 */
function priorityParty(st, slot, margin, wait, index, out) {
  if (margin < st.classCriticalGap[slot]) out.noYield = true;
  if (margin >= st.criticalGap[slot]) return;
  out.yields = true;
  if (index < 0) out.egoYield = true;
  if (wait > out.maxYieldWait || (wait === out.maxYieldWait && index < out.minYieldIndex)) {
    out.maxYieldWait = wait;
    out.minYieldIndex = index;
  }
}

/**
 * Checks the conflicts of connector `conn` for the agent in `slot` (the distance to each zone adds
 * the rest of its lane): claims first, then gap acceptance against the leading unclaimed agent of
 * each conflicting approach and against the ego.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Light states.
 * @param {EgoParty} ego The ego.
 * @param {ConflictCheck} out Output, overwritten.
 * @returns {ConflictCheck} `out`.
 */
export function checkConflicts(st, slot, conn, lights, ego, out) {
  out.claimed = false;
  out.yields = false;
  out.noYield = false;
  out.egoYield = false;
  out.maxYieldWait = -1;
  out.minYieldIndex = Infinity;
  const edges = st.graph.edges;
  const a = edges[conn];
  const lane = edges[a.fromEdge];
  const toLaneEnd = lane.length - (st.s[slot] + st.lengthM[slot] / 2);
  for (const cf of a.conflicts) {
    if (zoneClaimed(st, conn, cf, slot) || (cf.merge && mergeHeadFirst(st, conn, cf, slot, lights))) {
      out.claimed = true;
      return out;
    }
  }
  const look = st.params.behaviour.gapLookM;
  const egoLight = ego.lane >= 0 ? laneLight(st, edges[ego.lane], lights) : null;
  const egoComes = ego.lane >= 0 && ego.lane !== a.fromEdge && ego.speed >= EGO_ARRIVING_MPS && egoLight !== 'red';
  for (const cf of a.conflicts) {
    if (cf.swing || cf.merge) continue;
    const b = edges[cf.other];
    const bLane = edges[b.fromEdge];
    if (egoComes && b.fromEdge === ego.lane) {
      const dE = ego.toLaneEnd + cf.otherFromS;
      if (dE >= 0 && dE <= look) {
        const tE = dE / ego.speed;
        const tX = arrivalTime(st, slot, toLaneEnd + cf.fromS);
        let p = priorityOf(st, a, b);
        if (p === 0) p = tE <= tX ? 1 : -1;
        if (p === 1) priorityParty(st, slot, tE - tX, Infinity, -1, out);
      }
    }
    const y = headFor(st, bLane.index, b.index);
    if (y < 0 || y === slot || st.claim[y] >= 0 || st.wreck[y] || st.held[y]) continue;
    const yToEnd = bLane.length - (st.s[y] + st.lengthM[y] / 2);
    const dY = yToEnd + cf.otherFromS;
    if (dY > look) continue;
    const light = laneLight(st, bLane, lights);
    if (light === 'red' || (light === 'yellow' && st.signalCommit[y] === 1)) continue;
    const tY = arrivalTime(st, y, dY);
    const tX = arrivalTime(st, slot, toLaneEnd + cf.fromS);
    let p = priorityOf(st, a, b);
    if (p === 0) p = tY < tX || (tY === tX && st.spawnIndex[y] < st.spawnIndex[slot]) ? 1 : -1;
    if (p === 1) priorityParty(st, slot, tY - tX, st.waitS[y], st.spawnIndex[y], out);
  }
  return out;
}

/** Agents looked at from the front of an approach lane for the one heading for a connector. */
const HEAD_SCAN = 6;

/**
 * The foremost agent of approach lane `lane` that will take connector `conn` (riders side by side
 * at the line may be bound elsewhere), or −1.
 * @param {TrafficState} st State.
 * @param {number} lane Approach lane.
 * @param {number} conn Connector.
 * @returns {number} Slot or −1.
 */
export function headFor(st, lane, conn) {
  const list = st.edgeAgents[lane];
  const n = st.edgeCount[lane];
  for (let i = n - 1; i >= Math.max(0, n - HEAD_SCAN); i -= 1) if (st.nextEdge[list[i]] === conn) return list[i];
  return -1;
}

/**
 * Whether the deadlock breaker lets a yielding agent go: it has waited longer than
 * `behaviour.deadlockS` and longer than every agent it yields to (ties: lower spawn index). It never
 * goes in front of an arriving ego.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {ConflictCheck} check Result of `checkConflicts`.
 * @returns {boolean} Go anyway.
 */
export function breaksDeadlock(st, slot, check) {
  if (check.egoYield) return false;
  const w = st.waitS[slot];
  if (w <= st.params.behaviour.deadlockS) return false;
  return w > check.maxYieldWait || (w === check.maxYieldWait && st.spawnIndex[slot] < check.minYieldIndex);
}

/**
 * Fairness at a busy conflict: whether the agent, still able to stop at its hold point (within half
 * its braking limit)
 * `dHold` ahead, leaves the next claim to the head of a conflicting approach that is free to go
 * and has waited longer than `behaviour.deadlockS` and longer than the agent (ties: lower spawn
 * index).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector it would claim.
 * @param {number} dHold Front distance to its hold point.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Light states.
 * @returns {boolean} Leave it to the waiter.
 */
export function defersToWaiter(st, slot, conn, dHold, lights) {
  const v = st.v[slot];
  if (v > 0.1 && (dHold <= 0 || (v * v) / (2 * dHold) > st.decelMax[slot] / 2)) return false;
  const edges = st.graph.edges;
  const mine = st.waitS[slot];
  for (const cf of edges[conn].conflicts) {
    if (cf.swing || cf.merge) continue;
    const b = edges[cf.other];
    const bLane = edges[b.fromEdge];
    const y = headFor(st, bLane.index, b.index);
    if (y < 0 || y === slot || st.claim[y] >= 0 || st.wreck[y] || st.held[y]) continue;
    const w = st.waitS[y];
    if (w <= st.params.behaviour.deadlockS || w < mine || (w === mine && st.spawnIndex[y] > st.spawnIndex[slot])) continue;
    const light = laneLight(st, bLane, lights);
    if (light === 'red' || (light === 'yellow' && st.signalCommit[y] !== 2)) continue;
    return true;
  }
  return false;
}

/**
 * Whether any conflict zone of `conn` is physically taken: a claimant already past its stop line
 * (on the connector or its exit lane) has not yet cleared the shared zone. A driver running a red
 * light looks only at this, not at claims of agents still approaching.
 * @param {TrafficState} st State.
 * @param {number} conn Connector.
 * @param {number} self Slot asking, never counted.
 * @returns {boolean} Taken.
 */
export function zonesOccupied(st, conn, self) {
  for (const cf of st.graph.edges[conn].conflicts) {
    const list = st.claimants[cf.other];
    for (let i = 0; i < st.claimCount[cf.other]; i += 1) {
      const k = list[i];
      if (k === self) continue;
      const p = claimProgress(st, k, cf.other);
      if (p > -Infinity && p <= cf.otherToS) return true;
    }
  }
  return false;
}
