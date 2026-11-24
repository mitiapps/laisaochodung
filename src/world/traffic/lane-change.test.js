import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { footprint, polygonsIntersect } from '../../geometry/index.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, createWorld, stepTraffic, stepWorld } from './index.js';
import { buildLaneGraph } from './lane-graph.js';
import { SETTLED_M, closedAheadM } from './lane-change.js';
import { trySpawn } from './spawner.js';
import { spawnAgent } from './state.js';
import { lawfulParams } from './lawful-params.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./state.js').TrafficState} TrafficState */

/**
 * Tutorial 03: a one-lane road (`hep`) that widens into two lanes each way (`rong`, joined
 * `hep-f0 → rong-f1` and `rong-b1 → hep-b0`), with the kerb lanes `rong-f0` starting and `rong-b0`
 * ending at the widening, and road works on `rong-f0` at about s = 100.
 * @type {GameMap}
 */
const MAP = JSON.parse(readFileSync(new URL('../../../public/maps/tutorial-03-ban-dem.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
// The lawful population: these suites check what drivers who keep the rules never do.
const PARAMS = lawfulParams(JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8')));
const BARRIER = /** @type {import('../../contracts/map.js').Obstacle} */ (MAP.obstacles.find((o) => o.id === 'ob-barrier')).footprint;
/** Ego parked off the road beside the widening, near enough that no agent under test despawns. */
const EGO_AWAY = Object.freeze({ pos: { x: 220, z: 40 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });

/** @returns {TrafficState} Tutorial 03 traffic with no sources, no ring spawner and no pre-roll. */
function emptyTraffic() {
  const map = structuredClone(MAP);
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
  traffic.sources = [];
  traffic.densityPerKm = {};
  return createTraffic(map, { ...PARAMS, preRollS: 0 }, 1);
}

/**
 * @param {TrafficState} st State.
 * @param {string} laneId Lane.
 * @param {number} s Centre distance.
 * @param {number} speed Speed.
 * @param {string} model Model key.
 * @returns {string} Agent id.
 */
function place(st, laneId, s, speed, model) {
  const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get(laneId)), s, speed, st.modelKeys.indexOf(model));
  return st.ids[slot];
}

/**
 * Steps hand-placed traffic with the ego away and no scripted actors.
 * @param {TrafficState} st State.
 * @param {number} seconds Duration.
 * @param {(poses: ActorPose[], st: TrafficState) => void} visit Called with each step's poses.
 * @returns {void}
 */
function run(st, seconds, visit) {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = i * DT;
    const { poses } = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(st.map, t), egoContacts: [], t });
    visit(poses, st);
  }
}

/**
 * @param {ActorPose} p Pose.
 * @returns {import('../../contracts/telemetry.js').Vec2[]} Footprint.
 */
const fpOf = (p) => footprint(p.pos, p.heading, p.lengthM, p.widthM);

/**
 * @param {ActorPose[]} poses Poses.
 * @returns {string[]} Overlapping `a/b` id pairs.
 */
function overlaps(poses) {
  /** @type {string[]} */
  const out = [];
  const fps = poses.map(fpOf);
  for (let i = 0; i < poses.length; i += 1) {
    for (let j = i + 1; j < poses.length; j += 1) if (polygonsIntersect(fps[i], fps[j])) out.push(`${poses[i].id}/${poses[j].id}`);
  }
  return out;
}

describe('lane graph of a widening road with road works', () => {
  const g = buildLaneGraph(MAP, PARAMS.behaviour);
  const idx = (/** @type {string} */ id) => /** @type {number} */ (g.edgeIndex.get(id));

  it('makes each plain join a lane-to-lane successor', () => {
    expect(g.edges[idx('hep-f0')].next).toEqual([idx('rong-f1')]);
    expect(g.edges[idx('rong-f1')].prev).toContain(idx('hep-f0'));
    expect(g.edges[idx('rong-b1')].next).toEqual([idx('hep-b0')]);
    expect(g.edges[idx('hep-f0')].deadEnd).toBe(false);
    expect(g.edges[idx('rong-b1')].deadEnd).toBe(false);
  });

  it('leaves the taper end of the kerb lane a dead end beside its neighbour', () => {
    expect(g.edges[idx('rong-b0')].deadEnd).toBe(true);
    expect(g.edges[idx('rong-b0')].neighbours).toEqual([idx('rong-b1')]);
    expect(g.edges[idx('rong-f0')].neighbours).toEqual([idx('rong-f1')]);
    expect(g.edges[idx('hep-f0')].neighbours).toEqual([]);
  });

  it('turns the barrier, and no building, into a blocked stretch of the kerb lane', () => {
    expect(g.staticObstacles).toHaveLength(1);
    const blocks = g.edges[idx('rong-f0')].blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fromS).toBeCloseTo(98.5, 6);
    expect(blocks[0].toS).toBeCloseTo(101.5, 6);
    expect(g.edges[idx('rong-f1')].blocks).toEqual([]);
  });
});

