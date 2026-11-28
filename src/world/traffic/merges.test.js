import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { trafficLightStates } from '../signals.js';
import { EGO_PARKED_S, createTraffic, stepTraffic } from './index.js';
import { mergeHeadFirst } from './junctions.js';
import { spawnAgent } from './state.js';
import { lawfulParams } from './lawful-params.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./index.js').EgoInput} EgoInput */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {GameMap} */
const PASTEUR = JSON.parse(readFileSync(new URL('../../../public/maps/osm-pasteur.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const SHIPPED = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
// The lawful population: these suites check how drivers who keep the rules share a junction.
const PARAMS = { ...lawfulParams(SHIPPED), preRollS: 0 };
/** Ego parked off the road south of the west arm, out of every lane and corridor. */
const EGO_AWAY = Object.freeze({ pos: { x: -60, z: 20 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });
/** The ego parked off the road on `osm-pasteur` 70 m from junction n411919193, facing it. */
const PASTEUR_EGO = Object.freeze({ pos: { x: 241.7, z: 172.5 }, heading: Math.PI, speed: 0, lengthM: 4.5, widthM: 1.8 });

/**
 * A map with no spawning.
 * @param {GameMap} source Map.
 * @returns {GameMap} Copy without sources or ring density.
 */
function quiet(source) {
  const map = structuredClone(source);
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
  traffic.sources = [];
  traffic.densityPerKm = {};
  return map;
}

/**
 * Places an agent by its front along a lane, bound for a connector.
 * @param {TrafficState} st State.
 * @param {string} laneId Lane.
 * @param {number} front Front distance along the lane.
 * @param {string} model Model.
 * @param {string} connectorId Next connector.
 * @returns {number} Slot.
 */
function place(st, laneId, front, model, connectorId) {
  const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get(laneId)), front - PARAMS.models[model].lengthM / 2, 0, st.modelKeys.indexOf(model));
  st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get(connectorId));
  return slot;
}

/**
 * Light states with every signal of a map in one state.
 * @param {GameMap} map Map.
 * @param {import('../../contracts/telemetry.js').LightState} state State.
 * @returns {Record<string, import('../../contracts/telemetry.js').LightState>} Lights.
 */
function allLights(map, state) {
  return Object.fromEntries(map.signals.map((s) => [s.id, state]));
}

describe('merges', () => {
  it('marks same-road connectors into one exit lane as a merge, and parallel straights as no conflict', () => {
    const st = createTraffic(quiet(PASTEUR), PARAMS, 1);
    const edges = st.graph.edges;
    let merges = 0;
    for (const a of edges) {
      for (const cf of a.conflicts) {
        const b = edges[cf.other];
        const sameRoad = edges[a.fromEdge].roadIndex === edges[b.fromEdge].roadIndex && a.fromEdge !== b.fromEdge;
        expect(cf.merge, `${a.id} / ${b.id}`).toBe(sameRoad && a.toEdge === b.toEdge);
        if (cf.merge) {
          merges += 1;
          expect(cf.swing).toBe(false);
        }
        // Two straight paths of one road into different exit lanes run side by side.
        if (sameRoad && a.turn === 'straight' && b.turn === 'straight') expect(a.toEdge, `${a.id} / ${b.id}`).toBe(b.toEdge);
      }
    }
    // Pasteur has three such exit lanes: two fed by two lanes, one by three.
    expect(merges).toBe(10);
  });

  it('lets two queues merging into one exit lane take turns until both have discharged', () => {
    const map = quiet(MAP);
    const st = createTraffic(map, PARAMS, 3);
    /** @type {Map<number, string>} */
    const from = new Map();
    for (let i = 0; i < 4; i += 1) {
      from.set(st.spawnIndex[place(st, 'rw-e0', 140 - 6 * i, 'motorbike', 'c-rw-e0-re-e0')], 'rw-e0');
      from.set(st.spawnIndex[place(st, 'rw-e1', 140 - 6 * i, i === 1 ? 'car' : 'motorbike', 'c-rw-e1-re-e0')], 'rw-e1');
    }
    const exit = /** @type {number} */ (st.graph.edgeIndex.get('re-e0'));
    /** @type {string[]} */
    const order = [];
    const lights = allLights(map, 'green');
    for (let i = 0; i < Math.round(40 / DT); i += 1) {
      const t = i * DT;
      stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: [], t });
      for (const [index, lane] of from) {
        const k = st.slotBySpawn.get(index);
        if (k !== undefined && st.edge[k] === exit) {
          order.push(lane);
          from.delete(index);
        }
      }
    }
    expect(order).toHaveLength(8);
    // Neither queue empties before the other has started.
    expect(order.slice(0, 4)).toContain('rw-e0');
    expect(order.slice(0, 4)).toContain('rw-e1');
    expect(st.stats.despawned.wreck).toBe(0);
    for (let i = 0; i < st.activeCount; i += 1) expect(st.wreck[st.active[i]]).toBe(0);
  });

  it('lets the head that has waited longer at the line in before a rider rolling up beside it', () => {
    const map = quiet(MAP);
    const lights = allLights(map, 'green');
    /**
     * A car standing at the head of rw-e1 and a rider on rw-e0, both bound for re-e0.
     * @param {number} carWaitS Time the car has waited at its line.
     * @param {number} riderFront Rider front along rw-e0.
     * @returns {boolean} The rider lets the car in first.
     */
    const riderYields = (carWaitS, riderFront) => {
      const st = createTraffic(map, PARAMS, 3);
      const e = st.graph.edges;
      const carLane = e[/** @type {number} */ (st.graph.edgeIndex.get('rw-e1'))];
      const car = place(st, 'rw-e1', carLane.holdS - 0.3, 'car', 'c-rw-e1-re-e0');
      st.waitS[car] = carWaitS;
      const rider = place(st, 'rw-e0', riderFront, 'motorbike', 'c-rw-e0-re-e0');
      st.v[rider] = 4;
      const conn = /** @type {number} */ (st.graph.edgeIndex.get('c-rw-e0-re-e0'));
      const cf = e[conn].conflicts.find((c) => c.other === st.graph.edgeIndex.get('c-rw-e1-re-e0'));
      expect(cf?.merge).toBe(true);
      return mergeHeadFirst(st, conn, /** @type {import('./lane-graph.js').EdgeConflict} */ (cf), rider, lights);
    };
    const graph = createTraffic(map, PARAMS, 3).graph;
    const hold = graph.edges[/** @type {number} */ (graph.edgeIndex.get('rw-e0'))].holdS;
    // Abreast at the line: the car that has stood there goes first.
    expect(riderYields(10, hold - 0.5)).toBe(true);
    // Abreast, neither has waited: the one nearer the exit lane goes first.
    expect(riderYields(0, hold)).toBe(false);
    // A car clear ahead of a rider still far back goes first too.
    expect(riderYields(0, hold - 20)).toBe(true);
  });

  it('does not hold a bus going straight for riders going straight on the lane beside it', () => {
    /**
     * A bus pulls up at the head of its lane, with or without riders streaming straight through on
     * the parallel lane first.
     * @param {boolean} riders Riders on the lane beside it.
     * @returns {{claimedAt: number, inAt: number}} When the bus claimed its connector and entered
     *   it, in seconds after it was placed.
     */
    const busRun = (riders) => {
      const map = quiet(PASTEUR);
      const st = createTraffic(map, PARAMS, 1);
      const edges = st.graph.edges;
      const busLane = 'w1239028499-411919193-in-f0';
      const riderLane = 'w1239028499-411919193-in-f1';
      const busConn = edges[/** @type {number} */ (st.graph.edgeIndex.get(busLane))].next.find((c) => edges[c].turn === 'straight');
      const riderConn = edges[/** @type {number} */ (st.graph.edgeIndex.get(riderLane))].next.find((c) => edges[c].turn === 'straight');
      expect(busConn).toBeDefined();
      expect(riderConn).toBeDefined();
      const busHold = edges[/** @type {number} */ (st.graph.edgeIndex.get(busLane))].holdS;
      const riderHold = edges[/** @type {number} */ (st.graph.edgeIndex.get(riderLane))].holdS;
      if (riders) for (let i = 0; i < 10; i += 1) place(st, riderLane, riderHold - 0.5 - 5 * i, 'motorbike', edges[/** @type {number} */ (riderConn)].id);
      const lights = allLights(map, 'green');
      const step = (/** @type {number} */ t) => stepTraffic(st, { ego: PASTEUR_EGO, egoReset: false, scripted: [], lights, egoContacts: [], t });
      // The riders claim and stream through first; then a bus pulls up at the head of its lane.
      for (let i = 0; i < Math.round(1 / DT); i += 1) step(i * DT);
      if (riders) expect(st.claimCount[/** @type {number} */ (riderConn)]).toBeGreaterThan(0);
      const bus = place(st, busLane, busHold - 0.5, 'bus', edges[/** @type {number} */ (busConn)].id);
      let claimedAt = Infinity;
      let inAt = Infinity;
      for (let i = 0; i < Math.round(10 / DT) && inAt === Infinity; i += 1) {
        const t = 1 + i * DT;
        step(t);
        if (st.claim[bus] === busConn) claimedAt = Math.min(claimedAt, t - 1);
        if (st.edge[bus] === busConn) inAt = t - 1;
      }
      return { claimedAt, inAt };
    };
    const alone = busRun(false);
    const beside = busRun(true);
    // It claims at once, as with no riders beside it, and drives off from a standstill. The time to
    // reach the junction depends on how far the stop line sits before it (6.5 m behind a zebra at
    // the junction edge), so the bound is against the same bus with no riders: about 4.9 s alone
    // and 6.2 s beside the riders when measured.
    expect(alone.claimedAt).toBeLessThan(0.5);
    expect(beside.claimedAt).toBeLessThan(0.5);
    expect(beside.inAt).toBeLessThanOrEqual(alone.inAt + 2);
  });
});

