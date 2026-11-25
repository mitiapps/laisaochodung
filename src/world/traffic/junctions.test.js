import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { footprint, pointInPolygon, polygonsIntersect } from '../../geometry/index.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';
import { priorityOf } from './junctions.js';
import { reachesBeforeRed, signalDecision, yellowRemaining } from './signals.js';
import { spawnAgent } from './state.js';
import { lawfulParams } from './lawful-params.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./state.js').TrafficState} TrafficState */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
// The lawful population: these suites check what drivers who keep the rules never do.
const PARAMS = { ...lawfulParams(JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'))), preRollS: 0 };
/** Parameters for tests that use a wreck as an obstacle standing longer than any run. */
const STANDING_WRECK_PARAMS = { ...PARAMS, wreckClearS: 60 };
const EGO = Object.freeze({ pos: { x: -60, z: 20 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });
const BOX = MAP.junctions[0].polygon;
/** Yellow go margin of the shipped params, seconds. */
const YELLOW_MARGIN_S = PARAMS.behaviour.yellowGoMarginS;

/**
 * The junction map with no spawning; unsignalled when asked (every stop line becomes `control`).
 * @param {'signal' | 'give-way' | 'stop-sign'} control Junction control.
 * @returns {GameMap} Map.
 */
function junctionMap(control) {
  const map = structuredClone(MAP);
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
  traffic.sources = [];
  traffic.densityPerKm = {};
  if (control !== 'signal') {
    map.junctions[0].signalized = false;
    map.signals = [];
    for (const sl of map.stopLines) {
      sl.control = control;
      delete sl.signalId;
    }
  }
  return map;
}

/**
 * @param {TrafficState} st State.
 * @param {string} laneId Lane.
 * @param {number} front Front distance along the lane.
 * @param {number} speed Speed.
 * @param {string} model Model.
 * @param {string} connectorId Next connector.
 * @returns {number} Slot.
 */
function place(st, laneId, front, speed, model, connectorId) {
  const m = st.modelKeys.indexOf(model);
  const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get(laneId)), front - PARAMS.models[model].lengthM / 2, speed, m);
  st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get(connectorId));
  return slot;
}

/**
 * @param {TrafficState} st State.
 * @param {GameMap} map Map.
 * @param {number} t0 Start.
 * @param {number} seconds Duration.
 * @param {(poses: ActorPose[], t: number) => void} visit Visitor.
 * @returns {void}
 */
