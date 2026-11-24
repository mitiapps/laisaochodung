import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../../contracts/telemetry.js';
import { DT } from '../../contracts/units.js';
import { checkTrafficParams } from '../../contracts/traffic.js';
import { footprint, polygonsIntersect } from '../../geometry/index.js';
import { createActorState, stepActors } from '../actors.js';
import { trafficLightStates } from '../signals.js';
import { RESET_CLEAR_MARGIN_M, createTraffic, createWorld, stepTraffic, stepWorld } from './index.js';
import { spawnAgent } from './state.js';
import { lawfulParams } from './lawful-params.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./index.js').EgoInput} EgoInput */
/** @typedef {import('./state.js').TrafficState} TrafficState */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
// The lawful population: these suites check what drivers who keep the rules never do.
const PARAMS = lawfulParams(JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8')));
const LIGHTS = Object.values(ACTOR_LIGHTS);

/** Ego parked off the road south of the west arm, out of every lane and corridor. */
const EGO_AWAY = Object.freeze({ pos: { x: -60, z: 20 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });

/**
 * A copy of the junction map with no sources and no ring spawner, for hand-placed agents.
 * @returns {GameMap} Map.
 */
function emptyMap() {
  const map = structuredClone(MAP);
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
  traffic.sources = [];
  traffic.densityPerKm = {};
  return map;
}

/** @returns {import('../../contracts/traffic.js').TrafficParams} Params without a pre-roll. */
function noPreRoll() {
  return { ...PARAMS, preRollS: 0 };
}

/**
 * Places an agent on a lane, heading for a connector.
 * @param {TrafficState} st State.
 * @param {string} laneId Lane.
 * @param {number} s Centre distance.
 * @param {number} speed Speed.
 * @param {string} model Model key.
 * @param {string} [connectorId] Next connector; the drawn route otherwise.
 * @returns {number} Slot.
 */
function place(st, laneId, s, speed, model, connectorId) {
  const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get(laneId)), s, speed, st.modelKeys.indexOf(model));
  if (connectorId) st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get(connectorId));
  return slot;
}

/**
 * Steps traffic from `t0` for `seconds`.
 * @param {TrafficState} st State.
 * @param {GameMap} map Map.
 * @param {number} t0 Start time.
 * @param {number} seconds Duration.
 * @param {(t: number) => Partial<import('./index.js').TrafficStepInput>} [extra] Per-step input.
 * @param {(poses: ActorPose[], t: number) => void} [visit] Called with each step's poses.
 * @returns {ActorPose[]} Last poses.
 */
function run(st, map, t0, seconds, extra, visit) {
  /** @type {ActorPose[]} */
  let poses = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i += 1) {
    const t = t0 + i * DT;
    const input = { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t, ...(extra ? extra(t) : {}) };
    poses = stepTraffic(st, input).poses;
    if (visit) visit(poses, t);
  }
  return poses;
}

/**
 * @param {{pos: {x: number, z: number}, heading: number, lengthM: number, widthM: number}} p Pose.
 * @returns {import('../../contracts/telemetry.js').Vec2[]} Footprint.
 */
const fpOf = (p) => footprint(p.pos, p.heading, p.lengthM, p.widthM);

/**
 * Pairs of overlapping footprints.
 * @param {ActorPose[]} poses Poses.
 * @returns {string[]} `a/b` id pairs.
 */
function overlaps(poses) {
  /** @type {string[]} */
  const out = [];
  const fps = poses.map(fpOf);
  for (let i = 0; i < poses.length; i += 1) {
    for (let j = i + 1; j < poses.length; j += 1) {
      const a = poses[i].pos;
      const b = poses[j].pos;
      if (Math.abs(a.x - b.x) > 12 || Math.abs(a.z - b.z) > 12) continue;
      if (polygonsIntersect(fps[i], fps[j])) out.push(`${poses[i].id}/${poses[j].id}`);
    }
  }
  return out;
}