describe('the handover from the pre-roll', () => {
  it('hands over no wreck, and no time the pre-roll ego stood', () => {
    for (let seed = 1; seed <= 5; seed += 1) {
      const st = createTraffic(PASTEUR, SHIPPED, seed);
      for (let i = 0; i < st.activeCount; i += 1) expect(st.wreck[st.active[i]], `seed ${seed}`).toBe(0);
      expect(st.egoStillS).toBe(0);
    }
  }, 60_000);

  it('closes the lane under a standing ego after EGO_PARKED_S of the run, not counting the pre-roll', () => {
    const map = quiet(MAP);
    const st = createTraffic(map, { ...PARAMS, preRollS: 20 }, 4);
    // The ego stands on the kerb lane of the west arm; a car queues behind it.
    /** @type {EgoInput} */
    const ego = { pos: { x: -60, z: 5.25 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const car = place(st, 'rw-e0', 85, 'car', 'c-rw-e0-re-e0');
    const kerb = st.edge[car];
    let leftAt = Infinity;
    for (let i = 0; i < Math.round(60 / DT) && leftAt === Infinity; i += 1) {
      const t = i * DT;
      stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
      if (st.edge[car] !== kerb || st.crossing[car]) leftAt = t;
    }
    expect(leftAt).toBeGreaterThanOrEqual(EGO_PARKED_S);
    expect(leftAt).toBeLessThan(EGO_PARKED_S + 10);
  });
});
