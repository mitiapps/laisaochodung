/**
 * Mandatory lane changes: an agent leaves its lane when the lane ahead is closed, by a static map
 * obstacle on it (road works), by a scripted actor parked in its path (not yet started, or at the
 * end of its path) or by its end where it is neither a sink nor followed by a connector or a join
 * (a taper, where a widening ends). It moves into an adjacent lane of the same road and
 * direction once the gap there is safe:
 *
 * - the agent fits between the target lane's leader and follower with at least their minimum gaps;
 * - neither the agent behind the leader nor the follower behind the agent (taken as standing, since
 *   what closes its lane may still stop it) has to brake harder than a safe deceleration, which rises from the comfortable one towards half the braking limit as the
 *   closed stretch comes nearer (a driver stopped at the taper end squeezes in);
 * - no ego, scripted actor or static obstacle stands in the stretch the agent moves into, which
 *   reaches further back by `MERGE_HEADWAY_S` of the speed of whatever comes up behind.
 *
 * Before the switch the agent signals towards the target lane for `behaviour.indicatorLeadS`,
 * unless it drew no signal for this change (its personality's `noSignal` rate).
 *
 * The change itself is a switch of edge at the same world position: the agent joins the target
 * lane's list at its projected distance, with the lateral offset that keeps its pose, and then
 * moves across to its usual offset at a speed that grows with its forward speed. Until it has
 * settled it treats the end of its lane as a hold point and requests no junction claim, and other
 * agents perceive its footprint exactly, so the lane it left stays blocked behind it.
 *
 * `mobil.js` uses the same gap test, box test, signalling and switch for discretionary changes.
 */

import { footprint, polygonsIntersect, projectOntoPolyline } from '../../geometry/index.js';
import { idmAcceleration } from './idm.js';
import { edgePoint } from './lane-graph.js';
import { chooseNext, edgeInsert, edgeRemove, refreshBaseSpeed } from './state.js';
import { draw } from './violations.js';
import { pathBlocked } from './moto-slots.js';
import { PERSONALITIES } from '../../contracts/traffic.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./perception.js').Obstacle} Obstacle */

/** A closed stretch nearer than this ahead of the front makes the agent look for a gap, metres (design). */
export const MERGE_LOOK_M = 60;
/** Lateral speed of a lane change at a standstill, m/s (design: a crawl out of the lane). */
export const LANE_CHANGE_MIN_MPS = 0.5;
/** Lateral speed added per m/s of forward speed (design). */
export const LANE_CHANGE_PER_MPS = 0.15;
/** Fastest lateral speed of a lane change, m/s (design: 3.5 m in about 3 s). */
export const LANE_CHANGE_MAX_MPS = 1.2;
/** An agent this close to its usual lateral offset has settled in its lane, metres. */
export const SETTLED_M = 0.3;
/** Clear road the agent needs around its body in the target lane, against perceived obstacles, metres (design). */
export const MERGE_CLEAR_M = 3;
/**
 * Extra clear road behind the agent per m/s of a perceived obstacle coming up behind it along the
 * target lane, seconds (design: the ego or a scripted car keeps two seconds to brake for it).
 */
export const MERGE_HEADWAY_S = 2;

/** Intent kinds: a change out of a closed lane, and a discretionary (MOBIL) change. */
export const INTENT_MANDATORY = 1;
export const INTENT_CHOSEN = 2;

/** @type {{x: number, z: number, heading: number}} */
const P = { x: 0, z: 0, heading: 0 };


/**
 * Whether the agent is still moving across after a lane change.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {boolean} Not settled.
 */
export function changingLane(st, slot) {
  return st.crossing[slot] === 1;
}

/**
 * Distance from the agent's front to where its lane is closed ahead: the start of the first static
 * block or parked actor its rear has not passed, else the end of a dead-end lane. Infinity on
 * connectors and on open lanes.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {readonly import('./lane-graph.js').LaneSpan[]} [parked] Lane stretches parked scripted
 *   actors cover.
 * @returns {number} Metres, at least 0.
 */