describe('traffic over 10 minutes on the junction fixture', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  /** @type {{seed: number, overlaps: string[], redCrossings: string[], maxAgents: number, sunk: number}[]} */
  const results = [];

  beforeAll(() => {
    expect(checkTrafficParams(PARAMS)).toEqual([]);
    const signalLanes = new Set(MAP.stopLines.filter((l) => l.control === 'signal').flatMap((l) => l.laneIds));
    for (const seed of SEEDS) {
      const st = createTraffic(MAP, PARAMS, seed);
      const r = { seed, overlaps: /** @type {string[]} */ ([]), redCrossings: /** @type {string[]} */ ([]), maxAgents: 0, sunk: 0 };
      const steps = Math.round(600 / DT);
      for (let i = 0; i < steps; i += 1) {
        const t = i * DT;
        const lights = trafficLightStates(MAP, t);
        // Front positions before the step, for agents approaching a signal.
        /** @type {Map<number, {edge: number, front: number}>} */
        const before = new Map();
        for (let a = 0; a < st.activeCount; a += 1) {
          const k = st.active[a];
          const e = st.graph.edges[st.edge[k]];
          if (signalLanes.has(e.id)) before.set(st.spawnIndex[k], { edge: e.index, front: st.s[k] + st.lengthM[k] / 2 });
        }
        const { poses } = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [], t });
        r.maxAgents = Math.max(r.maxAgents, poses.length);
        for (const [index, b] of before) {
          const k = st.slotBySpawn.get(index);
          if (k === undefined) continue;
          const e = st.graph.edges[b.edge];
          const light = lights[MAP.signals[e.signalIndex].id];
          // Onto the connector, or past the line on the same lane (a lane change is not a crossing).
          const onto = st.edge[k] !== b.edge && st.graph.edges[st.edge[k]].kind === 'connector';
          const crossed = b.front <= e.holdS && (onto || (st.edge[k] === b.edge && st.s[k] + st.lengthM[k] / 2 > e.holdS));
          if (crossed && light === 'red') r.redCrossings.push(`npc-${index}@${t.toFixed(2)}`);
        }
        if (i % 6 === 0) r.overlaps.push(...overlaps(poses).map((p) => `${p}@${t.toFixed(2)}`));
      }
      r.sunk = st.stats.despawned.sink;
      results.push(r);
    }
  }, 300_000);

  it('never overlaps two footprints (10 seeds)', () => {
    for (const r of results) expect(r.overlaps, `seed ${r.seed}`).toEqual([]);
  });

  it('never lets a front pass a red stop line (10 seeds)', () => {
    for (const r of results) expect(r.redCrossings, `seed ${r.seed}`).toEqual([]);
  });

  it('keeps traffic flowing through the junction', () => {
    for (const r of results) {
      expect(r.maxAgents).toBeGreaterThan(20);
      expect(r.sunk).toBeGreaterThan(100);
    }
  });
});

