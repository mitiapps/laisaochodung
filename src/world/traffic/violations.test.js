import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { decideFault } from '../../scoring/fault.js';
import { createTraffic, stepTraffic } from './index.js';
import { lawfulParams } from './lawful-params.js';
import { refreshBaseSpeed, spawnAgent, updatePose } from './state.js';
import { yellowStopProbability } from './signals.js';
import { trafficLightStates } from '../signals.js';
import { FLAG, LATCH_S, latch, listOfMask, raise, violationsOf } from './violations.js';
import { makeWreck } from './contacts.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./index.js').EgoInput} EgoInput */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const FULL = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
const LAWFUL = { ...lawfulParams(FULL), preRollS: 0 };
/** @type {{scoring: {crashCauseWindowS: number}}} */
const RULES = JSON.parse(readFileSync(new URL('../../generated/rules.json', import.meta.url), 'utf8'));
const EGO_AWAY = Object.freeze({ pos: { x: -60, z: 20 }, heading: 0, speed: 0, lengthM: 4.5, widthM: 1.8 });

/**
 * The junction fixture with no spawning; give-way at every stop line when asked.
 * @param {'signal' | 'give-way'} control Control.
 * @returns {GameMap} Map.
 */
function emptyMap(control) {
  const map = structuredClone(MAP);
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
  traffic.sources = [];
  traffic.densityPerKm = {};
  if (control === 'give-way') {
    map.junctions[0].signalized = false;
    map.signals = [];
    for (const sl of map.stopLines) {
      sl.control = 'give-way';
      delete sl.signalId;
    }
  }
  return map;
}

/**
 * @param {GameMap} map Map.
 * @param {'red' | 'green'} state Every light.
 * @returns {Record<string, import('../../contracts/telemetry.js').LightState>} Light states.
 */
const allLights = (map, state) => Object.fromEntries(map.signals.map((s) => [s.id, state]));

/**
 * Places an agent with its front at `front` along a lane, bound for a connector.
 * @param {TrafficState} st State.
 * @param {string} laneId Lane.
 * @param {number} front Front distance.
 * @param {number} speed Speed.
 * @param {string} model Model.
 * @param {string} connectorId Next connector.
 * @returns {number} Slot.
 */
function place(st, laneId, front, speed, model, connectorId) {
  const slot = spawnAgent(st, /** @type {number} */ (st.graph.edgeIndex.get(laneId)), front - FULL.models[model].lengthM / 2, speed, st.modelKeys.indexOf(model));
  st.nextEdge[slot] = /** @type {number} */ (st.graph.edgeIndex.get(connectorId));
  return slot;
}

/**
 * Steps traffic with a scripted ego and fixed lights; returns every step's poses.
 * @param {TrafficState} st State.
 * @param {number} t0 Start.
 * @param {number} seconds Duration.
 * @param {(t: number) => EgoInput} ego Ego by time.
 * @param {Record<string, import('../../contracts/telemetry.js').LightState>} lights Lights.
 * @returns {{t: number, poses: ActorPose[]}[]} Steps.
 */
function run(st, t0, seconds, ego, lights) {
  /** @type {{t: number, poses: ActorPose[]}[]} */
  const out = [];
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = t0 + i * DT;
    out.push({ t, poses: stepTraffic(st, { ego: ego(t), egoReset: false, scripted: [], lights, egoContacts: [], t }).poses });
  }
  return out;
}

describe('flag latch', () => {
  it('keeps the latch equal to the scorer crash cause window', () => {
    expect(LATCH_S).toBe(RULES.scoring.crashCauseWindowS);
  });

  it('keeps a flag 2.9 s after its condition ends and drops it at 3.1 s', () => {
    const st = createTraffic(emptyMap('signal'), LAWFUL, 1);
    const k = place(st, 'rw-e1', 40, 0, 'car', 'c-rw-e1-re-e0');
    raise(st, k, FLAG.speeding);
    latch(st, k, 10);
    expect(violationsOf(st, k, 10 + 2.9)).toEqual(['speeding']);
    expect(violationsOf(st, k, 10 + 3.1)).toEqual([]);
  });

  it('shares one frozen list per combination of flags', () => {
    const both = FLAG['red-light'] | FLAG['no-yield'];
    expect(listOfMask(both)).toBe(listOfMask(both));
    expect(Object.isFrozen(listOfMask(both))).toBe(true);
    expect(listOfMask(both)).toEqual(['red-light', 'no-yield']);
  });
});

