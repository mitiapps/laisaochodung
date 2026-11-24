/**
 * Discretionary lane changes of cars, taxis, trucks and buses by MOBIL (Kesting, Treiber and
 * Helbing 2007), decided `behaviour.mobilHz` times a second, staggered by spawn index:
 *
 * - **Incentive:** `ã_c − a_c + p · (ã_n − a_n + ã_o − a_o) > Δa_th`, with the agent `c`, its new
 *   follower `n` and its old follower `o`, `p` the personality's politeness and `Δa_th` its
 *   threshold; accelerations by IDM against the true gaps (the agent sees the next lane).
 * - **Safety:** neither the new follower nor the agent behind its new leader would brake harder
 *   than the personality's `b_safe`, and the agent keeps at least its jam distance to both; nothing perceived exactly stands
 *   in the stretch it moves into. A reckless agent may skip the whole check (its `cutIn` rate per
 *   decision), which sets `unsafe-lane-change` while it moves across.
 *
 * The agent then signals for `behaviour.indicatorLeadS` (unless it drew no signal), checks again,
 * and switches. A change is not started in the last `MOBIL_END_M` of a lane ending at a junction,
 * nor while the agent holds a claim, nor into a lane that closes ahead. A stopped wreck ahead gives a large incentive, so cars leave
 * its lane.
 */

import { PERSONALITIES } from '../../contracts/traffic.js';
import { TICK_HZ } from '../../contracts/units.js';
import {
  INTENT_CHOSEN,
  MERGE_LOOK_M,
  demandBehind,
  dropIntent,
  landing,
  neighboursAt,
  sideOf,
  signalled,
  stretchClear,
  switchLane,
  wayAcrossClear,
} from './lane-change.js';
import { draw, rateOf } from './violations.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./perception.js').Obstacle} Obstacle */

/** No discretionary change starts this close to the hold point of a lane ending at a junction, metres (design). */
export const MOBIL_END_M = 25;
/** A signalled change not made within this long is dropped, seconds (design). */
export const MOBIL_GIVE_UP_S = 8;

/**
 * Acceleration of `slot` behind the agent ahead of it on its own lane (true gap), or free.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {number} Acceleration.
 */
function accelNow(st, slot) {
  const e = st.edge[slot];
  const list = st.edgeAgents[e];
  const n = st.edgeCount[e];
  let i = 0;
  while (i < n && list[i] !== slot) i += 1;
  if (i + 1 >= n) return demandBehind(st, slot, Infinity, 0);
  const k = list[i + 1];
  return demandBehind(st, slot, st.s[k] - st.lengthM[k] / 2 - (st.s[slot] + st.lengthM[slot] / 2), st.v[k]);
}

/**
 * Old follower of `slot` on its lane: the agent just behind it, or −1.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {number} Slot or −1.
 */
function followerOf(st, slot) {
  const e = st.edge[slot];
  const list = st.edgeAgents[e];
  for (let i = 1; i < st.edgeCount[e]; i += 1) if (list[i] === slot) return list[i - 1];
  return -1;
}

/**
 * MOBIL safety of moving `slot` onto `ti` at its landing.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {ReturnType<typeof neighboursAt>} nb New neighbours.
 * @returns {boolean} Safe.
 */
function safe(st, slot, nb) {
  const pers = st.params.personalities[PERSONALITIES[st.personality[slot]]];
  if (nb.leader >= 0 && nb.leaderGap < st.minGap[slot]) return false;
  // Nor would the agent itself have to brake harder than that behind its new leader.
  if (nb.leader >= 0 && demandBehind(st, slot, nb.leaderGap, st.v[nb.leader]) < -pers.mobilSafeDecelMps2) return false;
  if (nb.follower >= 0 && nb.followerGap < Infinity) {
    if (nb.followerGap < st.minGap[nb.follower]) return false;
    if (demandBehind(st, nb.follower, nb.followerGap, st.v[slot]) < -pers.mobilSafeDecelMps2) return false;
  }
  return true;
}

/**
 * Runs the MOBIL decision of one car this step: starts, carries on or drops a signalled change,
 * and switches lane when its lead time has passed.
 * @param {TrafficState} st State.
 * @param {number} slot Slot (a car-kind agent).
 * @param {readonly Obstacle[]} perceived Ego, scripted actors and static obstacles.
 * @param {number} t Time.
 * @param {number} egoDistM Distance to the ego.
 * @returns {boolean} The agent switched lane.
 */
