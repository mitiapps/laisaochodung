/**
 * NPC contacts and wrecks. After every step's motion, agents are paired through the uniform grid
 * (`grid.js`) and their oriented footprints tested for overlap (separating axes through
 * `polygonsIntersect`); each agent is also tested against every scripted actor. On the first
 * overlap of a pair both agents become wrecks (an agent cannot wreck a scripted actor: only the
 * agent does, a known simplification) and the step records an incident with the causes found on
 * the parties: their latched violation flags and `inattentive` when one was in a distraction
 * episode within the last `LATCH_S`.
 *
 * A car wreck slides on along its path, braking at `behaviour.wreckSlideDecelMps2`, and stops at
 * anything ahead of it; a motorbike falls where it is. Hazard lamps go on. Wrecks clear after
 * `wreckClearS` (in the event phase). Contacts with the ego stay with the sim (`egoContacts`).
 */

import { footprint, polygonsIntersect } from '../../geometry/index.js';
import { queryGrid, rebuildGrid } from './grid.js';
import { LATCH_S, maskOf } from './violations.js';
import { NPC_VIOLATIONS } from '../../contracts/telemetry.js';
import { claimDrop } from './state.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('../../contracts/telemetry.js').Vec2} Vec2 */

/**
 * An NPC incident: a first contact between two traffic agents, or between an agent and a
 * scripted actor.
 * @typedef {object} TrafficIncident
 * @property {number} t Time of the step.
 * @property {string[]} agentIds Parties, traffic agents first in spawn order.
 * @property {string[]} causes Union of the parties' human-factor causes and latched flags, sorted.
 */

/** Human-factor cause of an agent distracted within the last `LATCH_S`. */
export const CAUSE_INATTENTIVE = 'inattentive';
/** Largest half diagonal of any agent body, metres (a 10.5 × 2.5 m bus is about 5.4). */
const MAX_RADIUS_M = 6;

/**
 * Causes carried by one agent at `t`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time.
 * @param {Set<string>} out Causes, added to.
 * @returns {void}
 */
function causesOf(st, slot, t, out) {
  const mask = maskOf(st, slot, t) | st.flagNow[slot];
  for (let i = 0; i < NPC_VIOLATIONS.length; i += 1) if (mask & (1 << i)) out.add(NPC_VIOLATIONS[i]);
  if (st.distractUntil[slot] > t - LATCH_S) out.add(CAUSE_INATTENTIVE);
}

/**
 * Turns an agent into a wreck: a motorbike falls (speed 0), a car keeps its speed to slide; a claim
 * still before the junction is given back.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time.
 * @returns {void}
 */
export function makeWreck(st, slot, t) {
  if (st.wreck[slot]) return;
  st.wreck[slot] = 1;
  st.wreckT[slot] = t;
  st.acc[slot] = 0;
  if (st.isMoto[slot]) st.v[slot] = 0;
  // The body keeps the turn it had (a sudden straightening would swing it into its neighbours).
  st.crossing[slot] = 0;
  const c = st.claim[slot];
  if (c >= 0 && st.edge[slot] === st.graph.edges[c].fromEdge) claimDrop(st, slot);
}

/** @type {Vec2[][]} */
let FOOTPRINTS = [];

/**
 * Finds the first contacts of this step and makes their wrecks.
 * @param {TrafficState} st State, after motion and pose update.
 * @param {readonly ActorPose[]} scripted Scripted actor poses of the step.
 * @param {readonly Vec2[][]} scriptedFootprints Their footprints.
 * @param {number} t Time of the step.
 * @returns {TrafficIncident[]} Incidents that started this step.
 */
export function detectContacts(st, scripted, scriptedFootprints, t) {
  /** @type {TrafficIncident[]} */
  const incidents = [];
  if (FOOTPRINTS.length < st.capacity) FOOTPRINTS = new Array(st.capacity);
  for (let i = 0; i < st.activeCount; i += 1) {
    const k = st.active[i];
    FOOTPRINTS[k] = footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]);
  }
  rebuildGrid(st.grid, st.active, st.activeCount, st.x, st.z);
  /** @type {[number, number][]} */
  const pairs = [];
  for (let i = 0; i < st.activeCount; i += 1) {
    const a = st.active[i];
    const ra = Math.hypot(st.lengthM[a], st.widthM[a]) / 2;
    queryGrid(st.grid, st.x[a], st.z[a], ra + MAX_RADIUS_M, (b) => {
      // Each pair once, the lower spawn index asking; two wrecks are already done.
      if (st.spawnIndex[b] <= st.spawnIndex[a] || (st.wreck[a] && st.wreck[b])) return false;
      const rb = Math.hypot(st.lengthM[b], st.widthM[b]) / 2;
      const dx = st.x[b] - st.x[a];
      const dz = st.z[b] - st.z[a];
      if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return false;
      if (polygonsIntersect(FOOTPRINTS[a], FOOTPRINTS[b])) pairs.push([a, b]);
      return false;
    });
  }
  // Deterministic order whatever the grid order.
  pairs.sort((p, q) => st.spawnIndex[p[0]] - st.spawnIndex[q[0]] || st.spawnIndex[p[1]] - st.spawnIndex[q[1]]);
  for (const [a, b] of pairs) {
    if (st.wreck[a] && st.wreck[b]) continue;
    /** @type {Set<string>} */
    const causes = new Set();
    causesOf(st, a, t, causes);
    causesOf(st, b, t, causes);
    makeWreck(st, a, t);
    makeWreck(st, b, t);
    incidents.push({ t, agentIds: [st.ids[a], st.ids[b]], causes: [...causes].sort() });
  }
  for (let i = 0; i < st.activeCount; i += 1) {
    const a = st.active[i];
    if (st.wreck[a]) continue;
    for (let j = 0; j < scripted.length; j += 1) {
      const p = scripted[j];
      const r = Math.hypot(p.lengthM, p.widthM) / 2 + Math.hypot(st.lengthM[a], st.widthM[a]) / 2;
      const dx = p.pos.x - st.x[a];
      const dz = p.pos.z - st.z[a];
      if (dx * dx + dz * dz > r * r || !polygonsIntersect(FOOTPRINTS[a], scriptedFootprints[j])) continue;
      /** @type {Set<string>} */
      const causes = new Set();
      causesOf(st, a, t, causes);
      makeWreck(st, a, t);
      incidents.push({ t, agentIds: [st.ids[a], p.id], causes: [...causes].sort() });
      break;
    }
  }
  return incidents;
}
