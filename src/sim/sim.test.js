import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFrame } from '../contracts/assert-frame.js';
import { DT, kmhToMps } from '../contracts/units.js';
import { createSim, sanitizeInput } from './index.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-minimal.json', import.meta.url), 'utf8'));
/** @type {VehicleInfo[]} */
const VEHICLES = JSON.parse(readFileSync(new URL('../../data/vehicles/vehicles.json', import.meta.url), 'utf8'));
const CAR = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.id === 'car-sedan'));
const SCOOTER = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.id === 'scooter'));

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * Map copy with overrides.
 * @param {Partial<GameMap>} patch Top-level fields to replace.
 * @returns {GameMap} Map.
 */
function mapWith(patch) {
  return { ...structuredClone(MAP), ...patch };
}

/**
 * Runs a sim with a policy.
 * @param {import('../contracts/index.js').Sim} sim Sim.
 * @param {number} steps Steps.
 * @param {(prev: Frame | null, k: number) => Partial<ControlInput>} policy Input per step.
 * @returns {Frame[]} Frames.
 */
function run(sim, steps, policy) {
  /** @type {Frame[]} */
  const frames = [];
  /** @type {Frame | null} */
  let prev = null;
  for (let k = 0; k < steps; k += 1) {
    prev = sim.step(sanitizeInput(policy(prev, k)));
    frames.push(prev);
  }
  return frames;
}

/**
 * Policy: first gear, hold a target speed with throttle, steer straight along the heading `0`.
 * @param {number} targetMps Speed to hold.
 * @returns {(prev: Frame | null, k: number) => Partial<ControlInput>} Policy.
 */
function cruise(targetMps) {
  return (prev, k) => {
    if (k === 0) return { gearCmd: 'up' };
    const v = prev ? prev.ego.speed : 0;
    const z = prev ? prev.ego.pos.z : 0;
    const heading = prev ? prev.ego.heading : 0;
    // Hold the lane centre z = 1.75 heading east: steer +1 is right (towards +z).
    const steer = Math.max(-1, Math.min(1, 0.3 * (1.75 - z) * -1 + 2 * heading));
    return { throttle: Math.max(0, Math.min(1, 0.6 * (targetMps - v))), steer };
  };
}

/**
 * Collision events of a run.
 * @param {Frame[]} frames Frames.
 * @returns {import('../contracts/index.js').CollisionEvent[]} Events.
 */
function collisions(frames) {
  return frames.flatMap((f) => f.events.filter((e) => e.type === 'collision'));
}

describe('sanitizeInput', () => {
  it('clamps analog values and drops unknown commands', () => {
    const i = sanitizeInput(/** @type {Partial<ControlInput>} */ (/** @type {unknown} */ ({ throttle: 3, steer: -9, brakeFront: NaN, gearCmd: 'sideways', horn: 1 })));
    expect(i).toMatchObject({ throttle: 1, steer: -1, brakeFront: 0, gearCmd: null, horn: false });
    expect(sanitizeInput(null)).toEqual(sanitizeInput({}));
  });
});

