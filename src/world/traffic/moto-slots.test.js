import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { footprint, polygonsIntersect } from '../../geometry/index.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';
import { lawfulParams } from './lawful-params.js';
import { pathBlocked } from './moto-slots.js';
import { spawnAgent } from './state.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('./state.js').TrafficState} TrafficState */

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
  st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get(laneId === 'rw-e1' ? 'c-rw-e1-re-e0' : 'c-rw-e0-re-e0'));
  return slot;
}

/**
 * @param {TrafficState} st State.
 * @param {GameMap} map Map.
 * @param {number} seconds Duration.
 * @param {(t: number) => Record<string, import('../../contracts/telemetry.js').LightState>} lights Lights.
 * @returns {void}
 */
function run(st, map, seconds, lights) {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = i * DT;
    stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: lights(t), egoContacts: [], t });
  }
}

/**
 * @param {GameMap} map Map.
 * @param {'red' | 'green'} state Every light.
 * @returns {Record<string, import('../../contracts/telemetry.js').LightState>} Light states.
 */
const allLights = (map, state) => Object.fromEntries(map.signals.map((s) => [s.id, state]));

describe('motorbike slots', () => {
  it('keeps riders right of the lane centre on average', () => {
    const st = createTraffic(MAP, LAWFUL, 21);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < Math.round(120 / DT); i += 1) {
      const t = i * DT;
      stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(MAP, t), egoContacts: [], t });
      if (i % 30) continue;
      for (let a = 0; a < st.activeCount; a += 1) {
        const k = st.active[a];
        if (!st.isMoto[k] || st.graph.edges[st.edge[k]].kind !== 'lane') continue;
        sum += st.lateral[k];
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(sum / n).toBeLessThan(-0.2);
  });

  it('filters past a stopped car in its lane without touching it', () => {
    const map = emptyMap();
    // The wreck stands in for a broken-down car, so it must outlast the run.
    const st = createTraffic(map, { ...LAWFUL, wreckClearS: 60 }, 22);
    const car = place(st, 'rw-e1', 80, 0, 'car');
    // A car broken down in the lane: it never moves again.
    st.wreck[car] = 1;
    st.wreckT[car] = 0;
    const bike = place(st, 'rw-e1', 40, 6, 'motorbike');
    let touched = false;
    // Within wreckClearS, while the car still stands there.
    for (let i = 0; i < Math.round(18 / DT); i += 1) {
      const t = i * DT;
      stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: allLights(map, 'green'), egoContacts: [], t });
      const a = footprint({ x: st.x[car], z: st.z[car] }, st.heading[car], st.lengthM[car], st.widthM[car]);
      const b = footprint({ x: st.x[bike], z: st.z[bike] }, st.heading[bike], st.lengthM[bike], st.widthM[bike]);
      if (polygonsIntersect(a, b)) touched = true;
    }
    expect(touched).toBe(false);
    expect(st.wreck[bike]).toBe(0);
    // Past the car: on to the junction or beyond the car along the lane.
    const past = st.edge[bike] !== st.edge[car] || st.s[bike] - st.lengthM[bike] / 2 > st.s[car] + st.lengthM[car] / 2;
    expect(past).toBe(true);
  });

  it('stops at least four riders side by side within 6 m of a red stop line, in one lane', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 23);
    // Eight riders in single file in one lane.
    for (let i = 0; i < 8; i += 1) place(st, 'rw-e1', 70 - 4 * i, 8, 'motorbike');
    run(st, map, 25, () => allLights(map, 'red'));
    const lane = st.graph.edges[/** @type {number} */ (st.graph.edgeIndex.get('rw-e1'))];
    const near = [];
    for (let a = 0; a < st.activeCount; a += 1) {
      const k = st.active[a];
      const front = st.s[k] + st.lengthM[k] / 2;
      if (st.edge[k] === lane.index && st.v[k] < 0.1 && lane.holdS - front < 6 && lane.holdS - front > -0.5) near.push(k);
    }
    expect(near.length).toBeGreaterThanOrEqual(4);
    // Side by side: their offsets spread across the lane.
    const lats = near.map((k) => st.lateral[k]).sort((a, b) => a - b);
    expect(lats[lats.length - 1] - lats[0]).toBeGreaterThan(0.8);
  });
});

