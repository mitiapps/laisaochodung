import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';
import { DESPAWN_REASONS } from './state.js';
import { inViewCone } from './spawner.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./index.js').EgoInput} EgoInput */
/** @typedef {import('./state.js').TrafficState} TrafficState */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
const TRAFFIC = /** @type {import('../../contracts/map.js').TrafficConfig} */ (MAP.traffic);
const EGO_AWAY = Object.freeze({ pos: { x: -60, z: 20 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });

/**
 * @param {(m: GameMap) => void} edit Edit of a copy of the junction map.
 * @returns {GameMap} Map.
 */
function mapWith(edit) {
  const map = structuredClone(MAP);
  edit(map);
  return map;
}

/**
 * Runs traffic and reports each agent's first pose.
 * @param {TrafficState} st State.
 * @param {GameMap} map Map.
 * @param {number} seconds Duration.
 * @param {EgoInput} ego Ego.
 * @returns {Map<string, {pose: ActorPose, t: number}>} First pose by id.
 */
function firstPoses(st, map, seconds, ego) {
  /** @type {Map<string, {pose: ActorPose, t: number}>} */
  const first = new Map();
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = i * DT;
    const { poses } = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
    for (const p of poses) if (!first.has(p.id)) first.set(p.id, { pose: p, t });
  }
  return first;
}

/** @returns {{x: number, z: number, laneId: string}[]} Source lane starts. */
function sourcePoints() {
  return TRAFFIC.sources.map((s) => {
    const lane = MAP.roads.flatMap((r) => r.lanes).find((l) => l.id === s.laneId);
    const [x, z] = /** @type {import('../../contracts/map.js').Lane} */ (lane).centerline[0];
    return { x, z, laneId: s.laneId };
  });
}