function run(st, map, t0, seconds, visit) {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = t0 + i * DT;
    const { poses } = stepTraffic(st, { ego: EGO, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
    visit(poses, t);
  }
}

/**
 * @param {ActorPose[]} poses Poses.
 * @returns {boolean} Two footprints overlap.
 */
function anyOverlap(poses) {
  const fps = poses.map((p) => footprint(p.pos, p.heading, p.lengthM, p.widthM));
  for (let i = 0; i < fps.length; i += 1) for (let j = i + 1; j < fps.length; j += 1) if (polygonsIntersect(fps[i], fps[j])) return true;
  return false;
}

describe('signal rule', () => {
  const sig = MAP.signals[0];

  it('reports the yellow left, also at negative t', () => {
    expect(yellowRemaining(sig, 26)).toBe(0);
    expect(yellowRemaining(sig, 28)).toBeCloseTo(2, 9);
    expect(yellowRemaining(sig, 28 - 60)).toBeCloseTo(2, 9);
    expect(yellowRemaining(sig, 40)).toBe(0);
  });

  it('goes on green, stops on red unless it cannot, and splits yellow by b_stop and time', () => {
    expect(signalDecision('green', 1, 15, 0, 3.1, 8, YELLOW_MARGIN_S)).toBe('go');
    expect(signalDecision('red', 40, 10, 0, 3.1, 8, YELLOW_MARGIN_S)).toBe('stop');
    expect(signalDecision('red', 2, 10, 0, 3.1, 8, YELLOW_MARGIN_S)).toBe('go');
    expect(signalDecision('red', 0, 0, 0, 3.1, 8, YELLOW_MARGIN_S)).toBe('stop');
    // 10 m/s, 30 m out: 1.67 m/s² is below b_stop.
    expect(signalDecision('yellow', 30, 10, 3, 3.1, 8, YELLOW_MARGIN_S)).toBe('stop');
    // 12 m/s, 12 m out: 6 m/s² needed, reaches the line in 1 s with 3 s of yellow left.
    expect(signalDecision('yellow', 12, 12, 3, 3.1, 8, YELLOW_MARGIN_S)).toBe('go');
    // Same, with only 1.2 s of yellow left: stops while the braking limit allows.
    expect(signalDecision('yellow', 12, 12, 1.2, 3.1, 8, YELLOW_MARGIN_S)).toBe('stop');
    expect(reachesBeforeRed(12, 12, 1.6, YELLOW_MARGIN_S)).toBe(true);
    expect(reachesBeforeRed(12, 0, 3, YELLOW_MARGIN_S)).toBe(false);
  });
});

describe('priority', () => {
  it('gives straight priority over a left turn at a signal, and the agent from the right without one', () => {
    const st = createTraffic(junctionMap('signal'), PARAMS, 1);
    const e = (/** @type {string} */ id) => st.graph.edges[/** @type {number} */ (st.graph.edgeIndex.get(id))];
    // Eastbound left vs westbound straight.
    expect(priorityOf(st, e('c-rw-e1-rn-n'), e('c-re-w0-rw-w0'))).toBe(1);
    expect(priorityOf(st, e('c-re-w0-rw-w0'), e('c-rw-e1-rn-n'))).toBe(-1);
    const un = createTraffic(junctionMap('give-way'), PARAMS, 1);
    const u = (/** @type {string} */ id) => un.graph.edges[/** @type {number} */ (un.graph.edgeIndex.get(id))];
    // Eastbound straight vs northbound straight (from the eastbound's right).
    expect(priorityOf(un, u('c-rw-e1-re-e0'), u('c-rs-n-rn-n'))).toBe(1);
    expect(priorityOf(un, u('c-rs-n-rn-n'), u('c-rw-e1-re-e0'))).toBe(-1);
  });

  it('lets a priority road go first', () => {
    const map = junctionMap('give-way');
    map.junctions[0].priorityRoadIds = ['rn', 'rs'];
    const st = createTraffic(map, PARAMS, 1);
    const e = (/** @type {string} */ id) => st.graph.edges[/** @type {number} */ (st.graph.edgeIndex.get(id))];
    expect(priorityOf(st, e('c-rs-n-rn-n'), e('c-rw-e1-re-e0'))).toBe(-1);
    expect(priorityOf(st, e('c-rw-e1-re-e0'), e('c-rs-n-rn-n'))).toBe(1);
  });
});

describe('keep-clear', () => {
  it('never stops an agent inside the junction box while the exit lane is blocked by a wreck', () => {
    const map = junctionMap('signal');
    // The wreck is a standing obstacle here, so it must outlast the run.
    const st = createTraffic(map, STANDING_WRECK_PARAMS, 2);
    const wreck = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get('re-e0')), 9, 0, st.modelKeys.indexOf('car'));
    st.wreck[wreck] = 1;
    // One car fits between the junction and the wreck; the rest must wait at the stop line.
    place(st, 'rw-e1', 120, 9, 'car', 'c-rw-e1-re-e0');
    place(st, 'rw-e1', 105, 9, 'motorbike', 'c-rw-e1-re-e0');
    place(st, 'rw-e0', 110, 9, 'car', 'c-rw-e0-re-e0');
    place(st, 'rw-e0', 90, 9, 'taxi', 'c-rw-e0-re-e0');
    let stoppedInBox = 0;
    let overlapped = false;
    run(st, map, 0, 19, (poses, t) => {
      overlapped ||= anyOverlap(poses);
      if (t < 15) return;
      for (const p of poses) if (p.speed === 0 && p.state === 'stopped' && pointInPolygon([p.pos.x, p.pos.z], BOX)) stoppedInBox += 1;
    });
    expect(overlapped).toBe(false);
    expect(stoppedInBox).toBe(0);
    // Exactly one agent got onto the exit lane, behind the wreck.
    expect(st.edgeCount[/** @type {number} */ (st.graph.edgeIndex.get('re-e0'))]).toBe(2);
  });

  it('makes an agent that already holds its claim give it back and stop at the line when a wreck appears in its way', () => {
    const map = junctionMap('signal');
    // The wreck is a standing obstacle here, so it must outlast the run.
    const st = createTraffic(map, STANDING_WRECK_PARAMS, 11);
    const k = place(st, 'rw-e1', 120, 9, 'car', 'c-rw-e1-re-e0');
    const conn = /** @type {number} */ (st.graph.edgeIndex.get('c-rw-e1-re-e0'));
    const lane = st.graph.edges[/** @type {number} */ (st.graph.edgeIndex.get('rw-e1'))];
    let t = 0;
    // West green: it claims the connector on its way to the line, still short of the hold point.
    for (; st.claim[k] !== conn; t += DT) {
      expect(t).toBeLessThan(5);
      stepTraffic(st, { ego: EGO, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
    }
    expect(st.s[k] + st.lengthM[k] / 2).toBeLessThan(lane.holdS);
    const wreck = spawnAgent(st, conn, 0.6 * st.graph.edges[conn].length, 0, st.modelKeys.indexOf('car'));
    st.wreck[wreck] = 1;
    st.wreckT[wreck] = t;
    let entered = false;
    let stoppedInBox = false;
    run(st, map, t, 10, () => {
      entered ||= st.edge[k] === conn;
      stoppedInBox ||= st.v[k] === 0 && pointInPolygon([st.x[k], st.z[k]], BOX);
    });
    expect(entered).toBe(false);
    expect(stoppedInBox).toBe(false);
    expect(st.v[k]).toBe(0);
    expect(st.claim[k]).toBe(-1);
  });

  describe.each([
    ['its own connector', 'c-rw-e1-re-e0'],
    ['the connector merging with it', 'c-rw-e0-re-e0'],
  ])('with a wrecked car on %s', (_name, wreckConn) => {
    it('keeps the queues of both approaches out of the box until the wreck is cleared, then lets them go', () => {
      const map = junctionMap('signal');
      const st = createTraffic(map, PARAMS, 10);
      const conn = /** @type {number} */ (st.graph.edgeIndex.get(wreckConn));
      const wreck = spawnAgent(st, conn, 0.6 * st.graph.edges[conn].length, 0, st.modelKeys.indexOf('car'));
      st.wreck[wreck] = 1;
      st.wreckT[wreck] = 0;
      // West green from 0 to 27, yellow to 30: queues on both approach lanes, all going into `re-e0`.
      const queued = [
        place(st, 'rw-e1', 140, 6, 'car', 'c-rw-e1-re-e0'),
        place(st, 'rw-e1', 130, 6, 'motorbike', 'c-rw-e1-re-e0'),
        place(st, 'rw-e1', 120, 6, 'car', 'c-rw-e1-re-e0'),
        place(st, 'rw-e0', 138, 6, 'car', 'c-rw-e0-re-e0'),
        place(st, 'rw-e0', 126, 6, 'taxi', 'c-rw-e0-re-e0'),
      ];
      const exitLane = /** @type {number} */ (st.graph.edgeIndex.get('re-e0'));
      let overlapped = false;
      let stoppedInBox = 0;
      let wreckGoneAt = Infinity;
      /** @type {Set<number>} */
      const through = new Set();
      // Through the green and the yellow that follows the clearing.
      run(st, map, 0, 30, (poses, t) => {
        overlapped ||= anyOverlap(poses);
        for (const k of queued) if (st.alive[k] && st.edge[k] === exitLane) through.add(k);
        if (!st.alive[wreck]) {
          if (wreckGoneAt === Infinity) wreckGoneAt = t;
          return;
        }
        expect(through.size, 'nobody passes the wreck').toBe(0);
        for (const k of queued) if (st.v[k] === 0 && pointInPolygon([st.x[k], st.z[k]], BOX)) stoppedInBox += 1;
      });
      expect(overlapped).toBe(false);
      expect(stoppedInBox).toBe(0);
      expect(wreckGoneAt).toBeCloseTo(PARAMS.wreckClearS, 0);
      // After the wreck is cleared both approaches discharge into the exit lane.
      expect(queued.slice(0, 3).some((k) => through.has(k))).toBe(true);
      expect(queued.slice(3).some((k) => through.has(k))).toBe(true);
    });
  });
});

describe('no gridlock from the ego', () => {
  /**
   * Steps with a given ego.
   * @param {TrafficState} st State.
   * @param {GameMap} map Map.
   * @param {number} t0 Start.
   * @param {number} seconds Duration.
   * @param {import('./index.js').EgoInput} ego Ego.
   * @returns {void}
   */
  function runWith(st, map, t0, seconds, ego) {
    for (let i = 0; i < Math.round(seconds / DT); i += 1) {
      const t = t0 + i * DT;
      stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
    }
  }

  it('does not count an ego on the extension line of an exit lane as standing on it', () => {
    const map = junctionMap('signal');
    const st = createTraffic(map, PARAMS, 7);
    const k = place(st, 'rw-e0', 120, 8, 'car', 'c-rw-e0-re-e0');
    runWith(st, map, 0, 10, { pos: { x: -40, z: 1.75 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });
    expect(st.graph.edges[st.edge[k]].id).toBe('re-e0');
  });

  it('keeps a follower on a diverging connector behind an agent the ego stopped in the box', () => {
    const map = junctionMap('signal');
    const st = createTraffic(map, PARAMS, 9);
    place(st, 're-w0', 140, 8, 'motorbike', 'c-re-w0-rw-w0');
    place(st, 're-w0', 128, 8, 'motorbike', 'c-re-w0-rs-s');
    const ego = { pos: { x: 0, z: 0 }, heading: 0.7, speed: 0, lengthM: 4.5, widthM: 1.8 };
    const egoFp = footprint(ego.pos, ego.heading, ego.lengthM, ego.widthM);
    let touched = false;
    for (let i = 0; i < Math.round(20 / DT); i += 1) {
      const t = i * DT;
      const { poses } = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
      touched ||= anyOverlap(poses) || poses.some((p) => polygonsIntersect(footprint(p.pos, p.heading, p.lengthM, p.widthM), egoFp));
    }
    expect(touched).toBe(false);
  });

  it('lets cross traffic pass an agent held up behind a stopped ego before the stop line', () => {
    const map = junctionMap('signal');
    const st = createTraffic(map, PARAMS, 8);
    // West green from 0 to 27: the eastbound car comes up behind the ego and stops.
    const held = place(st, 'rw-e1', 110, 8, 'car', 'c-rw-e1-re-e0');
    // The ego stands across the stop line, so the held car waits inside its decision zone.
    const ego = { pos: { x: -9.5, z: 1.75 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 };
    runWith(st, map, 0, 25, ego);
    expect(st.v[held]).toBe(0);
    expect(st.claim[held]).toBe(-1);
    // North green from 30: a southbound car goes straight across the eastbound path.
    const cross = place(st, 'rn-s', 120, 8, 'car', 'c-rn-s-rs-s');
    runWith(st, map, 25, 20, ego);
    expect(st.graph.edges[st.edge[cross]].id).toBe('rs-s');
  });
});

describe('gap acceptance', () => {
  it('releases a four-way standoff at an unsignalled junction within 10 s through the deadlock breaker', () => {
    const map = junctionMap('give-way');
    const st = createTraffic(map, PARAMS, 4);
    const conns = ['c-rw-e1-re-e0', 'c-re-w0-rw-w0', 'c-rn-s-rs-s', 'c-rs-n-rn-n'];
    const slots = [
      place(st, 'rw-e1', 144, 0, 'car', conns[0]),
      place(st, 're-w0', 144, 0, 'car', conns[1]),
      place(st, 'rn-s', 144, 0, 'car', conns[2]),
      place(st, 'rs-n', 144, 0, 'car', conns[3]),
    ];
    let firstEntry = Infinity;
    let overlapped = false;
    run(st, map, 0, 40, (poses, t) => {
      overlapped ||= anyOverlap(poses);
      if (firstEntry === Infinity && slots.some((k) => st.graph.edges[st.edge[k]].kind === 'connector')) firstEntry = t;
    });
    expect(firstEntry).toBeGreaterThan(PARAMS.behaviour.deadlockS);
    expect(firstEntry).toBeLessThan(10);
    expect(overlapped).toBe(false);
    // All four got through to their exit lanes (or already left the map there).
    const exits = ['re-e0', 'rw-w0', 'rs-s', 'rn-n'];
    slots.forEach((k, i) => expect(st.alive[k] === 0 || st.graph.edges[st.edge[k]].id === exits[i]).toBe(true));
  });

  it('makes a lower-priority agent wait for an approaching one inside its critical gap', () => {
    const map = junctionMap('give-way');
    const st = createTraffic(map, PARAMS, 5);
    // Eastbound waits at the line; northbound (from its right) approaches at 8 m/s, 30 m out.
    const east = place(st, 'rw-e1', 144, 0, 'car', 'c-rw-e1-re-e0');
    const north = place(st, 'rs-n', 118, 8, 'car', 'c-rs-n-rn-n');
    /** @type {number} */
    let eastIn = Infinity;
    /** @type {number} */
    let northIn = Infinity;
    run(st, map, 0, 15, (_, t) => {
      if (eastIn === Infinity && st.graph.edges[st.edge[east]].kind === 'connector') eastIn = t;
      if (northIn === Infinity && st.alive[north] && st.graph.edges[st.edge[north]].kind === 'connector') northIn = t;
    });
    expect(northIn).toBeLessThan(eastIn);
    expect(eastIn).toBeLessThan(15);
  });

  it('makes an agent halt at a stop sign before it enters', () => {
    const map = junctionMap('stop-sign');
    const st = createTraffic(map, PARAMS, 6);
    const k = place(st, 'rw-e1', 100, 8, 'car', 'c-rw-e1-re-e0');
    let minSpeed = Infinity;
    let entered = false;
    run(st, map, 0, 20, () => {
      if (!st.alive[k]) return;
      const e = st.graph.edges[st.edge[k]];
      if (e.kind === 'lane' && e.id === 'rw-e1') minSpeed = Math.min(minSpeed, st.v[k]);
      if (e.kind === 'connector') entered = true;
    });
    expect(entered).toBe(true);
    expect(minSpeed).toBeLessThan(0.1);
  });
});