export function closedAheadM(st, slot, parked = []) {
  const e = st.graph.edges[st.edge[slot]];
  if (e.kind !== 'lane') return Infinity;
  const half = st.lengthM[slot] / 2;
  const rear = st.s[slot] - half;
  const front = st.s[slot] + half;
  let closed = e.deadEnd ? Math.max(0, e.length - front) : Infinity;
  for (const b of e.blocks) {
    if (b.toS > rear) {
      closed = Math.min(closed, Math.max(0, b.fromS - front));
      break;
    }
  }
  for (const p of parked) if (p.edge === e.index && p.toS > rear) closed = Math.min(closed, Math.max(0, p.fromS - front));
  return closed;
}

/**
 * IDM acceleration of `slot` behind a leader, unclamped below (the safety test needs the demand).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} gap Gap to the leader.
 * @param {number} vLead Leader speed.
 * @returns {number} Acceleration.
 */
function demand(st, slot, gap, vLead) {
  const v = st.v[slot];
  if (gap <= 0) return -Infinity;
  const v0 = Math.max(st.baseV0[slot] * st.v0Factor[slot], 0.5);
  return idmAcceleration(v, v0, gap, v - vLead, st.accelMax[slot], st.decelComfort[slot], st.timeGap[slot], st.minGap[slot], st.delta[slot]);
}

/**
 * Whether a target lane is open around `s` for a body of half length `half`: no static block
 * between its rear and `MERGE_LOOK_M` past its front, and, for a dead-end lane, an end farther
 * than the agent's own closed stretch.
 * @param {import('./lane-graph.js').Edge} t Target lane.
 * @param {number} s Centre distance along it.
 * @param {number} half Half length.
 * @param {number} closedM The agent's own distance to its closed stretch.
 * @returns {boolean} Open.
 */
function laneOpen(t, s, half, closedM) {
  for (const b of t.blocks) if (b.toS > s - half - MERGE_CLEAR_M && b.fromS < s + half + MERGE_LOOK_M) return false;
  return !t.deadEnd || t.length - (s + half) > closedM + MERGE_CLEAR_M;
}

/**
 * Leader and follower of a body centred at `sT` on lane `ti` (the follower may still be on a lane
 * before it), with their bumper gaps.
 * @param {TrafficState} st State.
 * @param {number} slot Slot moving in (never counted).
 * @param {number} ti Target lane.
 * @param {number} sT Centre distance along it.
 * @param {number} half Half length of the body.
 * @returns {{leader: number, leaderGap: number, follower: number, followerGap: number}} Parties, −1 when none.
 */
export function neighboursAt(st, slot, ti, sT, half) {
  const edges = st.graph.edges;
  const list = st.edgeAgents[ti];
  const n = st.edgeCount[ti];
  let leader = -1;
  let follower = -1;
  for (let i = 0; i < n; i += 1) {
    const k = list[i];
    if (k === slot) continue;
    if (st.s[k] >= sT) {
      leader = k;
      break;
    }
    follower = k;
  }
  let followerGap = Infinity;
  if (follower >= 0) followerGap = sT - half - (st.s[follower] + st.lengthM[follower] / 2);
  else {
    for (const pi of edges[ti].prev) {
      const m = st.edgeCount[pi];
      if (m === 0) continue;
      const k = st.edgeAgents[pi][m - 1];
      const gap = edges[pi].length - (st.s[k] + st.lengthM[k] / 2) + sT - half;
      if (gap < followerGap) {
        follower = k;
        followerGap = gap;
      }
    }
  }
  const leaderGap = leader >= 0 ? st.s[leader] - st.lengthM[leader] / 2 - (sT + half) : Infinity;
  return { leader, leaderGap, follower, followerGap };
}

/**
 * IDM demand of `slot` behind a leader at `gap` moving at `vLead` (exported for MOBIL).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} gap Gap.
 * @param {number} vLead Leader speed.
 * @returns {number} Acceleration (−Infinity when the gap is gone).
 */
export function demandBehind(st, slot, gap, vLead) {
  return gap === Infinity ? demand(st, slot, Infinity, 0) : demand(st, slot, gap, vLead);
}

/**
 * Whether no ego, scripted actor or static obstacle stands in the stretch of lane `t` the agent
 * would move into at `sT`; the stretch reaches back by `MERGE_HEADWAY_S` of the speed of anything
 * coming up behind.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {import('./lane-graph.js').Edge} t Target lane.
 * @param {number} sT Centre distance along it.
 * @param {readonly Obstacle[]} perceived Ego, scripted actors and static obstacles.
 * @returns {boolean} Clear.
 */