describe('sources', () => {
  it('emit at their rate within ±20% over 10 minutes', () => {
    const map = mapWith((m) => {
      const t = /** @type {import('../../contracts/map.js').TrafficConfig} */ (m.traffic);
      t.densityPerKm = {};
      t.maxAgents = 400;
    });
    const st = createTraffic(map, { ...PARAMS, preRollS: 0 }, 21);
    // Off the road at the junction, more than 60 m from every source.
    firstPoses(st, map, 600, { pos: { x: 30, z: 30 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });
    TRAFFIC.sources.forEach((src, i) => {
      const expected = (src.ratePerH * 600) / 3600;
      expect(st.stats.sourceEmitted[i], src.laneId).toBeGreaterThanOrEqual(expected * 0.8);
      expect(st.stats.sourceEmitted[i], src.laneId).toBeLessThanOrEqual(expected * 1.2);
    });
  }, 60_000);

  it('never emit within sourceMinEgoDistM of the ego', () => {
    const ego = { pos: { ...MAP.route.start.pos }, heading: MAP.route.start.heading, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const st = createTraffic(MAP, PARAMS, 22);
    const first = firstPoses(st, MAP, 180, ego);
    const near = TRAFFIC.sources.map((s, i) => i).filter((i) => {
      const p = sourcePoints()[i];
      return Math.hypot(p.x - ego.pos.x, p.z - ego.pos.z) <= PARAMS.sourceMinEgoDistM;
    });
    expect(near.length).toBeGreaterThan(0);
    for (const i of near) expect(st.stats.sourceEmitted[i]).toBe(0);
    for (const { pose } of first.values()) {
      for (const p of sourcePoints()) {
        if (Math.hypot(pose.pos.x - p.x, pose.pos.z - p.z) < pose.lengthM / 2 + 1) {
          expect(Math.hypot(pose.pos.x - ego.pos.x, pose.pos.z - ego.pos.z)).toBeGreaterThan(PARAMS.sourceMinEgoDistM);
        }
      }
    }
  });
});

describe('pre-roll', () => {
  it('populates the junction arms at t = 0 around the ego start', () => {
    const st = createTraffic(MAP, PARAMS, 23);
    expect(st.t).toBe(0);
    const ego = { pos: { ...MAP.route.start.pos }, heading: MAP.route.start.heading, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const { poses } = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(MAP, 0), egoContacts: [], t: 0 });
    const westArm = poses.filter((p) => p.pos.x < -7 && Math.abs(p.pos.z) < 7);
    expect(westArm.length).toBeGreaterThan(5);
    expect(poses.some((p) => Math.hypot(p.pos.x, p.pos.z) < 40)).toBe(true);
    expect(poses.some((p) => p.speed > 0)).toBe(true);
  });
});

describe('ring spawner and despawn', () => {
  it('spawns inside the ring, out of the ego view where possible, with the map mix', () => {
    let motorbikes = 0;
    let total = 0;
    for (const seed of [31, 32, 33, 34, 35]) {
      const st = createTraffic(MAP, PARAMS, seed);
      const ego = { pos: { x: -40, z: 1.75 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 };
      const first = firstPoses(st, MAP, 300, ego);
      const sources = sourcePoints();
      for (const { pose, t } of first.values()) {
        total += 1;
        if (pose.kind === 'motorbike') motorbikes += 1;
        if (t === 0) continue;
        const fromSource = sources.some((p) => Math.hypot(pose.pos.x - p.x, pose.pos.z - p.z) < pose.lengthM / 2 + 1);
        if (fromSource) continue;
        const d = Math.hypot(pose.pos.x - ego.pos.x, pose.pos.z - ego.pos.z);
        expect(d).toBeGreaterThanOrEqual(TRAFFIC.spawnRingM[0] - pose.lengthM);
        expect(d).toBeLessThanOrEqual(TRAFFIC.spawnRingM[1] + pose.lengthM);
      }
    }
    expect(motorbikes / total).toBeGreaterThan(0.7);
    expect(motorbikes / total).toBeLessThan(0.8);
  }, 60_000);

  it('accounts for every agent: each one leaves at a sink or despawns', () => {
    const st = createTraffic(MAP, PARAMS, 24);
    /** @type {Map<string, number>} */
    const seen = new Map();
    let oldest = 0;
    for (let i = 0; i < Math.round(600 / DT); i += 1) {
      const t = i * DT;
      const { poses } = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(MAP, t), egoContacts: [], t });
      for (const p of poses) {
        const born = seen.get(p.id) ?? t;
        seen.set(p.id, born);
        oldest = Math.max(oldest, t - born);
      }
    }
    const removed = DESPAWN_REASONS.reduce((n, r) => n + st.stats.despawned[/** @type {import('./state.js').DespawnReason} */ (r)], 0);
    expect(st.stats.spawned - st.activeCount).toBe(removed);
    expect(st.stats.despawned.sink).toBeGreaterThan(50);
    // Nobody is stuck for the whole run.
    expect(oldest).toBeLessThan(540);
  }, 60_000);

  it('despawns an agent stopped at a dead end once it is out of the ego view', () => {
    const map = mapWith((m) => {
      const t = /** @type {import('../../contracts/map.js').TrafficConfig} */ (m.traffic);
      t.sinks = t.sinks.filter((id) => id !== 're-e0');
      t.spawnRingM = [60, 400];
    });
    // Beside the dead end, looking away from it.
    const looking = { ...EGO_AWAY, pos: { x: 150, z: 20 }, heading: Math.PI };
    // The pre-roll ego, at the map start, is out of view range of the dead end; count from t = 0.
    const st = createTraffic(map, PARAMS, 25);
    const before = st.stats.despawned['dead-end'];
    firstPoses(st, map, 240, looking);
    expect(st.stats.despawned['dead-end']).toBeGreaterThan(before);
    // In view, agents stay at the dead end.
    const st2 = createTraffic(map, PARAMS, 25);
    const before2 = st2.stats.despawned['dead-end'];
    firstPoses(st2, map, 240, { ...EGO_AWAY, pos: { x: -40, z: 1.75 } });
    expect(st2.stats.despawned['dead-end']).toBe(before2);
    const deadEnd = /** @type {number} */ (st2.graph.edgeIndex.get('re-e0'));
    expect(st2.edgeCount[deadEnd]).toBeGreaterThan(0);
  }, 60_000);

  it('tests the view cone by angle and range', () => {
    const ego = { x: 0, z: 0, heading: 0, footprint: [], spawnGuard: [] };
    expect(inViewCone(ego, 100, 0, PARAMS)).toBe(true);
    expect(inViewCone(ego, -100, 0, PARAMS)).toBe(false);
    const a = ((PARAMS.viewHalfAngleDeg * Math.PI) / 180) * 0.9;
    expect(inViewCone(ego, 50 * Math.cos(a), -50 * Math.sin(a), PARAMS)).toBe(true);
    expect(inViewCone(ego, 50 * Math.cos(a * 1.2), 50 * Math.sin(a * 1.2), PARAMS)).toBe(false);
    expect(inViewCone(ego, PARAMS.viewRangeM + 100, 0, PARAMS)).toBe(false);
  });
});
