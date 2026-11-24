import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTOR_LIGHTS } from '../../contracts/telemetry.js';
import { DT } from '../../contracts/units.js';
import { CAUSE_INATTENTIVE, makeWreck } from './contacts.js';
import { createTraffic, stepTraffic } from './index.js';
import { lawfulParams } from './lawful-params.js';
import { spawnAgent } from './state.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./contacts.js').TrafficIncident} TrafficIncident */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const FULL = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
const LAWFUL = { ...lawfulParams(FULL), preRollS: 0 };
const EGO_AWAY = Object.freeze({ pos: { x: -60, z: 20 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });

/** @returns {GameMap} The junction fixture with no spawning. */
function emptyMap() {
  const map = structuredClone(MAP);
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
  traffic.sources = [];
  traffic.densityPerKm = {};
  return map;
}

/**
 * @param {TrafficState} st State.
 * @param {string} laneId Lane.
 * @param {number} s Centre distance.
 * @param {number} speed Speed.
 * @param {string} model Model.
 * @returns {number} Slot.
 */
function place(st, laneId, s, speed, model) {
  const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get(laneId)), s, speed, st.modelKeys.indexOf(model));
  st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get(`c-${laneId}-re-e0`));
  return slot;
}

/**
 * Steps with green lights; collects incidents and the last poses.
 * @param {TrafficState} st State.
 * @param {GameMap} map Map.
 * @param {number} t0 Start.
 * @param {number} seconds Duration.
 * @param {readonly ActorPose[]} [scripted] Scripted poses.
 * @returns {{incidents: TrafficIncident[], poses: ActorPose[]}} Result.
 */
function run(st, map, t0, seconds, scripted = []) {
  const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
  /** @type {TrafficIncident[]} */
  const incidents = [];
  /** @type {ActorPose[]} */
  let poses = [];
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = t0 + i * DT;
    const step = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted, lights, egoContacts: [], t });
    incidents.push(...step.incidents);
    poses = step.poses;
  }
  return { incidents, poses };
}

describe('NPC contacts', () => {
  it('wrecks both agents when a distracted driver runs into a rider standing in the lane, with the cause recorded', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 31);
    // A rider standing in the middle of the lane; a distracted car comes up behind it.
    const bike = place(st, 'rw-e1', 80, 0, 'motorbike');
    st.v0Factor[bike] = 0;
    st.lateral[bike] = 0;
    st.lateralBase[bike] = 0;
    st.lateralBase[bike] = 0;
    const car = place(st, 'rw-e1', 40, 9, 'car');
    st.distractUntil[car] = 1e9;
    const { incidents, poses } = run(st, map, 0, 8);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].agentIds.sort()).toEqual([st.ids[car], st.ids[bike]].sort());
    expect(incidents[0].causes).toContain(CAUSE_INATTENTIVE);
    const c = /** @type {ActorPose} */ (poses.find((p) => p.id === st.ids[car]));
    const b = /** @type {ActorPose} */ (poses.find((p) => p.id === st.ids[bike]));
    expect(c.state).toBe('crashed');
    expect(b.state).toBe('fallen');
    expect(b.speed).toBe(0);
    expect(c.lights).toBe(ACTOR_LIGHTS.hazard);
    expect(b.lights).toBe(ACTOR_LIGHTS.hazard);
  });

  it('records no contact between lawful attentive agents following each other', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 32);
    const car = place(st, 'rw-e1', 80, 0, 'car');
    st.v0Factor[car] = 0;
    st.baseV0[car] = 0;
    place(st, 'rw-e1', 40, 9, 'motorbike');
    place(st, 'rw-e1', 20, 9, 'car');
    expect(run(st, map, 0, 10).incidents).toEqual([]);
  });

  it('wrecks an agent that runs into a scripted actor, which stays as it is', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 33);
    const bike = place(st, 'rw-e1', 40, 0, 'motorbike');
    // A scripted car pulling out across the rider where it stands.
    /** @type {ActorPose} */
    const parked = {
      id: 'npc-parked',
      kind: 'car',
      pos: { x: st.x[bike] + 1, z: st.z[bike] },
      heading: 0,
      speed: 0,
      active: false,
      model: 'car',
      variant: 0,
      lengthM: 4.5,
      widthM: 1.8,
      lights: ACTOR_LIGHTS.off,
      state: 'stopped',
      violations: [],
    };
    const { incidents } = run(st, map, 0, 1, [parked]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].agentIds).toEqual([st.ids[bike], 'npc-parked']);
    expect(st.wreck[bike]).toBe(1);
  });

  it('slides a car wreck on, and stops it dead where the ego touches it', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 35);
    const car = place(st, 'rw-e1', 40, 9, 'car');
    const id = st.ids[car];
    makeWreck(st, car, 0);
    const slid = run(st, map, 0, 0.5).poses.find((p) => p.id === id);
    expect(slid?.state).toBe('crashed');
    expect(slid?.speed).toBeGreaterThan(0);
    const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
    stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [id], t: 0.5 });
    const s = st.s[car];
    const after = run(st, map, 0.5 + DT, 1).poses.find((p) => p.id === id);
    expect(after?.speed).toBe(0);
    expect(st.s[car]).toBe(s);
    // Still the wreck made at t 0: it clears on the original schedule.
    expect(st.wreckT[car]).toBe(0);
  });

  it('clears the wrecks within wreckClearS and the lane flows again within 30 s', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 34);
    const bike = place(st, 'rw-e1', 80, 0, 'motorbike');
    st.v0Factor[bike] = 0;
    st.lateral[bike] = 0;
    st.lateralBase[bike] = 0;
    const car = place(st, 'rw-e1', 40, 9, 'car');
    st.distractUntil[car] = 1e9;
    const first = run(st, map, 0, 8);
    expect(first.incidents).toHaveLength(1);
    const t0 = first.incidents[0].t;
    const wreckIds = [st.ids[car], st.ids[bike]];
    const wreckX = Math.max(st.x[car], st.x[bike]);
    // A follower queued behind the wrecks.
    const follower = place(st, 'rw-e1', 20, 8, 'car');
    const followerId = st.ids[follower];
    let followerMaxX = -Infinity;
    const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
    let clearedAt = Infinity;
    for (let i = 0; i < Math.round((LAWFUL.wreckClearS + 30) / DT); i += 1) {
      const t = 8 + i * DT;
      const { poses } = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [], t });
      if (clearedAt === Infinity && !poses.some((p) => wreckIds.includes(p.id))) clearedAt = t;
      const f = poses.find((p) => p.id === followerId);
      if (f) followerMaxX = Math.max(followerMaxX, f.pos.x);
    }
    expect(clearedAt - t0).toBeLessThanOrEqual(LAWFUL.wreckClearS + DT);
    // Within 30 s of the clearing the follower has driven on past where the wrecks stood.
    expect(followerMaxX).toBeGreaterThan(wreckX + 5);
  });
});