export function stretchClear(st, slot, t, sT, perceived) {
  edgePoint(t, sT, P);
  const lx = -Math.sin(P.heading);
  const lz = -Math.cos(P.heading);
  const base = st.lateralBase[slot];
  const cx = P.x + lx * base;
  const cz = P.z + lz * base;
  const hx = Math.cos(P.heading);
  const hz = -Math.sin(P.heading);
  const length = st.lengthM[slot] + 2 * MERGE_CLEAR_M;
  const box = footprint({ x: cx, z: cz }, P.heading, length, st.widthM[slot]);
  for (const o of perceived) {
    const along = o.vx * hx + o.vz * hz;
    let b = box;
    if (along > 0 && (o.x - cx) * hx + (o.z - cz) * hz < 0) {
      // Coming up behind: the stretch reaches back by its headway.
      const extra = along * MERGE_HEADWAY_S;
      b = footprint({ x: cx - (hx * extra) / 2, z: cz - (hz * extra) / 2 }, P.heading, length + extra, st.widthM[slot]);
    }
    if (polygonsIntersect(b, o.footprint)) return false;
  }
  return true;
}

/**
 * Where the agent would land on lane `ti` (its projected centre and lateral offset), or null when
 * its body does not fit along that lane or would land past the stop line of a lane ending at a
 * junction (it could hold no claim there).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ti Target lane.
 * @returns {{s: number, lateral: number} | null} Landing.
 */
export function landing(st, slot, ti) {
  const edges = st.graph.edges;
  const t = edges[ti];
  const half = st.lengthM[slot] / 2;
  const pr = projectOntoPolyline([st.x[slot], st.z[slot]], t.points);
  if (pr.s - half < 0 || pr.s + half > t.length) return null;
  if (t.next.length > 0 && edges[t.next[0]].kind === 'connector' && pr.s + half > t.holdS) return null;
  return { s: pr.s, lateral: pr.lateral };
}

/**
 * Side of lane `ti` seen from the agent: 1 when it lies to the agent's left, −1 to its right.
 * @param {number} lateral The agent's lateral offset from that lane's centre (left positive).
 * @returns {-1 | 1} Side.
 */
export function sideOf(lateral) {
  return lateral < 0 ? 1 : -1;
}

/**
 * Signalling before a change: starts the indicator towards `ti` (and draws whether the agent gives
 * no signal this time), or tells whether the lead time has passed.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ti Target lane.
 * @param {-1 | 1} side Side of the target lane.
 * @param {number} t Time.
 * @param {number} kind `INTENT_MANDATORY` or `INTENT_CHOSEN`.
 * @returns {boolean} The agent may switch now.
 */
export function signalled(st, slot, ti, side, t, kind) {
  if (st.intentLane[slot] !== ti) {
    st.intentKind[slot] = kind;
    st.intent[slot] = side;
    st.intentLane[slot] = ti;
    st.intentT[slot] = t;
    const rate = st.params.personalities[PERSONALITIES[st.personality[slot]]].violations.noSignal;
    st.intentQuiet[slot] = draw(st, slot, rate) ? 1 : 0;
  }
  return st.intentQuiet[slot] === 1 || t - st.intentT[slot] >= st.params.behaviour.indicatorLeadS - 1e-9;
}

/**
 * Drops a signalled change that is no longer wanted.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function dropIntent(st, slot) {
  st.intentKind[slot] = 0;
  st.intent[slot] = 0;
  st.intentLane[slot] = -1;
  st.intentQuiet[slot] = 0;
  st.intentCutIn[slot] = 0;
}

/**
 * Switches the agent to lane `ti` at the same world position; it then moves across.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ti Target lane.
 * @param {{s: number, lateral: number}} at Landing from `landing`.
 * @param {boolean} unsafe The change skipped its safety check.
 * @returns {void}
 */
export function switchLane(st, slot, ti, at, unsafe) {
  edgeRemove(st, st.edge[slot], slot);
  st.edge[slot] = ti;
  st.s[slot] = at.s;
  st.lateral[slot] = at.lateral;
  edgeInsert(st, ti, slot);
  st.crossing[slot] = 1;
  st.unsafeChange[slot] = unsafe ? 1 : 0;
  st.signalCommit[slot] = 0;
  st.haltedAtLine[slot] = 0;
  st.waitS[slot] = 0;
  st.approachDraws[slot] = 0;
  refreshBaseSpeed(st, slot);
  chooseNext(st, slot);
}