describe('flags are facts', () => {
  it('flags red-light on a distracted agent that rolls past red with every draw off', () => {
    const map = emptyMap('signal');
    const st = createTraffic(map, LAWFUL, 2);
    const k = place(st, 'rs-n', 120, 10, 'car', 'c-rs-n-rn-n');
    st.distractUntil[k] = 1e9;
    const steps = run(st, 0, 4, () => EGO_AWAY, allLights(map, 'red'));
    const id = st.ids[k];
    const flagged = steps.some(({ poses }) => poses.find((p) => p.id === id)?.violations.includes('red-light'));
    expect(flagged).toBe(true);
  });

  it('flags no lawful attentive agent that stops for the same red', () => {
    const map = emptyMap('signal');
    const st = createTraffic(map, LAWFUL, 2);
    const k = place(st, 'rs-n', 120, 10, 'car', 'c-rs-n-rn-n');
    const steps = run(st, 0, 8, () => EGO_AWAY, allLights(map, 'red'));
    const id = st.ids[k];
    expect(steps.every(({ poses }) => (poses.find((p) => p.id === id)?.violations.length ?? 0) === 0)).toBe(true);
    expect(st.graph.edges[st.edge[k]].id).toBe('rs-n');
  });

  it('flags speeding from the true speed above the limit', () => {
    const map = emptyMap('signal');
    const st = createTraffic(map, LAWFUL, 3);
    const k = place(st, 'rw-e1', 30, 0, 'car', 'c-rw-e1-re-e0');
    // A 30 km/h limit on the lane; the driver wants 30 % above it.
    st.graph.edges[st.edge[k]].limitKmh = 30;
    refreshBaseSpeed(st, k);
    const limit = 30 / 3.6;
    st.v0Factor[k] = 1.3;
    const steps = run(st, 0, 12, () => EGO_AWAY, allLights(map, 'green'));
    const id = st.ids[k];
    const fast = steps.find(({ poses }) => (poses.find((p) => p.id === id)?.speed ?? 0) > limit + 0.5);
    expect(fast).toBeDefined();
    const later = steps.find(({ t }) => t > /** @type {{t: number}} */ (fast).t + DT);
    expect(later?.poses.find((p) => p.id === id)?.violations).toContain('speeding');
  });
});

describe('the ego at a conflict zone', () => {
  // Give-way junction: an agent going north on `rs-n` gives way to the ego coming west on `re-w0`,
  // from its right.
  /**
   * @param {number} t Time.
   * @returns {EgoInput} Ego moving west at 10 m/s, 4 s from the junction box at t = 0: after the
   *   agent would be through, but inside its critical gap.
   */
  const egoWest = (t) => ({ pos: { x: 47 - 10 * t, z: -1.75 }, heading: Math.PI, speed: 10, lengthM: 4.5, widthM: 1.8, indicators: 'off' });

  it('makes a lower-priority agent wait for an ego arriving inside its critical gap', () => {
    const map = emptyMap('give-way');
    const st = createTraffic(map, LAWFUL, 4);
    const k = place(st, 'rs-n', 136, 6, 'car', 'c-rs-n-rn-n');
    const lane = st.graph.edges[st.edge[k]];
    const steps = run(st, 0, 3, egoWest, {});
    const id = st.ids[k];
    // Still before its stop line while the ego crosses its path.
    for (const { poses } of steps) {
      const p = /** @type {ActorPose} */ (poses.find((q) => q.id === id));
      expect(p.violations).toEqual([]);
    }
    expect(st.edge[k]).toBe(lane.index);
    expect(st.s[k] + st.lengthM[k] / 2).toBeLessThanOrEqual(lane.holdS + 0.01);
    // With the ego away it goes.
    const st2 = createTraffic(map, LAWFUL, 4);
    const k2 = place(st2, 'rs-n', 136, 6, 'car', 'c-rs-n-rn-n');
    run(st2, 0, 3, () => EGO_AWAY, {});
    expect(st2.graph.edges[st2.edge[k2]].kind).toBe('connector');
  });

  it('flags no-yield on a reckless agent that goes anyway, and the scorer makes the contact a notice', async () => {
    const map = emptyMap('give-way');
    const st = createTraffic(map, LAWFUL, 4);
    const k = place(st, 'rs-n', 136, 6, 'car', 'c-rs-n-rn-n');
    // A reckless driver's critical gap, well under the class one.
    st.criticalGap[k] = 0.2;
    const steps = run(st, 0, 3, egoWest, {});
    const id = st.ids[k];
    const flagged = steps.map(({ poses }) => poses.find((p) => p.id === id)?.violations ?? []).find((v) => v.includes('no-yield'));
    expect(flagged).toBeDefined();
    expect(st.graph.edges[st.edge[k]].kind === 'connector' || st.graph.edges[st.edge[k]].id === 'rn-n').toBe(true);
    // The ego, holding its right of way, strikes the agent that did not yield.
    const policy = (await realBundle()).collisionPolicy;
    const decision = decideFault(
      policy,
      {
        type: 'collision',
        otherKind: 'car',
        otherId: id,
        impulse: 3000,
        egoSpeed: 10,
        relSpeed: 10,
        sameLaneAhead: false,
        otherModel: 'car',
        striker: 'ego',
        otherFromBehind: false,
        otherViolations: /** @type {import('../../contracts/telemetry.js').NpcViolation[]} */ (flagged),
      },
      { aftermath: false, cause: null, anyCause: null, rearEndCause: null },
    );
    expect(decision.result).toBe('notice');
  });

  it('waits for no ego standing on its lane', () => {
    const map = emptyMap('give-way');
    const st = createTraffic(map, LAWFUL, 4);
    const k = place(st, 'rs-n', 136, 6, 'car', 'c-rs-n-rn-n');
    run(st, 0, 3, () => ({ pos: { x: 40, z: -1.75 }, heading: Math.PI, speed: 0, lengthM: 4.5, widthM: 1.8 }), {});
    expect(st.graph.edges[st.edge[k]].kind).toBe('connector');
  });
});