describe('traffic on a widening road with road works', () => {
  it('runs straight on through a plain join without slowing for it', () => {
    const st = emptyTraffic();
    const id = place(st, 'hep-f0', 150, 10, 'car');
    let minSpeed = Infinity;
    let joined = false;
    run(st, 15, (poses) => {
      const p = poses.find((q) => q.id === id);
      if (!p) return;
      if (p.pos.x > 200 && p.pos.x < 240) minSpeed = Math.min(minSpeed, p.speed);
      if (p.pos.x > 230) joined = true;
    });
    expect(joined).toBe(true);
    expect(minSpeed).toBeGreaterThan(8);
  });

  it('takes a motorbike, a car and a bus around the barrier without touching it', () => {
    const st = emptyTraffic();
    const ids = [place(st, 'rong-f0', 60, 8, 'motorbike'), place(st, 'rong-f0', 40, 8, 'car'), place(st, 'rong-f0', 15, 6, 'bus')];
    /** @type {Map<string, number>} */
    const maxX = new Map();
    /** @type {string[]} */
    const touched = [];
    /** @type {string[]} */
    const pairs = [];
    run(st, 60, (poses) => {
      for (const p of poses) {
        maxX.set(p.id, Math.max(maxX.get(p.id) ?? -Infinity, p.pos.x));
        if (polygonsIntersect(fpOf(p), BARRIER)) touched.push(p.id);
      }
      pairs.push(...overlaps(poses));
    });
    expect(touched).toEqual([]);
    expect(pairs).toEqual([]);
    for (const id of ids) expect(maxX.get(id)).toBeGreaterThan(330);
  });

  it('merges out of the taper lane before it ends and keeps to the road after the join', () => {
    const st = emptyTraffic();
    const ids = [place(st, 'rong-b0', 200, 8, 'car'), place(st, 'rong-b0', 230, 7, 'motorbike'), place(st, 'rong-b1', 240, 8, 'car')];
    /** @type {Map<string, number>} */
    const minX = new Map();
    /** @type {string[]} */
    const offRoad = [];
    /** @type {string[]} */
    const pairs = [];
    run(st, 40, (poses) => {
      for (const p of poses) {
        minX.set(p.id, Math.min(minX.get(p.id) ?? Infinity, p.pos.x));
        // West of the widening only the one westbound lane of `hep` is road: z in [−3.5, 0].
        if (p.pos.x < 218 && (p.pos.z < -3.5 || p.pos.z > 0)) offRoad.push(p.id);
      }
      pairs.push(...overlaps(poses));
    });
    expect(offRoad).toEqual([]);
    expect(pairs).toEqual([]);
    for (const id of ids) expect(minX.get(id)).toBeLessThan(150);
  });

  it('settles at its usual offset after the lane change and reports no closed lane ahead', () => {
    const st = emptyTraffic();
    const id = place(st, 'rong-f0', 60, 8, 'motorbike');
    const slot = /** @type {number} */ (st.slotBySpawn.get(Number(id.slice(4))));
    expect(closedAheadM(st, slot)).toBeCloseTo(98.5 - 60 - st.lengthM[slot] / 2, 6);
    run(st, 12, () => {});
    expect(st.graph.edges[st.edge[slot]].id).not.toBe('rong-f0');
    expect(Math.abs(st.lateral[slot] - st.lateralBase[slot])).toBeLessThanOrEqual(SETTLED_M);
    expect(closedAheadM(st, slot)).toBe(Infinity);
  });

  it('waits for an ego coming up the target lane instead of pulling out in front of it', () => {
    const st = emptyTraffic();
    const id = place(st, 'rong-f0', 92, 0, 'car');
    const slot = /** @type {number} */ (st.slotBySpawn.get(Number(id.slice(4))));
    const laneStartX = 220;
    let egoS = 78;
    let gapAtChange = null;
    /** @type {string[]} */
    const touched = [];
    for (let i = 0; i < Math.round(12 / DT); i += 1) {
      const t = i * DT;
      const ego = { pos: { x: laneStartX + egoS, z: 1.75 }, heading: 0, speed: 10, lengthM: 4.5, widthM: 1.8 };
      const { poses } = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: {}, egoContacts: [], t });
      if (gapAtChange === null && st.graph.edges[st.edge[slot]].id === 'rong-f1') {
        // Gap from the ego's front to the agent's rear; negative once the ego has gone past.
        gapAtChange = st.s[slot] - st.lengthM[slot] / 2 - (egoS + ego.lengthM / 2);
      }
      const egoFp = footprint(ego.pos, ego.heading, ego.lengthM, ego.widthM);
      for (const p of poses) if (polygonsIntersect(fpOf(p), egoFp)) touched.push(p.id);
      egoS += 10 * DT;
    }
    expect(gapAtChange).not.toBeNull();
    expect(/** @type {number} */ (gapAtChange) < -4.5 || /** @type {number} */ (gapAtChange) >= 15).toBe(true);
    expect(touched).toEqual([]);
  });

  it('gives equal traffic for the same seed with lane changes, joins and parked actors', () => {
    const ego = { pos: { x: 200, z: 9 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const once = () => {
      let w = createWorld(MAP, { traffic: 'map', params: PARAMS, runSeed: 3 });
      /** @type {string[]} */
      const out = [];
      for (let i = 0; i < Math.round(30 / DT); i += 1) {
        const t = i * DT;
        const r = stepWorld(w, { ego, egoReset: false, lights: trafficLightStates(MAP, t), egoContacts: [], t });
        w = r.worldState;
        if (i % 30 === 0) out.push(JSON.stringify(r.trafficPoses));
      }
      return out;
    };
    expect(once()).toEqual(once());
  }, 30_000);

  it('never spawns on the barrier, and spawns before it slow enough to stop', () => {
    const st = emptyTraffic();
    const lane = /** @type {number} */ (st.graph.edgeIndex.get('rong-f0'));
    const ego = { x: EGO_AWAY.pos.x, z: EGO_AWAY.pos.z, heading: 0, footprint: [], spawnGuard: footprint(EGO_AWAY.pos, 0, 1, 1) };
    const car = st.modelKeys.indexOf('car');
    expect(trySpawn(st, lane, 100, car, ego, [], st.activeCount)).toBe(-1);
    expect(trySpawn(st, lane, 95, car, ego, [], st.activeCount)).toBe(-1);
    const slot = trySpawn(st, lane, 80, car, ego, [], st.activeCount);
    expect(slot).toBeGreaterThanOrEqual(0);
    const room = 98.5 - (80 + st.lengthM[slot] / 2);
    expect((st.v[slot] * st.v[slot]) / (2 * st.decelComfort[slot])).toBeLessThanOrEqual(room);
  });
});