describe('createSim', () => {
  it('rejects an uninitialised module, a bad map and an unknown vehicle', () => {
    expect(() => createSim({}, MAP, CAR)).toThrow(TypeError);
    expect(() => createSim(RAPIER, /** @type {GameMap} */ (/** @type {unknown} */ ({ id: 'x' })), CAR)).toThrow();
    expect(() => createSim(RAPIER, MAP, { ...CAR, id: 'tank' })).toThrow(/tuning/);
  });

  it('runs one minute of map-minimal in under 2 s with every frame valid', () => {
    const sim = createSim(RAPIER, MAP, CAR);
    const t0 = performance.now();
    const frames = run(sim, 3600, cruise(kmhToMps(15)));
    const elapsed = performance.now() - t0;
    sim.dispose();
    expect(elapsed).toBeLessThan(2000);
    for (const f of frames) assertFrame(f);
    expect(frames[0].events).toContainEqual({ type: 'run-start' });
    expect(frames[1].t).toBeCloseTo(DT);
    expect(frames[3599].env.clockMin).toBeCloseTo(600 + 3599 * DT / 60);
    // map-minimal: two checkpoints, then the finish at x 185..195.
    const kinds = frames.flatMap((f) => f.events.map((e) => e.type));
    expect(kinds.filter((k) => k === 'checkpoint')).toHaveLength(2);
    expect(kinds).toContain('finish');
    expect(frames[100].ego.gear).toBe(1);
    expect(frames[100].ego.wheels).toHaveLength(4);
    expect(Object.keys(frames[0].trafficLights).sort()).toEqual(['sig-e', 'sig-n', 'sig-s', 'sig-w']);
  });

  it('gives identical frames for the same input script', () => {
    const a = createSim(RAPIER, MAP, CAR);
    const b = createSim(RAPIER, MAP, CAR);
    const fa = run(a, 600, cruise(kmhToMps(40)));
    const fb = run(b, 600, cruise(kmhToMps(40)));
    a.dispose();
    b.dispose();
    expect(fb).toEqual(fa);
  });

  it('brakes a car from 50 km/h to a stop in 11 to 16 m, longer in rain', () => {
    /**
     * @param {GameMap} map Map.
     * @returns {number} Stop distance.
     */
    const stopDistance = (map) => {
      const sim = createSim(RAPIER, map, CAR);
      let braking = false;
      let x0 = 0;
      const frames = run(sim, 900, (prev, k) => {
        if (k === 0) return { gearCmd: 'up' };
        if (prev && !braking && prev.ego.speed >= kmhToMps(50)) {
          braking = true;
          x0 = prev.ego.pos.x;
        }
        if (k === 150) return { gearCmd: 'up', throttle: 1 };
        return braking ? { brakeFront: 1 } : { throttle: 1 };
      });
      sim.dispose();
      expect(braking).toBe(true);
      const stop = frames.find((f, i) => i > 0 && f.ego.speed <= 0.01 && frames[i - 1].ego.input.brakeFront === 1);
      return /** @type {Frame} */ (stop).ego.pos.x - x0;
    };
    const dry = stopDistance(MAP);
    expect(dry).toBeGreaterThan(11);
    expect(dry).toBeLessThan(16);
    const wet = stopDistance(mapWith({ environment: { ...MAP.environment, weather: 'rain', surfaceGrip: 0.6 } }));
    expect(wet).toBeGreaterThan(dry * 1.4);
  });

  it('emits one static collision when the car hits an obstacle at 30 km/h', () => {
    const map = mapWith({
      obstacles: [
        ...MAP.obstacles,
        { id: 'ob-barrier', kind: 'barrier', footprint: [[45, 0.2], [46, 0.2], [46, 3.3], [45, 3.3]], height: 1 },
      ],
    });
    const sim = createSim(RAPIER, map, CAR);
    const frames = run(sim, 600, cruise(kmhToMps(30)));
    sim.dispose();
    const hits = collisions(frames);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ otherKind: 'static', otherId: 'ob-barrier', sameLaneAhead: false });
    expect(hits[0].egoSpeed).toBeGreaterThan(kmhToMps(25));
    expect(hits[0].relSpeed).toBeGreaterThan(kmhToMps(25));
    expect(hits[0].impulse).toBeGreaterThan(1000);
  });

  it('reports a pedestrian and a car ahead in the same lane through the kinematic bodies', () => {
    const standing = { trigger: { atS: 1e6 }, loop: false, speed: 1 };
    /** @type {GameMap['actors']} */
    const ped = [{ id: 'ped-x', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, path: [[30, 1.75], [30, 3]], ...standing }];
    /** @type {GameMap['actors']} */
    const car = [{ id: 'car-x', kind: 'car', model: 'npc-sedan', lengthM: 4.5, widthM: 1.8, path: [[30, 1.75], [31, 1.75]], ...standing }];
    for (const [actors, kind, ahead] of /** @type {const} */ ([[ped, 'pedestrian', false], [car, 'car', true]])) {
      const sim = createSim(RAPIER, mapWith({ actors }), CAR);
      const hits = collisions(run(sim, 600, cruise(kmhToMps(20))));
      sim.dispose();
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ otherKind: kind, otherId: actors[0].id, sameLaneAhead: ahead });
      expect(hits[0].egoSpeed).toBeGreaterThan(kmhToMps(15));
    }
  });

  it('holds an NPC car behind a stationary ego with no collision', () => {
    const map = mapWith({ route: { ...MAP.route, start: { pos: { x: 150, z: -1.75 }, heading: Math.PI } } });
    const sim = createSim(RAPIER, map, CAR);
    const frames = run(sim, 60 * 15, () => ({ brakeFront: 1 }));
    sim.dispose();
    expect(collisions(frames)).toHaveLength(0);
    const last = frames[frames.length - 1];
    const npc = /** @type {import('../contracts/index.js').ActorPose} */ (last.actors.find((a) => a.id === 'npc-1'));
    expect(npc.speed).toBe(0);
    expect(npc.active).toBe(true);
    // NPC rear-to-front gap: centre distance minus two half lengths.
    expect(npc.pos.x - last.ego.pos.x - 4.5).toBeGreaterThan(1);
    expect(Math.abs(last.ego.pos.x - 150)).toBeLessThan(0.1);
  });

  it('drops the scooter on a hard front-only stop and resets it to the start', () => {
    const sim = createSim(RAPIER, MAP, SCOOTER);
    let braking = false;
    const frames = run(sim, 600, (prev) => {
      if (prev && prev.ego.speed >= kmhToMps(40)) braking = true;
      return braking ? { brakeFront: 1 } : { throttle: 1 };
    });
    sim.dispose();
    const fallAt = frames.findIndex((f) => f.events.some((e) => e.type === 'fall'));
    expect(fallAt).toBeGreaterThan(0);
    expect(frames[fallAt].events.some((e) => e.type === 'collision')).toBe(false);
    const after = frames[fallAt + 1];
    expect(after.events).toContainEqual({ type: 'reset' });
    expect(after.ego.pos.x).toBeCloseTo(MAP.route.start.pos.x, 0);
    expect(Math.abs(after.ego.speed)).toBeLessThan(0.2);
    expect(frames.filter((f) => f.events.some((e) => e.type === 'reset'))).toHaveLength(1);
    expect(frames[fallAt].ego.wheels).toHaveLength(2);
    expect(frames[fallAt].ego.gear).toBe('D');
  });

  it('stops the scooter from 50 km/h on both brakes in 11 to 16 m without a fall', () => {
    const sim = createSim(RAPIER, MAP, SCOOTER);
    let braking = false;
    let x0 = 0;
    const frames = run(sim, 900, (prev) => {
      if (prev && !braking && prev.ego.speed >= kmhToMps(50)) {
        braking = true;
        x0 = prev.ego.pos.x;
      }
      return braking ? { brakeFront: 0.5, brakeRear: 1 } : { throttle: 1 };
    });
    sim.dispose();
    expect(braking).toBe(true);
    expect(frames.some((f) => f.events.some((e) => e.type === 'fall'))).toBe(false);
    const stop = /** @type {Frame} */ (frames.find((f) => f.ego.input.brakeRear === 1 && f.ego.speed <= 0.01));
    expect(stop.ego.pos.x - x0).toBeGreaterThan(11);
    expect(stop.ego.pos.x - x0).toBeLessThan(16);
  });

  it('counts a corner hit across two faces of one obstacle as one collision', () => {
    const map = mapWith({
      obstacles: [{ id: 'ob-box', kind: 'barrier', footprint: [[40, 2.5], [44, 2.5], [44, 6], [40, 6]], height: 1 }],
      pavements: [],
    });
    const sim = createSim(RAPIER, map, CAR);
    // Brake for good after the first contact, so the car does not drive into the box again.
    const drive = cruise(kmhToMps(30));
    let hit = false;
    const frames = run(sim, 600, (prev, k) => {
      if (prev && prev.events.some((e) => e.type === 'collision')) hit = true;
      return hit ? { brakeFront: 1 } : drive(prev, k);
    });
    sim.dispose();
    const hits = collisions(frames);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ otherKind: 'static', otherId: 'ob-box' });
  });

  it('drives both vehicles over a kerb at 20 km/h without a launch and reports y near 0 at rest', () => {
    for (const vehicle of [CAR, SCOOTER]) {
      // A pavement strip across the eastbound lane at x 30..33.
      const map = mapWith({ pavements: [{ id: 'pv-x', polygon: [[30, 0], [33, 0], [33, 3.5], [30, 3.5]] }] });
      const sim = createSim(RAPIER, map, vehicle);
      const frames = run(sim, 600, cruise(kmhToMps(20)));
      sim.dispose();
      for (const f of frames) assertFrame(f);
      expect(Math.abs(frames[0].ego.pos.y)).toBeLessThan(0.02);
      expect(Math.max(...frames.map((f) => f.ego.pos.y))).toBeLessThan(0.35);
      expect(frames[frames.length - 1].ego.pos.x).toBeGreaterThan(40);
      expect(frames.some((f) => f.events.some((e) => e.type === 'fall'))).toBe(false);
    }
  });

  it('resets to the last passed checkpoint on reset()', () => {
    const sim = createSim(RAPIER, MAP, CAR);
    const frames = run(sim, 900, cruise(kmhToMps(30)));
    const passed = frames.findIndex((f) => f.events.some((e) => e.type === 'checkpoint'));
    expect(passed).toBeGreaterThan(0);
    sim.reset();
    const f = sim.step(sanitizeInput({}));
    sim.dispose();
    expect(f.events).toContainEqual({ type: 'reset' });
    const cp = MAP.route.checkpoints[f.route.nextCheckpoint - 1];
    expect(f.ego.pos.x).toBeCloseTo(cp.pos.x, 0);
    expect(f.ego.pos.z).toBeCloseTo(cp.pos.z, 0);
  });

  it('emits timeout once at timeLimitS', () => {
    const map = mapWith({ route: { ...MAP.route, timeLimitS: 2 } });
    const sim = createSim(RAPIER, map, CAR);
    const frames = run(sim, 200, () => ({}));
    sim.dispose();
    const timeouts = frames.filter((f) => f.events.some((e) => e.type === 'timeout'));
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].t).toBeGreaterThanOrEqual(2);
    expect(timeouts[0].t).toBeLessThan(2 + DT * 1.5);
  });

  it('carries indicators, lights and horn into the frame', () => {
    const sim = createSim(RAPIER, MAP, CAR);
    /** @type {Partial<ControlInput>[]} */
    const script = [{ signalCmd: 'left' }, { lightsCmd: 'cycle' }, { lightsCmd: 'flash', horn: true }, {}];
    const frames = run(sim, 4, (_, k) => script[k]);
    sim.dispose();
    expect(frames.map((f) => f.ego.indicators)).toEqual(['left', 'left', 'left', 'left']);
    expect(frames.map((f) => f.ego.lights)).toEqual(['off', 'low', 'high', 'low']);
    expect(frames.map((f) => f.ego.horn)).toEqual([false, false, true, false]);
  });

  it('refuses to step after dispose', () => {
    const sim = createSim(RAPIER, MAP, CAR);
    sim.dispose();
    expect(() => sim.step(sanitizeInput({}))).toThrow(/disposed/);
  });
});