describe('wrecks stop raising right-of-way flags', () => {
  // A wreck leaves the road when its latch runs out; these cases keep it standing past the latch
  // to check the flags drop and the fault table still judges such a wreck.
  const OUTLASTING = { ...LAWFUL, wreckClearS: 60 };

  /**
   * The ego striking a standing traffic wreck, decided by the shipped fault table.
   * @param {string} id Wreck id.
   * @param {readonly import('../../contracts/telemetry.js').NpcViolation[]} violations Its latched violations.
   * @returns {Promise<import('../../scoring/fault.js').FaultDecision>} Decision.
   */
  const egoStrikes = async (id, violations) =>
    decideFault(
      (await realBundle()).collisionPolicy,
      {
        type: 'collision',
        otherKind: 'car',
        otherId: id,
        impulse: 3000,
        egoSpeed: 8,
        relSpeed: 8,
        sameLaneAhead: false,
        otherModel: 'car',
        striker: 'ego',
        otherFromBehind: false,
        otherViolations: [...violations],
      },
      { aftermath: false, cause: null, anyCause: null, rearEndCause: null },
    );

  /**
   * Steps traffic from `t0` for `seconds` with every light red; returns the last pose of `id`.
   * @param {TrafficState} st State.
   * @param {number} t0 Start.
   * @param {number} seconds Duration.
   * @param {string} id Agent id.
   * @param {string[]} [contactsFirst] Ego contacts fed on the first step.
   * @returns {ActorPose} Pose.
   */
  const stepRed = (st, t0, seconds, id, contactsFirst = []) => {
    const lights = allLights(st.map, 'red');
    /** @type {ActorPose | undefined} */
    let pose;
    for (let i = 0; i < Math.round(seconds / DT); i += 1) {
      const t = t0 + i * DT;
      const step = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights, egoContacts: i === 0 ? contactsFirst : [], t });
      pose = step.poses.find((p) => p.id === id);
    }
    return /** @type {ActorPose} */ (pose);
  };

  it('drops red-light from a red runner wrecked on the connector once its latch runs out, so striking it is a deduction', async () => {
    const map = emptyMap('signal');
    const st = createTraffic(map, OUTLASTING, 2);
    const k = place(st, 'rs-n', 120, 10, 'car', 'c-rs-n-rn-n');
    st.distractUntil[k] = 1e9;
    const id = st.ids[k];
    // It rolls past the red stop line into the junction.
    let t = 0;
    while (st.graph.edges[st.edge[k]].kind !== 'connector' && t < 4) {
      stepRed(st, t, DT, id);
      t += DT;
    }
    expect(st.graph.edges[st.edge[k]].kind).toBe('connector');
    expect(st.redConn[k]).toBe(st.edge[k]);
    // An ego contact stops it dead on the connector, still flagged within its latch.
    const wrecked = stepRed(st, t, DT, id, [id]);
    expect(wrecked.state).toBe('crashed');
    expect(wrecked.speed).toBe(0);
    expect(wrecked.violations).toContain('red-light');
    const early = stepRed(st, t + DT, LATCH_S - 0.5, id);
    expect(early.violations).toContain('red-light');
    expect((await egoStrikes(id, early.violations)).result).toBe('notice');
    // Past the latch the wreck stands in the junction with no flag; the ego that drives into it
    // failed its duty to observe and slow down.
    const late = stepRed(st, t + LATCH_S - 0.5 + DT, 1, id);
    expect(st.graph.edges[st.edge[k]].kind).toBe('connector');
    expect(late.state).toBe('crashed');
    expect(late.violations).toEqual([]);
    const decision = await egoStrikes(id, late.violations);
    expect(decision.result).toBe('deduction');
    expect(decision.rowId).toBe('ego-strikes');
  });

  it('drops no-yield from an agent wrecked by another agent on the connector it forced into', () => {
    const map = emptyMap('give-way');
    const st = createTraffic(map, OUTLASTING, 4);
    const k = place(st, 'rs-n', 136, 6, 'car', 'c-rs-n-rn-n');
    st.criticalGap[k] = 0.2;
    const id = st.ids[k];
    const egoWest = (/** @type {number} */ t) => ({ pos: { x: 47 - 10 * t, z: -1.75 }, heading: Math.PI, speed: 10, lengthM: 4.5, widthM: 1.8, indicators: /** @type {const} */ ('off') });
    let t = 0;
    while (st.noYieldConn[k] < 0 && t < 3) {
      stepTraffic(st, { ego: egoWest(t), egoReset: false, scripted: [], lights: {}, egoContacts: [], t });
      t += DT;
    }
    expect(st.noYieldConn[k]).toBeGreaterThanOrEqual(0);
    makeWreck(st, k, t);
    expect(st.noYieldConn[k]).toBe(-1);
    expect(st.redConn[k]).toBe(-1);
    /** @type {ActorPose | undefined} */
    let pose;
    for (let i = 0; i < Math.round((LATCH_S + 0.5) / DT); i += 1) {
      const step = stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: {}, egoContacts: [], t: t + i * DT });
      pose = step.poses.find((p) => p.id === id);
      // The latch still carries the flag at first.
      if (i === 1) expect(pose?.violations).toContain('no-yield');
    }
    expect(pose?.state).toBe('crashed');
    expect(pose?.violations).toEqual([]);
  });
});

