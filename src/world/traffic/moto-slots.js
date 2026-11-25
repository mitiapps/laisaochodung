/**
 * Motorbike lateral slots: a rider keeps an offset within its lane (riding on a line to a lane of
 * the same direction at most `LINE_OVERHANG_M` past it, never past a kerb or a centre line) and re-chooses it `motorbike.slotHz` times a second, staggered
 * by spawn index. Each candidate offset is scored by the IDM acceleration the rider would have
 * behind the first agent ahead that overlaps it laterally, less a pull towards its keep-right
 * offset and a cost for moving. A candidate is out when an agent alongside stands between the
 * rider and it.
 *
 * Lateral overlap uses the dynamic lane width of a rider, `lw(v) = laneWidthPerMps · v +
 * laneWidthBaseM`, so riders pass close at a crawl and wide at speed. At a red stop line the
 * free slots across the lane fill one after another, which makes the cluster of riders side by
 * side; past a stopped car a rider filters along the line when it fits.
 *
 * A careful or normal rider never moves into the ego's forward corridor inside the ego's stopping
 * distance; a reckless one may (its `cutIn` rate per choice), which the traffic module flags as
 * `unsafe-lane-change` from the true state.
 */

import { footprint, normalizeAngle, polygonsIntersect } from '../../geometry/index.js';
import { idmAcceleration } from './idm.js';
import { draw, rateOf } from './violations.js';
import { SIDE_LEFT, SIDE_RIGHT } from './state.js';
import { queryGrid } from './grid.js';
import { corridorObstacle } from './perception.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('../../contracts/telemetry.js').Vec2} Vec2 */

/** Furthest a rider's body may stick out past its lane edge, metres (design: riding on the line). */
export const LINE_OVERHANG_M = 0.3;
/** Spacing of the candidate offsets, metres (design). */
export const SLOT_STEP_M = 0.3;
/** Score cost per metre away from the keep-right offset, m/s² (design). */
export const KEEP_RIGHT_PULL = 0.25;
/** Score cost per metre of move from the current slot, m/s² (design: no dithering). */
export const MOVE_COST = 0.15;
/** Within this distance of a lane end before a junction a rider keeps to the band of its turn, metres (design). */
export const TURN_PREP_M = 50;
/** Lateral clearance between two bodies beyond their widths, metres (design). */
export const SIDE_CLEAR_M = 0.1;
/** Agents within this extra length of each other along the lane count as alongside, metres. */
const ALONGSIDE_M = 0.5;
/** An agent this far ahead along the lane is not looked at for a slot, metres (design). */
const SLOT_LOOK_M = 80;

/**
 * Lateral space a body needs from another's centre: half widths plus a clearance that grows with
 * a rider's speed (dynamic lane width), or the corridor margin of a car.
 * @param {TrafficState} st State.
 * @param {number} self Slot asking.
 * @param {number} other Other slot.
 * @returns {number} Centre-to-centre lateral distance below which they overlap, metres.
 */
export function lateralNeed(st, self, other) {
  const moto = st.isMoto[self] === 1;
  const mb = st.params.motorbike;
  const clear = moto ? Math.max(0, mb.laneWidthPerMps * st.v[self] + mb.laneWidthBaseM - st.widthM[self]) + SIDE_CLEAR_M : st.params.behaviour.corridorMarginM;
  return (st.widthM[self] + st.widthM[other]) / 2 + clear;
}

/**
 * Whether `other` overlaps laterally a body of `self` at offset `lat` (same edge offsets).
 * @param {TrafficState} st State.
 * @param {number} self Slot asking.
 * @param {number} lat Offset of `self` to test.
 * @param {number} other Other slot.
 * @returns {boolean} Overlap.
 */
export function overlapsAt(st, self, lat, other) {
  return Math.abs(st.lateral[other] - lat) < lateralNeed(st, self, other);
}

/**
 * Bumper gap and speed of the first agent ahead on the slot's own edge that overlaps offset `lat`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} listPos Position of the slot in its edge list.
 * @param {number} lat Offset.
 * @param {Float64Array} out `[gap, speed]`, gap Infinity when none.
 * @returns {void}
 */
function leaderAt(st, slot, listPos, lat, out) {
  out[0] = Infinity;
  out[1] = 0;
  const e = st.edge[slot];
  const list = st.edgeAgents[e];
  const front = st.s[slot] + st.lengthM[slot] / 2;
  for (let i = listPos + 1; i < st.edgeCount[e]; i += 1) {
    const k = list[i];
    const rear = st.s[k] - st.lengthM[k] / 2;
    if (rear - front > SLOT_LOOK_M) return;
    if (!overlapsAt(st, slot, lat, k)) continue;
    out[0] = rear - front;
    out[1] = st.v[k];
    return;
  }
}