/**
 * Whether the way across to lane `ti` is free within the agent's own lane: no agent stands
 * alongside between it and the lane line on that side. A change that starts with someone in the
 * way can only stop half across, holding both.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ti Target lane.
 * @returns {boolean} Free.
 */
export function wayAcrossClear(st, slot, ti) {
  const e = st.edge[slot];
  const side = st.laneIndexOf[ti] > st.laneIndexOf[e] ? 1 : -1;
  return !pathBlocked(st, slot, side * st.halfWidth[e]);
}

/**
 * Tries the mandatory lane change of one agent. Call it before list positions are taken for the
 * step; it keeps every edge list sorted.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {readonly Obstacle[]} perceived Ego, scripted actors and static obstacles.
 * @param {readonly import('./lane-graph.js').LaneSpan[]} parked Lane stretches covered by scripted
 *   actors that are not moving along their path.
 * @param {number} t Time of the step.
 * @returns {boolean} The agent changed lane.
 */
export function tryMandatoryLaneChange(st, slot, perceived, parked, t) {
  if (st.wreck[slot] || st.claim[slot] >= 0 || changingLane(st, slot)) return false;
  const edges = st.graph.edges;
  const e = edges[st.edge[slot]];
  if (e.kind !== 'lane' || e.neighbours.length === 0) return false;
  const closedM = closedAheadM(st, slot, parked);
  if (!(closedM < MERGE_LOOK_M)) {
    if (st.intentKind[slot] === INTENT_MANDATORY) dropIntent(st, slot);
    return false;
  }
  const half = st.lengthM[slot] / 2;
  const urgency = 1 - closedM / MERGE_LOOK_M;

  // Once signalling towards a lane, the agent waits for a gap there.
  const intended = st.intentKind[slot] === INTENT_MANDATORY && e.neighbours.includes(st.intentLane[slot]);
  for (const ti of intended ? [st.intentLane[slot]] : e.neighbours) {
    const t2 = edges[ti];
    const at = landing(st, slot, ti);
    if (!at || !laneOpen(t2, at.s, half, closedM)) continue;
    const side = sideOf(at.lateral);
    // Signal first; the gap is judged once the lead time has passed.
    if (!signalled(st, slot, ti, side, t, INTENT_MANDATORY)) return false;
    const nb = neighboursAt(st, slot, ti, at.s, half);
    if (nb.leader >= 0) {
      const safe = st.decelComfort[slot] + urgency * Math.max(0, st.decelMax[slot] / 2 - st.decelComfort[slot]);
      if (nb.leaderGap < st.minGap[slot] || demand(st, slot, nb.leaderGap, st.v[nb.leader]) < -safe) return false;
    }
    if (nb.follower >= 0 && nb.followerGap < Infinity) {
      const f = nb.follower;
      const safe = st.decelComfort[f] + urgency * Math.max(0, st.decelMax[f] / 2 - st.decelComfort[f]);
      // Judged against a standing agent: until it is across, whatever closes its old lane may stop it.
      if (nb.followerGap < st.minGap[f] || demand(st, f, nb.followerGap, 0) < -safe) return false;
    }
    if (!stretchClear(st, slot, t2, at.s, perceived) || !wayAcrossClear(st, slot, ti)) return false;
    switchLane(st, slot, ti, at, false);
    return true;
  }
  return false;
}

/**
 * Moves an agent across towards its usual lateral offset for one step and records the lateral
 * speed (0 once settled).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} dt Step, seconds.
 * @returns {void}
 */
export function moveAcross(st, slot, dt) {
  const d = st.lateralBase[slot] - st.lateral[slot];
  if (st.crossing[slot] && Math.abs(d) <= SETTLED_M) {
    st.crossing[slot] = 0;
    st.unsafeChange[slot] = 0;
    dropIntent(st, slot);
  }
  if (d === 0) {
    st.latRate[slot] = 0;
    return;
  }
  const rate = Math.min(LANE_CHANGE_MAX_MPS, LANE_CHANGE_MIN_MPS + LANE_CHANGE_PER_MPS * st.v[slot]);
  const step = Math.sign(d) * Math.min(Math.abs(d), rate * dt);
  st.lateral[slot] += step;
  st.latRate[slot] = step / dt;
}