describe('cut-in and the signalling ego', () => {
  /**
   * A rider on rw-e1 that cuts into the ego's path whenever it can, ahead of an ego driving along
   * the lane line on rw-e0 (its corridor reaches over the left of rw-e1).
   * @param {number} lateral Rider's starting lateral offset (negative: towards the ego).
   * @param {(t: number) => number} speedAt Ego speed over time.
   * @param {number} front Rider centre along the lane.
   * @returns {number} Time the flag first shows, or −1.
   */
  function cutInFlaggedAt(lateral, speedAt, front) {
    const map = emptyMap('signal');
    const cutters = structuredClone(LAWFUL);
    for (const row of Object.values(cutters.personalities)) row.violations.cutIn = 1;
    const st = createTraffic(map, cutters, 5);
    const k = place(st, 'rw-e1', front, 3, 'motorbike', 'c-rw-e1-re-e0');
    st.lateral[k] = lateral;
    st.lateralBase[k] = lateral;
    updatePose(st, k);
    const id = st.ids[k];
    let x = -100;
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      const t = i * DT;
      const v = speedAt(t);
      x += v * DT;
      const { poses } = stepTraffic(st, { ego: { pos: { x, z: 3.4 }, heading: 0, speed: v, lengthM: 4.5, widthM: 1.8 }, egoReset: false, scripted: [], lights: allLights(map, 'green'), egoContacts: [], t });
      if (poses.find((p) => p.id === id)?.violations.includes('unsafe-lane-change')) return t;
    }
    return -1;
  }

  it('flags unsafe-lane-change on a rider moving into the ego corridor inside its stopping distance', () => {
    expect(cutInFlaggedAt(0, () => 12, 70)).toBeGreaterThan(0);
  });

  it('raises no cut-in for a rider already inside the ego corridor that keeps moving across', () => {
    expect(cutInFlaggedAt(-0.5, () => 12, 70)).toBe(-1);
  });

  it('raises no cut-in when the ego speeds up and its corridor reaches a rider moving across ahead', () => {
    // The ego pulls away from 2 m/s; its stopping corridor grows over the rider, not the reverse.
    expect(cutInFlaggedAt(0.3, (t) => Math.min(12, 2 + 8 * t), 75)).toBe(-1);
  });

  it('keeps a lawful rider clear of the ego corridor, so it raises no cut-in', () => {
    const map = emptyMap('signal');
    const st = createTraffic(map, LAWFUL, 5);
    const k = place(st, 'rw-e1', 70, 6, 'motorbike', 'c-rw-e1-re-e0');
    st.lateral[k] = -1;
    st.lateralBase[k] = -1;
    /** @type {(t: number) => EgoInput} */
    const ego = (t) => ({ pos: { x: -100 + 12 * t, z: 4.3 }, heading: 0, speed: 12, lengthM: 4.5, widthM: 1.8 });
    const steps = run(st, 0, 2, ego, allLights(map, 'green'));
    const id = st.ids[k];
    expect(steps.some(({ poses }) => poses.find((p) => p.id === id)?.violations.includes('unsafe-lane-change'))).toBe(false);
  });

  /**
   * A careful car on rw-e1 behind an ego on rw-e0 that drifts left into rw-e1 at 0.6 m/s.
   * @param {'off' | 'left'} indicators Ego indicators.
   * @returns {{brakeAt: number, carFront: number}} Time the car first brakes harder than 1 m/s²,
   *   and its front along the lane after 2 s.
   */
  function carBehindSignallingEgo(indicators) {
    const map = emptyMap('signal');
    const st = createTraffic(map, LAWFUL, 6);
    const k = place(st, 'rw-e1', 50, 10, 'car', 'c-rw-e1-re-e0');
    let brakeAt = Infinity;
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      const t = i * DT;
      const ego = { pos: { x: -97 + 9 * t, z: 4.2 - 0.6 * t }, heading: 0.066, speed: 9, lengthM: 4.5, widthM: 1.8, indicators };
      stepTraffic(st, { ego, egoReset: false, scripted: [], lights: allLights(map, 'green'), egoContacts: [], t });
      if (st.acc[k] < -1 && brakeAt === Infinity) brakeAt = t;
    }
    return { brakeAt, carFront: st.s[k] + st.lengthM[k] / 2 };
  }

  it('opens a gap within 2 s for an ego signalling into its lane and moving across', () => {
    const signalled = carBehindSignallingEgo('left');
    const silent = carBehindSignallingEgo('off');
    // It brakes at once for the signal, before the ego's body reaches its lane.
    expect(signalled.brakeAt).toBeLessThan(0.1);
    expect(silent.brakeAt).toBeGreaterThan(0.3);
    expect(signalled.carFront).toBeLessThan(silent.carFront - 0.5);
  });
});