/**
 * Whether an agent alongside stands between the rider and offset `lat`: on the rider's own lane,
 * or on the lane beyond the line it would ride on (offsets carried across the line). An agent
 * counts over the whole stretch between its offset and the slot it is moving to.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} lat Target offset.
 * @returns {boolean} Blocked.
 */
export function pathBlocked(st, slot, lat) {
  const e = st.edge[slot];
  const lo = Math.min(lat, st.lateral[slot]);
  const hi = Math.max(lat, st.lateral[slot]);
  if (blockedOn(st, slot, e, 0, lo, hi)) return true;
  // Agents of the lanes beside it, riding on the line or moving across, count too.
  const hw = st.halfWidth[e];
  for (const n of st.graph.edges[e].neighbours) {
    const shift = (st.halfWidth[n] + hw) * sideOfLane(st, e, n);
    if (blockedOn(st, slot, n, shift, lo, hi)) return true;
  }
  return false;
}

/**
 * Whether lane `n` lies left (1) or right (−1) of lane `e` (same road and direction).
 * @param {TrafficState} st State.
 * @param {number} e Lane.
 * @param {number} n Neighbour lane.
 * @returns {number} Side.
 */
function sideOfLane(st, e, n) {
  return st.laneIndexOf[n] > st.laneIndexOf[e] ? 1 : -1;
}

/**
 * Whether an agent of edge `edge`, its offsets shifted by `shift`, stands alongside the rider within
 * the offset stretch [lo, hi].
 * @param {TrafficState} st State.
 * @param {number} slot Rider.
 * @param {number} edge Edge looked at.
 * @param {number} shift Offset of that edge's centre in the rider's lane offsets.
 * @param {number} lo Low end of the stretch.
 * @param {number} hi High end.
 * @returns {boolean} Blocked.
 */
function blockedOn(st, slot, edge, shift, lo, hi) {
  const list = st.edgeAgents[edge];
  const own = edge === st.edge[slot];
  for (let i = 0; i < st.edgeCount[edge]; i += 1) {
    const k = list[i];
    if (k === slot) continue;
    // Along the lane: same edge by distance; a neighbour lane runs alongside, so by projection.
    const ds = own ? st.s[k] - st.s[slot] : alongOffset(st, slot, k);
    // The margin applies ahead only: a body wholly behind the rider is not in the way of a move
    // sideways (else a rider queued close behind pins the one ahead out of its turn band).
    const reach = (st.lengthM[k] + st.lengthM[slot]) / 2;
    if (ds < 0 ? -ds >= reach : ds >= reach + ALONGSIDE_M) continue;
    // One whose move the rider's body holds (a car moving across into the rider's lane) cannot
    // come any closer until the rider makes way, so its target offset does not count, and a move
    // away from it never puts the rider in its way: else each holds the other for ever.
    if (st.heldBy[k] === slot) {
      const away = (st.lateral[k] + shift - st.lateral[slot]) * (lo + hi - 2 * st.lateral[slot]) <= 0;
      if (away) continue;
    }
    // A body turned by its lane change swings its ends out sideways.
    const yaw = Math.abs(normalizeAngle(st.heading[k] - st.heading[slot]));
    const need = lateralNeed(st, slot, k) + (st.lengthM[k] / 2) * Math.sin(Math.min(yaw, Math.PI / 2));
    const a = Math.min(st.lateral[k], st.lateralBase[k]) + shift;
    const b = Math.max(st.lateral[k], st.lateralBase[k]) + shift;
    if (b > lo - need && a < hi + need) return true;
  }
  return false;
}

/**
 * Distance of `k` ahead of `slot` along the rider's heading.
 * @param {TrafficState} st State.
 * @param {number} slot Rider.
 * @param {number} k Other.
 * @returns {number} Metres.
 */
function alongOffset(st, slot, k) {
  return (st.x[k] - st.x[slot]) * Math.cos(st.heading[slot]) - (st.z[k] - st.z[slot]) * Math.sin(st.heading[slot]);
}

/** @type {Float64Array} */
const PAIR = new Float64Array(2);