// The acceptance run is 10 minutes per seed with the whole driver population; the default suite
// runs 3 minutes, which still cover many agents through the taper, the join and the sinks. Set
// TRAFFIC_LONG=1 to run the full 10 minutes.
const { env } = process;
const ACCEPTANCE_S = env.TRAFFIC_LONG ? 600 : 180;
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const FULL_PARAMS = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));

describe('tutorial 03 traffic with the ego parked at the route start', () => {
  const ego = { pos: { ...MAP.route.start.pos }, heading: MAP.route.start.heading, speed: 0, lengthM: 4.5, widthM: 1.8 };

  it.each([1, 2, 3, 4, 5])(`keeps moving and off the barrier for ${ACCEPTANCE_S / 60} minutes, seed %i`, (seed) => {
    let w = createWorld(MAP, { traffic: 'map', params: FULL_PARAMS, runSeed: seed });
    let stillSince = -1;
    let worstStill = 0;
    /** @type {string[]} */
    const touched = [];
    for (let i = 0; i < Math.round(ACCEPTANCE_S / DT); i += 1) {
      const t = i * DT;
      const r = stepWorld(w, { ego, egoReset: false, lights: trafficLightStates(MAP, t), egoContacts: [], t });
      w = r.worldState;
      const poses = r.trafficPoses;
      if (poses.length > 0 && poses.every((p) => p.speed < 0.1)) {
        if (stillSince < 0) stillSince = t;
        worstStill = Math.max(worstStill, t - stillSince);
      } else stillSince = -1;
      for (const p of poses) if (polygonsIntersect(fpOf(p), BARRIER)) touched.push(p.id);
    }
    expect(worstStill).toBeLessThanOrEqual(30);
    expect(touched).toEqual([]);
  }, 300_000);
});