describe('poses', () => {
  it('fill every ActorPose field with shared lamps and shared flag lists, in spawn order', () => {
    const st = createTraffic(MAP, PARAMS, 42);
    const poses = run(st, MAP, 0, 5);
    expect(poses.length).toBeGreaterThan(5);
    let last = -1;
    for (const p of poses) {
      const index = Number(p.id.slice(4));
      expect(p.id).toMatch(/^npc-\d+$/);
      expect(index).toBeGreaterThan(last);
      last = index;
      expect(['car', 'motorbike']).toContain(p.kind);
      expect(Object.keys(PARAMS.models)).toContain(p.model);
      expect(p.kind).toBe(PARAMS.models[p.model].kind);
      expect(p.variant).toBeGreaterThanOrEqual(0);
      expect(p.variant).toBeLessThan(PARAMS.models[p.model].variants);
      expect(p.lengthM).toBe(PARAMS.models[p.model].lengthM);
      expect(p.widthM).toBe(PARAMS.models[p.model].widthM);
      expect(LIGHTS).toContain(p.lights);
      // Lawful drivers raise no flag except no-yield, which an agent going by the deadlock breaker
      // carries as a fact; every list is a shared frozen one.
      expect(Object.isFrozen(p.violations)).toBe(true);
      expect(p.violations.filter((f) => f !== 'no-yield')).toEqual([]);
      if (p.violations.length === 0) expect(p.violations).toBe(NO_VIOLATIONS);
      expect(p.active).toBe(true);
      expect(p.state).toBe(p.speed > 0 ? 'moving' : 'stopped');
      expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z) && Number.isFinite(p.heading)).toBe(true);
    }
  });

  it('light the brake lamps of a queue at red and the indicator before a turn', () => {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 1);
    // West lights are red from t = 30 to 60.
    place(st, 'rw-e1', 120, 8, 'car', 'c-rw-e1-rn-n');
    const poses = run(st, map, 30, 15);
    const p = /** @type {ActorPose} */ (poses[0]);
    expect(p.speed).toBe(0);
    expect(p.lights).toBe(ACTOR_LIGHTS['brake-left']);
  });

  it('use the braking limit times rainDecelFactor in rain', () => {
    const map = emptyMap();
    map.environment.weather = 'rain';
    const st = createTraffic(map, noPreRoll(), 1);
    const k = place(st, 'rw-e1', 20, 5, 'car');
    expect(st.decelMax[k]).toBeCloseTo(PARAMS.classes.car.maxDecelMps2 * PARAMS.behaviour.rainDecelFactor, 9);
  });
});

describe('ego perception', () => {
  /**
   * Runs one agent on `rw-e1` towards a stopped ego and returns its last pose and any overlap.
   * @param {EgoInput} ego Ego.
   * @param {number} s Agent start along `rw-e1`.
   * @param {string} model Model.
   * @param {number} t0 Start time.
   * @returns {{pose: ActorPose, touched: boolean}} Result.
   */
  function approach(ego, s, model, t0) {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 3);
    place(st, 'rw-e1', s, 10, model, 'c-rw-e1-re-e0');
    const egoFp = fpOf(ego);
    let touched = false;
    const poses = run(st, map, t0, 20, () => ({ ego }), (ps) => {
      for (const p of ps) if (polygonsIntersect(fpOf(p), egoFp)) touched = true;
    });
    return { pose: /** @type {ActorPose} */ (poses[0]), touched };
  }

  for (const model of ['car', 'motorbike', 'bus']) {
    it(`stops a ${model} behind a stopped ego in its lane, across a lane line and on the wrong side`, () => {
      for (const ego of [
        { pos: { x: -80, z: 1.75 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 },
        { pos: { x: -80, z: 3.5 }, heading: 0.1, speed: 0, lengthM: 4.5, widthM: 1.8 },
        { pos: { x: -80, z: 1.75 }, heading: Math.PI, speed: 0, lengthM: 1.9, widthM: 0.8 },
      ]) {
        const { pose, touched } = approach(ego, 20, model, 0);
        expect(touched).toBe(false);
        expect(pose.speed).toBe(0);
        expect(pose.pos.x + pose.lengthM / 2).toBeLessThan(-80 - 0.4);
        expect(pose.pos.x + pose.lengthM / 2).toBeGreaterThan(-80 - 12);
      }
    });
  }

  it('stops an agent inside the junction for an ego standing across its path', () => {
    const ego = { pos: { x: 2, z: 1.75 }, heading: Math.PI / 2, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const { pose, touched } = approach(ego, 120, 'car', 0);
    expect(touched).toBe(false);
    expect(pose.speed).toBe(0);
    expect(pose.pos.x).toBeLessThan(2);
  });

  it('follows a slow ego instead of stopping', () => {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 3);
    place(st, 'rw-e1', 10, 10, 'car', 'c-rw-e1-re-e0');
    let x = -110;
    let minGap = Infinity;
    const poses = run(st, map, 0, 8, () => ({ ego: { pos: { x, z: 1.75 }, heading: 0, speed: 4, lengthM: 4.5, widthM: 1.8 } }), (ps) => {
      x += 4 * DT;
      minGap = Math.min(minGap, x - 2.25 - (ps[0].pos.x + ps[0].lengthM / 2));
    });
    expect(minGap).toBeGreaterThan(1);
    expect(poses[0].speed).toBeGreaterThan(2);
    expect(poses[0].speed).toBeLessThan(6);
  });

  it('stops for a scripted pedestrian on a crossing, perceived exactly', () => {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 3);
    place(st, 'rw-e1', 30, 10, 'motorbike', 'c-rw-e1-re-e0');
    /** @type {ActorPose} */
    const ped = {
      id: 'ped-1',
      kind: 'pedestrian',
      pos: { x: -70, z: 2.2 },
      heading: Math.PI / 2,
      speed: 0,
      active: true,
      model: 'pedestrian',
      variant: 0,
      lengthM: 0.5,
      widthM: 0.5,
      lights: ACTOR_LIGHTS.off,
      state: 'stopped',
      violations: NO_VIOLATIONS,
    };
    let touched = false;
    const poses = run(st, map, 0, 15, () => ({ scripted: [ped] }), (ps) => {
      if (polygonsIntersect(fpOf(ps[0]), fpOf(ped))) touched = true;
    });
    expect(touched).toBe(false);
    expect(poses[0].speed).toBe(0);
    expect(poses[0].pos.x).toBeLessThan(-70);
  });
});