/**
 * Footprint of the slot at lateral offset `lat` from its current pose.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} lat Offset.
 * @param {number} laneHeading Heading of the lane at the slot.
 * @returns {Vec2[]} Footprint.
 */
function footprintAt(st, slot, lat, laneHeading) {
  const d = lat - st.lateral[slot];
  const x = st.x[slot] - Math.sin(laneHeading) * d;
  const z = st.z[slot] - Math.cos(laneHeading) * d;
  return footprint({ x, z }, st.heading[slot], st.lengthM[slot], st.widthM[slot]);
}

/**
 * Re-chooses the lateral slot of a rider on a lane; writes it to `lateralBase`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot (a motorbike on a lane edge, not a wreck, not crossing).
 * @param {number} listPos Its position in its edge list.
 * @param {number} laneHeading Lane heading at the rider.
 * @param {Vec2[] | null} egoCorridor The ego's forward corridor inside its stopping distance.
 * @param {number} egoDistM Distance to the ego.
 * @returns {void}
 */
export function chooseSlot(st, slot, listPos, laneHeading, egoCorridor, egoDistM) {
  const hw = st.halfWidth[st.edge[slot]];
  const half = st.widthM[slot] / 2;
  const sides = st.openSides[st.edge[slot]];
  let lo = -hw + half - (sides & SIDE_RIGHT ? LINE_OVERHANG_M : 0);
  let hi = hw - half + (sides & SIDE_LEFT ? LINE_OVERHANG_M : 0);
  // Near a junction a rider takes the band of its turn: right turners keep right, left turners
  // keep left, straight riders the middle, so their paths do not cross in the box.
  const e = st.graph.edges[st.edge[slot]];
  const next = st.nextEdge[slot];
  if (next >= 0 && st.graph.edges[next].kind === 'connector' && e.length - st.s[slot] < TURN_PREP_M) {
    const turn = st.graph.edges[next].turn;
    const third = hw / 3;
    if (turn === 'left' || turn === 'uturn') lo = Math.max(lo, third);
    else if (turn === 'right') hi = Math.min(hi, -third);
    else {
      lo = Math.max(lo, -third - half);
      hi = Math.min(hi, third + half);
    }
  }
  if (!(hi > lo)) {
    lo = (lo + hi) / 2;
    hi = lo;
  }
  const v = st.v[slot];
  const v0 = Math.max(st.baseV0[slot] * st.v0Factor[slot], 0.5);
  const keep = Math.min(hi, Math.max(lo, -st.params.motorbike.keepRightOffsetM));
  const inCorridorNow = egoCorridor !== null && polygonsIntersect(footprintAt(st, slot, st.lateral[slot], laneHeading), egoCorridor);
  let best = st.lateralBase[slot];
  let bestScore = -Infinity;
  let cutIn = Number.NaN;
  let cutInScore = -Infinity;
  const n = Math.max(0, Math.floor((hi - lo) / SLOT_STEP_M + 1e-9));
  for (let i = 0; i <= n; i += 1) {
    const c = lo + i * SLOT_STEP_M;
    if (pathBlocked(st, slot, c)) continue;
    leaderAt(st, slot, listPos, c, PAIR);
    const acc =
      PAIR[0] === Infinity
        ? st.accelMax[slot] * (1 - Math.pow(v / v0, st.delta[slot]))
        : PAIR[0] <= 0
          ? -st.decelMax[slot]
          : Math.max(-st.decelMax[slot], idmAcceleration(v, v0, PAIR[0], v - PAIR[1], st.accelMax[slot], st.decelComfort[slot], st.timeGap[slot], st.minGap[slot], st.delta[slot]));
    const score = acc - KEEP_RIGHT_PULL * Math.abs(c - keep) - MOVE_COST * Math.abs(c - st.lateralBase[slot]);
    const intoEgo = egoCorridor !== null && !inCorridorNow && polygonsIntersect(footprintAt(st, slot, c, laneHeading), egoCorridor);
    if (intoEgo) {
      if (score > cutInScore) {
        cutInScore = score;
        cutIn = c;
      }
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (cutInScore > bestScore && draw(st, slot, rateOf(st, slot, 'cutIn', egoDistM))) best = cutIn;
  st.lateralBase[slot] = best;
}

/** Largest half diagonal of any agent body, metres. */
const MAX_RADIUS_M = 6;

/**
 * Whether the rider's body at offset `lat` would touch another agent's body it does not touch now
 * (the per-step guard of a slot move, on true footprints, whatever edge the other is on).
 * @param {TrafficState} st State, with the grid built over the agents' current centres.
 * @param {number} slot Rider.
 * @param {number} lat Offset after this step's move.
 * @returns {boolean} The move would touch.
 */
export function moveTouches(st, slot, lat) {
  // Left of heading θ is (−sin θ, −cos θ).
  const d = lat - st.lateral[slot];
  const x = st.x[slot] - Math.sin(st.heading[slot]) * d;
  const z = st.z[slot] - Math.cos(st.heading[slot]) * d;
  const mine = footprint({ x, z }, st.heading[slot], st.lengthM[slot], st.widthM[slot]);
  const now = footprint({ x: st.x[slot], z: st.z[slot] }, st.heading[slot], st.lengthM[slot], st.widthM[slot]);
  const r = Math.hypot(st.lengthM[slot], st.widthM[slot]) / 2 + MAX_RADIUS_M;
  return queryGrid(st.grid, x, z, r, (k) => {
    if (k === slot) return false;
    const other = footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]);
    return polygonsIntersect(mine, other) && !polygonsIntersect(now, other);
  });
}