describe('yellow choice', () => {
  it('splits stop and go across seeds at the edge of the dilemma zone', () => {
    const map = emptyMap('signal');
    const probe = createTraffic(map, FULL, 1);
    const edge = probe.graph.edges[/** @type {number} */ (probe.graph.edgeIndex.get('rw-e1'))];
    const signal = map.signals[edge.signalIndex];
    // The first step of a yellow phase of that signal.
    let t0 = 0;
    while (trafficLightStates(map, t0)[signal.id] !== 'yellow') t0 += DT;
    let stops = 0;
    let goes = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const st = createTraffic(map, { ...FULL, preRollS: 0 }, seed);
      const k = place(st, 'rw-e1', 0, 12, 'car', 'c-rw-e1-re-e0');
      // Front where stopping takes exactly the driver's b_stop.
      st.yellowStop[k] = 3.1;
      st.nextDistract[k] = Infinity;
      st.s[k] = edge.holdS - (12 * 12) / (2 * 3.1) - st.lengthM[k] / 2;
      stepTraffic(st, { ego: EGO_AWAY, egoReset: false, scripted: [], lights: trafficLightStates(map, t0), egoContacts: [], t: t0 });
      if (st.signalCommit[k] === 1) stops += 1;
      else if (st.signalCommit[k] === 2) goes += 1;
    }
    expect(stops + goes).toBe(60);
    expect(stops).toBeGreaterThan(12);
    expect(goes).toBeGreaterThan(12);
  });

  it('gives the logistic stop probability around b_stop and never a stop past the braking limit', () => {
    const k = FULL.violations.yellowLogisticK;
    expect(yellowStopProbability((12 * 12) / (2 * 3.1), 12, 3.1, 8, k)).toBeCloseTo(0.5, 9);
    expect(yellowStopProbability(60, 12, 3.1, 8, k)).toBeGreaterThan(0.9);
    expect(yellowStopProbability(15, 12, 3.1, 8, k)).toBeLessThan(0.1);
    expect(yellowStopProbability(5, 12, 3.1, 8, k)).toBe(0);
  });
});