export function stepMobil(st, slot, perceived, t, egoDistM) {
  if (st.wreck[slot] || st.crossing[slot] || st.claim[slot] >= 0) return false;
  const edges = st.graph.edges;
  const e = edges[st.edge[slot]];
  if (e.kind !== 'lane' || e.neighbours.length === 0) {
    if (st.intentKind[slot] === INTENT_CHOSEN) dropIntent(st, slot);
    return false;
  }
  const front = st.s[slot] + st.lengthM[slot] / 2;
  const endsAtJunction = e.next.length > 0 && edges[e.next[0]].kind === 'connector';
  const nearEnd = endsAtJunction ? front > e.holdS - MOBIL_END_M : e.deadEnd && front > e.length - MOBIL_END_M;
  const half = st.lengthM[slot] / 2;

  // Carrying on a signalled change.
  if (st.intentKind[slot] === INTENT_CHOSEN) {
    const ti = st.intentLane[slot];
    const at = e.neighbours.includes(ti) ? landing(st, slot, ti) : null;
    if (!at || nearEnd || t - st.intentT[slot] > MOBIL_GIVE_UP_S) {
      dropIntent(st, slot);
      return false;
    }
    if (!signalled(st, slot, ti, sideOf(at.lateral), t, INTENT_CHOSEN)) return false;
    const unsafe = st.intentCutIn[slot] === 1;
    const nb = neighboursAt(st, slot, ti, at.s, half);
    if (!unsafe && (!safe(st, slot, nb) || !stretchClear(st, slot, edges[ti], at.s, perceived))) return false;
    // A cut-in still never lands on top of another body.
    if (unsafe && (nb.leaderGap <= 0 || nb.followerGap <= 0)) return false;
    if (!wayAcrossClear(st, slot, ti)) return false;
    switchLane(st, slot, ti, at, unsafe);
    return true;
  }
  if (st.intentKind[slot] !== 0 || nearEnd) return false;
  const period = Math.max(1, Math.round(TICK_HZ / st.params.behaviour.mobilHz));
  if ((st.tick + st.spawnIndex[slot]) % period !== 0) return false;

  const pers = st.params.personalities[PERSONALITIES[st.personality[slot]]];
  const aNow = accelNow(st, slot);
  const old = followerOf(st, slot);
  let oldGain = 0;
  if (old >= 0) {
    // The old follower's acceleration now and once the agent has left.
    const list = st.edgeAgents[st.edge[slot]];
    let i = 0;
    while (list[i] !== slot) i += 1;
    const after = i + 1 < st.edgeCount[st.edge[slot]] ? list[i + 1] : -1;
    const gapNow = st.s[slot] - half - (st.s[old] + st.lengthM[old] / 2);
    const gapAfter = after >= 0 ? st.s[after] - st.lengthM[after] / 2 - (st.s[old] + st.lengthM[old] / 2) : Infinity;
    oldGain = demandBehind(st, old, gapAfter, after >= 0 ? st.v[after] : 0) - demandBehind(st, old, gapNow, st.v[slot]);
  }
  let bestLane = -1;
  let bestGain = pers.mobilThresholdMps2;
  let bestSafe = true;
  for (const ti of e.neighbours) {
    const at = landing(st, slot, ti);
    if (!at) continue;
    const t2 = edges[ti];
    // Never into a lane that closes ahead: road works, or a taper that ends.
    if (t2.blocks.some((b) => b.toS > at.s - half && b.fromS < at.s + half + MERGE_LOOK_M)) continue;
    if (t2.deadEnd && !e.deadEnd) continue;
    const nb = neighboursAt(st, slot, ti, at.s, half);
    const aNew = demandBehind(st, slot, nb.leaderGap, nb.leader >= 0 ? st.v[nb.leader] : 0);
    let newGain = 0;
    if (nb.follower >= 0 && nb.followerGap < Infinity) {
      const f = nb.follower;
      const before = nb.leader >= 0 ? st.s[nb.leader] - st.lengthM[nb.leader] / 2 - (at.s - half) + nb.followerGap : Infinity;
      newGain = demandBehind(st, f, nb.followerGap, st.v[slot]) - demandBehind(st, f, before, nb.leader >= 0 ? st.v[nb.leader] : 0);
    }
    const gain = aNew - aNow + pers.mobilPoliteness * (newGain + oldGain);
    if (gain <= bestGain) continue;
    const isSafe = safe(st, slot, nb) && stretchClear(st, slot, t2, at.s, perceived);
    bestLane = ti;
    bestGain = gain;
    bestSafe = isSafe;
  }
  if (bestLane < 0) return false;
  // A reckless driver may go for an unsafe gap.
  const cutIn = !bestSafe && draw(st, slot, rateOf(st, slot, 'cutIn', egoDistM));
  if (!bestSafe && !cutIn) return false;
  const at = /** @type {{s: number, lateral: number}} */ (landing(st, slot, bestLane));
  signalled(st, slot, bestLane, sideOf(at.lateral), t, INTENT_CHOSEN);
  st.intentCutIn[slot] = cutIn ? 1 : 0;
  return false;
}