/**
 * A rider on a connector whose corridor the ego has stood in for this long goes round it, seconds
 * (design: long enough that an ego pausing in the box is waited for, short enough that a rider
 * does not stand behind a stalled player, as a real rider would filter past within moments).
 */
export const GO_ROUND_AFTER_S = 3;
/** The ego this close ahead in a rider's corridor is in its way, metres (design). */
export const GO_ROUND_LOOK_M = 10;

/** @typedef {import('./perception.js').Obstacle} Obstacle */

/**
 * Lets a rider on a connector go round an ego standing in its corridor: the smallest offset, in
 * `SLOT_STEP_M` steps on either side (right first), whose corridor past the ego is clear of the
 * ego and of every other obstacle, kept inside the exit lane so the rider ends the connector on
 * it. Writes the offset to `lateralBase`; the rider moves there at the normal lateral rate, and
 * its slot on the exit lane is chosen again as on any lane. A target already clear is kept, so
 * the rider does not swap sides on the way.
 * @param {TrafficState} st State.
 * @param {number} slot Rider on a connector edge (not a wreck, not crossing).
 * @param {Obstacle} ego The ego, standing.
 * @param {readonly Obstacle[]} others Scripted actors, static obstacles and nearby agents.
 * @returns {void}
 */
export function goRoundEgo(st, slot, ego, others) {
  const EGO = [ego];
  corridorObstacle(st, slot, EGO, GO_ROUND_LOOK_M, PAIR);
  if (PAIR[0] === Infinity) return;
  // Far enough to be past the ego, with the rider's own length.
  const look = PAIR[0] + 2 * ego.radius + st.lengthM[slot];
  const clearAt = (/** @type {number} */ c) => {
    corridorObstacle(st, slot, EGO, look, PAIR, c);
    if (PAIR[0] < Infinity) return false;
    corridorObstacle(st, slot, others, look, PAIR, c);
    return PAIR[0] === Infinity;
  };
  const base = st.lateralBase[slot];
  if (base !== st.lateral[slot] && clearAt(base)) return;
  const conn = st.graph.edges[st.edge[slot]];
  const limit = st.halfWidth[conn.toEdge] - st.widthM[slot] / 2;
  const from = st.lateral[slot];
  for (let i = 1; i * SLOT_STEP_M <= 2 * limit + 1e-9; i += 1) {
    for (const side of [-1, 1]) {
      const c = from + side * i * SLOT_STEP_M;
      if (Math.abs(c) > limit + 1e-9) continue;
      if (clearAt(c)) {
        st.lateralBase[slot] = c;
        return;
      }
    }
  }
}

/** A rider this far outside the band of its turn does not enter the junction yet, metres (design). */
const BAND_SLACK_M = 0.3;

/**
 * Whether a rider waiting to enter connector `conn` rides in the band of its turn (left turners
 * left of a third of the lane, right turners right of it); others and straight riders always are.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} conn Connector.
 * @returns {boolean} In its band.
 */
export function inTurnBand(st, slot, conn) {
  if (!st.isMoto[slot]) return true;
  const turn = st.graph.edges[conn].turn;
  const third = st.halfWidth[st.edge[slot]] / 3;
  if (turn === 'left' || turn === 'uturn') return st.lateral[slot] >= third - BAND_SLACK_M;
  if (turn === 'right') return st.lateral[slot] <= -third + BAND_SLACK_M;
  return true;
}