describe('ego reset and contacts', () => {
  it('clears every agent overlapping the inflated ego footprint on reset', () => {
    const st = createTraffic(MAP, PARAMS, 11);
    const before = run(st, MAP, 0, 10);
    const target = /** @type {ActorPose} */ (before.find((p) => p.pos.x > -100 && p.pos.x < -20));
    expect(target).toBeDefined();
    const ego = { pos: { ...target.pos }, heading: target.heading, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const guard = footprint(ego.pos, ego.heading, ego.lengthM + 2 * RESET_CLEAR_MARGIN_M, ego.widthM + 2 * RESET_CLEAR_MARGIN_M);
    const reset = st.stats.despawned.reset;
    const t = 10;
    const { poses } = stepTraffic(st, { ego, egoReset: true, scripted: [], lights: trafficLightStates(MAP, t), egoContacts: [], t });
    expect(st.stats.despawned.reset).toBeGreaterThan(reset);
    for (const p of poses) expect(polygonsIntersect(fpOf(p), guard), p.id).toBe(false);
  });

  it('turns the named agent into a wreck with speed 0 on the next step, and followers stop behind it', () => {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 5);
    const k = place(st, 'rw-e1', 60, 10, 'car', 'c-rw-e1-re-e0');
    place(st, 'rw-e1', 30, 10, 'car', 'c-rw-e1-re-e0');
    run(st, map, 0, 1);
    const id = st.ids[k];
    const wreckPos = { x: st.x[k], z: st.z[k] };
    const step = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(map, 1), egoContacts: ['someone-else', id], t: 1 });
    const wreck = /** @type {ActorPose} */ (step.poses.find((p) => p.id === id));
    expect(wreck.speed).toBe(0);
    expect(wreck.state).toBe('crashed');
    expect(wreck.lights).toBe(ACTOR_LIGHTS.hazard);
    expect(wreck.pos.x).toBeCloseTo(wreckPos.x, 9);
    expect(step.incidents).toEqual([]);
    const later = run(st, map, 1 + DT, 10);
    const w = /** @type {ActorPose} */ (later.find((p) => p.id === id));
    const f = /** @type {ActorPose} */ (later.find((p) => p.id !== id));
    expect(w.pos.x).toBeCloseTo(wreckPos.x, 9);
    // The follower either stands behind the wreck or has changed lane to pass it, never touching it.
    expect(polygonsIntersect(fpOf(f), fpOf(w))).toBe(false);
    if (Math.abs(f.pos.z - w.pos.z) < 1) {
      expect(f.speed).toBe(0);
      expect(f.pos.x + f.lengthM / 2).toBeLessThan(w.pos.x - w.lengthM / 2);
    }
  });

  it('frees the junction claim of an agent wrecked before the stop line', () => {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 5);
    // West green: the car claims its connector on the approach.
    const k = place(st, 'rw-e1', 130, 8, 'car', 'c-rw-e1-re-e0');
    run(st, map, 0, 0.5);
    expect(st.claim[k]).toBe(st.graph.edgeIndex.get('c-rw-e1-re-e0'));
    expect(st.graph.edges[st.edge[k]].id).toBe('rw-e1');
    stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(map, 0.5), egoContacts: [st.ids[k]], t: 0.5 });
    expect(st.wreck[k]).toBe(1);
    expect(st.claim[k]).toBe(-1);
  });

  it('clears a wreck after wreckClearS', () => {
    const map = emptyMap();
    const st = createTraffic(map, noPreRoll(), 5);
    const k = place(st, 'rw-e1', 60, 0, 'motorbike');
    const id = st.ids[k];
    const at = (/** @type {number} */ t) => ({ egoContacts: t === 0 ? [id] : [] });
    run(st, map, 0, PARAMS.wreckClearS - 1, at);
    expect(st.slotBySpawn.has(0)).toBe(true);
    expect(st.wreck[k]).toBe(1);
    run(st, map, PARAMS.wreckClearS - 1, 2);
    expect(st.slotBySpawn.has(0)).toBe(false);
    expect(st.stats.despawned.wreck).toBe(1);
  });
});