describe('red stop lines on osm-pasteur', () => {
  /** @type {GameMap} */
  const PASTEUR = JSON.parse(readFileSync(new URL('../../../public/maps/osm-pasteur.json', import.meta.url), 'utf8'));
  const EGO = Object.freeze({ pos: { x: -40, z: -120 }, heading: 2.4, speed: 0, lengthM: 4.5, widthM: 1.8 });

  /**
   * Fronts that pass a signal's stop line on red over a run, and whether each carried the flag
   * right after.
   * @param {import('../../contracts/traffic.js').TrafficParams} params Params.
   * @param {number} seed Seed.
   * @returns {{crossings: number, unflagged: string[]}} Counts.
   */
  function redCrossings(params, seed) {
    const st = createTraffic(PASTEUR, params, seed);
    let crossings = 0;
    /** @type {string[]} */
    const unflagged = [];
    /** @type {Map<number, {edge: number, front: number}>} */
    const before = new Map();
    for (let i = 0; i < Math.round(180 / DT); i += 1) {
      const t = i * DT;
      const lights = trafficLightStates(PASTEUR, t);
      before.clear();
      for (let a = 0; a < st.activeCount; a += 1) {
        const k = st.active[a];
        const e = st.graph.edges[st.edge[k]];
        if (e.kind === 'lane' && e.signalIndex >= 0) before.set(st.spawnIndex[k], { edge: e.index, front: st.s[k] + st.lengthM[k] / 2 });
      }
      stepTraffic(st, { ego: EGO, egoReset: false, scripted: [], lights, egoContacts: [], t });
      for (const [index, b] of before) {
        const k = st.slotBySpawn.get(index);
        if (k === undefined) continue;
        const e = st.graph.edges[b.edge];
        if (lights[PASTEUR.signals[e.signalIndex].id] !== 'red') continue;
        const onto = st.edge[k] !== b.edge && st.graph.edges[st.edge[k]].kind === 'connector';
        const crossed = b.front <= e.holdS && (onto || (st.edge[k] === b.edge && st.s[k] + st.lengthM[k] / 2 > e.holdS));
        if (!crossed) continue;
        crossings += 1;
        if (!violationsOf(st, k, t + DT).includes('red-light')) unflagged.push(`npc-${index}@${t.toFixed(2)}`);
      }
    }
    return { crossings, unflagged };
  }

  it('lets no lawful driver pass a red stop line, short lanes between two junctions included', () => {
    for (const seed of [1, 2, 3]) expect(redCrossings({ ...LAWFUL, preRollS: FULL.preRollS }, seed).crossings).toBe(0);
  }, 120_000);

  it('flags every red crossing of the whole population', () => {
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const r = redCrossings(FULL, seed);
      total += r.crossings;
      expect(r.unflagged).toEqual([]);
    }
    expect(total).toBeGreaterThan(0);
  }, 120_000);
});

describe('tailgating', () => {
  it('flags a follower whose time gap is under its class threshold, and not one at a safe gap', () => {
    const map = emptyMap('signal');
    const st = createTraffic(map, LAWFUL, 7);
    // The leader's rear is at 75.5; the close follower is 2.3 m behind it at 12 m/s (0.19 s).
    place(st, 'rw-e1', 80, 12, 'car', 'c-rw-e1-re-e0');
    const close = place(st, 'rw-e1', 75.5 - 2.3, 12, 'car', 'c-rw-e1-re-e0');
    const far = place(st, 'rw-e0', 40, 12, 'car', 'c-rw-e0-re-e0');
    const steps = run(st, 0, 0.2, () => EGO_AWAY, allLights(map, 'green'));
    const last = steps.at(-1)?.poses ?? [];
    expect(last.find((p) => p.id === st.ids[close])?.violations).toContain('tailgating');
    expect(last.find((p) => p.id === st.ids[far])?.violations).toEqual([]);
  });
});