describe('a car moving across that the rider holds', () => {
  /**
   * A car moving across from the right into the rider's lane at a standstill, its left side
   * already over the rider's line, and a rider stopped alongside it, its body in the car's way.
   * @returns {{st: TrafficState, car: number, bike: number}} State and slots.
   */
  const alongside = () => {
    const st = createTraffic(emptyMap(), LAWFUL, 24);
    const car = place(st, 'rw-e1', 80, 0, 'car');
    st.lateral[car] = -1.41;
    st.lateralBase[car] = 0;
    st.crossing[car] = 1;
    const bike = place(st, 'rw-e1', 78.6, 0, 'motorbike');
    st.lateral[bike] = -0.15;
    st.lateralBase[bike] = -0.15;
    return { st, car, bike };
  };

  it('keeps the rider out of the car\'s target while the car could still move', () => {
    const { st, bike } = alongside();
    expect(pathBlocked(st, bike, 0.45)).toBe(true);
  });

  it('lets the rider edge away from a car its body holds, but not towards it', () => {
    const { st, car, bike } = alongside();
    st.heldBy[car] = bike;
    expect(pathBlocked(st, bike, 0.45)).toBe(false);
    expect(pathBlocked(st, bike, -0.45)).toBe(true);
  });
});

describe('a standing ego in the path of a turn', () => {
  // The ego came south on `rn-s` and stopped with its nose 6 m inside the box, across the path of
  // the left turn from `rw-e1` into `rn-n`.
  const EGO_IN_BOX = Object.freeze({ pos: { x: -1.75, z: -3.25 }, heading: -Math.PI / 2, speed: 0, lengthM: 4.5, widthM: 1.8 });
  const egoFoot = footprint(EGO_IN_BOX.pos, EGO_IN_BOX.heading, EGO_IN_BOX.lengthM, EGO_IN_BOX.widthM);

  /**
   * Places an agent on `rw-e1` heading for the left turn.
   * @param {TrafficState} st State.
   * @param {number} s Centre distance.
   * @param {string} model Model.
   * @returns {number} Slot.
   */
  const turner = (st, s, model) => {
    const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get('rw-e1')), s, 5, st.modelKeys.indexOf(model));
    st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get('c-rw-e1-rn-n'));
    return slot;
  };

  /**
   * Runs the turn with the ego standing in the box from t 0, westbound green.
   * @param {string} model Model of the turning agent.
   * @returns {{entered: number, cleared: number, touched: boolean, onConnector: boolean}} When the
   *   agent entered and left the connector (Infinity if never), whether it touched the ego, and
   *   whether it is still on the connector at the end.
   */
  const turnPastEgo = (model) => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 31);
    const k = turner(st, 130, model);
    const conn = /** @type {number} */ (st.graph.edgeIndex.get('c-rw-e1-rn-n'));
    let entered = Infinity;
    let cleared = Infinity;
    let touched = false;
    for (let i = 0; i < Math.round(25 / DT); i += 1) {
      const t = i * DT;
      stepTraffic(st, { ego: EGO_IN_BOX, egoReset: false, scripted: [], lights: allLights(map, 'green'), egoContacts: [], t });
      if (st.edge[k] === conn && entered === Infinity) entered = t;
      if (entered < Infinity && st.edge[k] !== conn && cleared === Infinity) cleared = t;
      if (polygonsIntersect(egoFoot, footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k], st.widthM[k]))) touched = true;
    }
    return { entered, cleared, touched, onConnector: st.edge[k] === conn };
  };

  it('lets a rider on the connector go round it within 10 s, without touching it', () => {
    const r = turnPastEgo('motorbike');
    expect(r.entered).toBeLessThan(10);
    expect(r.cleared - r.entered).toBeLessThan(10);
    expect(r.touched).toBe(false);
  });

  it('keeps a car on the connector waiting behind it', () => {
    const r = turnPastEgo('car');
    expect(r.entered).toBeLessThan(10);
    expect(r.cleared).toBe(Infinity);
    expect(r.onConnector).toBe(true);
    expect(r.touched).toBe(false);
  });

  it('leaves the rider waiting while the ego has stood only briefly', () => {
    const map = emptyMap();
    const st = createTraffic(map, LAWFUL, 31);
    const k = turner(st, 130, 'motorbike');
    const conn = /** @type {number} */ (st.graph.edgeIndex.get('c-rw-e1-rn-n'));
    // The ego creeps forward and stops again every 2 s, so it never stands long enough.
    let lateralOnConnector = Number.NaN;
    for (let i = 0; i < Math.round(15 / DT); i += 1) {
      const t = i * DT;
      const creeping = i % Math.round(2 / DT) === 0;
      stepTraffic(st, { ego: { ...EGO_IN_BOX, speed: creeping ? 0.5 : 0 }, egoReset: false, scripted: [], lights: allLights(map, 'green'), egoContacts: [], t });
      if (st.edge[k] === conn) {
        if (Number.isNaN(lateralOnConnector)) lateralOnConnector = st.lateralBase[k];
        expect(st.lateralBase[k]).toBe(lateralOnConnector);
      }
    }
    expect(st.edge[k]).toBe(conn);
  });
});
