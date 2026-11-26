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

/**
 * Steps with green lights until the first incident, then `afterS` more; collects incidents and
 * the last poses. Wrecks leave the road soon after the contact, so a fixed run could end after they did.
 * @param {TrafficState} st State.
 * @param {GameMap} map Map.
 * @param {number} maxS Longest wait for the incident.
 * @param {number} afterS Time to step past it.
 * @returns {{incidents: TrafficIncident[], poses: ActorPose[]}} Result.
 */
function runPastIncident(st, map, maxS, afterS) {
  const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
  /** @type {TrafficIncident[]} */
  const incidents = [];
  /** @type {ActorPose[]} */
  let poses = [];
  let end = maxS;
  for (let i = 0; i * DT < end; i += 1) {
    const t = i * DT;
    const step = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [], t });
    if (incidents.length === 0 && step.incidents.length > 0) end = Math.min(maxS, t + afterS);
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
    const { incidents, poses } = runPastIncident(st, map, 8, 0.5);
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

  describe('clears every wreck 3 s after the contact', () => {
    const CLEAR_S = 3;

    /**
     * Steps with green lights from `t0` until none of `ids` is on the road; returns that time.
     * @param {TrafficState} st State.
     * @param {GameMap} map Map.
     * @param {number} t0 Start.
     * @param {readonly string[]} ids Wreck ids.
     * @param {number} wreckT Contact time.
     * @returns {number} First step time with every wreck gone.
     */
    const goneAt = (st, map, t0, ids, wreckT) => {
      const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
      for (let i = 0; i < Math.round((CLEAR_S + 2) / DT); i += 1) {
        const t = t0 + i * DT;
        const { poses } = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [], t });
        const left = poses.filter((p) => ids.includes(p.id));
        if (left.length === 0) return t;
        // Every wreck stands until its time is up.
        expect(t - wreckT).toBeLessThan(CLEAR_S);
      }
      return Infinity;
    };

    it('ships wreckClearS at 3 s', () => {
      expect(FULL.wreckClearS).toBe(CLEAR_S);
    });

    it('for an agent the ego touched', () => {
      const map = emptyMap();
      const st = createTraffic(map, LAWFUL, 36);
      const car = place(st, 'rw-e1', 40, 9, 'car');
      const id = st.ids[car];
      run(st, map, 0, 1);
      const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
      stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [id], t: 1 });
      expect(st.wreck[car]).toBe(1);
      const wreckT = st.wreckT[car];
      expect(wreckT).toBeCloseTo(1, 9);
      const gone = goneAt(st, map, 1 + DT, [id], wreckT);
      expect(gone - wreckT).toBeGreaterThanOrEqual(CLEAR_S - DT / 2);
      expect(gone - wreckT).toBeLessThanOrEqual(CLEAR_S + DT / 2);
    });

    it('for two agents that ran into each other', () => {
      const map = emptyMap();
      const st = createTraffic(map, LAWFUL, 37);
      const bike = place(st, 'rw-e1', 80, 0, 'motorbike');
      st.v0Factor[bike] = 0;
      st.lateral[bike] = 0;
      st.lateralBase[bike] = 0;
      const car = place(st, 'rw-e1', 40, 9, 'car');
      st.distractUntil[car] = 1e9;
      const { incidents } = runPastIncident(st, map, 8, 0);
      expect(incidents).toHaveLength(1);
      const wreckT = incidents[0].t;
      expect(st.wreckT[car]).toBe(wreckT);
      expect(st.wreckT[bike]).toBe(wreckT);
      const ids = [st.ids[car], st.ids[bike]];
      const tNext = (Math.round(wreckT / DT) + 1) * DT;
      const gone = goneAt(st, map, tNext, ids, wreckT);
      expect(gone - wreckT).toBeGreaterThanOrEqual(CLEAR_S - DT / 2);
      expect(gone - wreckT).toBeLessThanOrEqual(CLEAR_S + DT / 2);
    });
  });

  describe('clears a wreck far from the ego early only when it lies behind', () => {
    /**
     * Wrecks a car through an ego contact, then steps with the ego `wreckClearDistM` + 10 m east
     * or west of it, heading east, until the wreck is gone.
     * @param {1 | -1} side +1: the ego east of the wreck, so the wreck is behind it.
     * @returns {number} Time from the contact to the first step without the wreck.
     */
    const standTime = (side) => {
      const map = emptyMap();
      const st = createTraffic(map, LAWFUL, 38);
      const car = place(st, 'rw-e1', 40, 9, 'car');
      const id = st.ids[car];
      run(st, map, 0, 1);
      const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
      stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [id], t: 1 });
      expect(st.wreck[car]).toBe(1);
      const wreckT = st.wreckT[car];
      const ego = { ...EGO_AWAY, pos: { x: st.x[car] + side * (FULL.wreckClearDistM + 10), z: st.z[car] }, heading: 0 };
      for (let i = 1; i < Math.round((FULL.wreckClearS + 2) / DT); i += 1) {
        const t = 1 + i * DT;
        const { poses } = stepTraffic(st, { ego, egoReset: false, scripted: [], lights, egoContacts: [], t });
        if (!poses.some((p) => p.id === id)) return t - wreckT;
      }
      return Infinity;
    };

    it('behind the ego: on the next step', () => {
      expect(standTime(1)).toBeCloseTo(DT, 9);
    });

    it('ahead of the ego: after the full wreckClearS', () => {
      const stood = standTime(-1);
      expect(stood).toBeGreaterThanOrEqual(FULL.wreckClearS - DT / 2);
      expect(stood).toBeLessThanOrEqual(FULL.wreckClearS + DT / 2);
    });
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
    const lights = Object.fromEntries(map.signals.map((s) => [s.id, /** @type {const} */ ('green')]));
    const wreckIds = [st.ids[car], st.ids[bike]];
    /** @type {TrafficIncident[]} */
    const incidents = [];
    let t0 = Infinity;
    // The furthest point a wreck reached, sliding car included.
    let wreckX = -Infinity;
    let followerId = '';
    let followerMaxX = -Infinity;
    let followerHeld = false;
    let clearedAt = Infinity;
    for (let i = 0; i < Math.round((8 + LAWFUL.wreckClearS + 30) / DT); i += 1) {
      const t = i * DT;
      const step = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [], t });
      if (t < 8) incidents.push(...step.incidents);
      if (t0 === Infinity && step.incidents.length > 0) {
        t0 = step.incidents[0].t;
        // A follower coming up close behind the wrecks, so it queues before they clear.
        followerId = st.ids[place(st, 'rw-e1', Math.min(st.s[car], st.s[bike]) - 15, 4, 'car')];
      }
      if (t0 === Infinity) continue;
      const wrecks = step.poses.filter((p) => wreckIds.includes(p.id));
      for (const w of wrecks) wreckX = Math.max(wreckX, w.pos.x);
      if (clearedAt === Infinity && wrecks.length === 0) clearedAt = t;
      const f = step.poses.find((p) => p.id === followerId);
      if (f) followerMaxX = Math.max(followerMaxX, f.pos.x);
      if (f && wrecks.length > 0 && f.speed === 0) followerHeld = true;
    }
    expect(incidents).toHaveLength(1);
    expect(followerHeld, 'the follower stops behind the wrecks before they clear').toBe(true);
    expect(clearedAt - t0).toBeLessThanOrEqual(LAWFUL.wreckClearS + DT);
    // Within 30 s of the clearing the follower has driven on past where the wrecks stood.
    expect(followerMaxX).toBeGreaterThan(wreckX + 5);
  });
});