describe('stepWorld', () => {
  const ego = { pos: { x: -150, z: 1.75 }, heading: 0, speed: 3, lengthM: 4.5, widthM: 1.8 };

  it('equals stepActors exactly with traffic off', () => {
    const map = /** @type {GameMap} */ (JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-minimal.json', import.meta.url), 'utf8')));
    let world = createWorld(map, { traffic: 'off' });
    let actors = createActorState(map);
    for (let i = 0; i < 600; i += 1) {
      const t = i * DT;
      const w = stepWorld(world, { ego, egoReset: false, lights: trafficLightStates(map, t), egoContacts: [], t });
      const a = stepActors(actors, map, [footprint(ego.pos, ego.heading, ego.lengthM, ego.widthM)], 3, DT);
      expect(w.scriptedPoses).toEqual(a.poses);
      expect(w.trafficPoses).toEqual([]);
      world = w.worldState;
      actors = a.state;
    }
    expect(world.traffic).toBeNull();
  });

  it('runs no traffic on a map without a traffic block even when asked', () => {
    const map = structuredClone(MAP);
    delete map.traffic;
    expect(createWorld(map, { traffic: 'map', params: PARAMS }).traffic).toBeNull();
    expect(() => createWorld(MAP, { traffic: 'map' })).toThrow(/params/);
  });

  it('steps scripted actors, held by traffic agents, then traffic', () => {
    const map = emptyMap();
    // A scripted pedestrian crossing rw-e1 at x = -60 from t = 0.
    map.actors = [
      {
        id: 'ped-x',
        kind: 'pedestrian',
        model: 'pedestrian',
        lengthM: 0.5,
        widthM: 0.5,
        path: [
          [-60, 9],
          [-60, -9],
        ],
        speed: 1.2,
        trigger: { atS: 0 },
        loop: false,
      },
    ];
    let world = createWorld(map, { traffic: 'map', params: noPreRoll(), runSeed: 9 });
    const st = /** @type {TrafficState} */ (world.traffic);
    // A stopped car standing in the pedestrian's path holds it.
    place(st, 'rw-e0', 97, 0, 'car');
    st.wreck[0] = 1;
    let pedHeld = false;
    for (let i = 0; i < 600; i += 1) {
      const t = i * DT;
      const w = stepWorld(world, { ego: EGO_AWAY, egoReset: false, lights: trafficLightStates(map, t), egoContacts: [], t });
      expect(w.trafficPoses.map((p) => p.id)).toEqual(['npc-0']);
      if (w.scriptedPoses[0].active && w.scriptedPoses[0].speed === 0) pedHeld = true;
      world = w.worldState;
    }
    expect(pedHeld).toBe(true);
  });
});
