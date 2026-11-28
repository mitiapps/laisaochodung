import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFrame } from '../contracts/assert-frame.js';
import { DT, kmhToMps } from '../contracts/units.js';
import { createSim, sanitizeInput } from './index.js';
import { parseAssists, parseRoute } from './sim.js';
import { MAP_EDGE_RESET_M } from './free-run.js';
import { footprint, polygonsIntersect } from '../geometry/index.js';
import { createDriver } from '../../tests/scenarios/physics/driver.js';

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

/**
 * Timeout of the cases that run every shipped map, ms. Each takes about 2 s alone; the shipped
 * maps' building and prop colliders make them slower than the default 5 s allows when the whole
 * suite runs in parallel.
 */
const SHIPPED_MAP_TIMEOUT_MS = 20_000;

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

  it('lets the scooter rider push it back in gear R in valid frames, and the car ignores the push', () => {
    const bike = createSim(RAPIER, MAP, SCOOTER);
    const bikeFrames = run(bike, 180, () => ({ pushBack: true }));
    bike.dispose();
    for (const f of bikeFrames) assertFrame(f);
    expect(bikeFrames.slice(1).every((f) => f.ego.gear === 'R' && f.ego.speed < 0)).toBe(true);
    expect(MAP.route.start.pos.x - bikeFrames[179].ego.pos.x).toBeGreaterThanOrEqual(1);
    const car = createSim(RAPIER, MAP, CAR);
    const carFrames = run(car, 180, () => ({ pushBack: true }));
    car.dispose();
    expect(carFrames.every((f) => f.ego.gear === 'N')).toBe(true);
    expect(Math.abs(carFrames[179].ego.pos.x - MAP.route.start.pos.x)).toBeLessThan(0.05);
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

  it('counts one collision while the car stays pressed against a wall with pulsed throttle', () => {
    const map = mapWith({
      obstacles: [...MAP.obstacles, { id: 'ob-wall', kind: 'barrier', footprint: [[12, 0.2], [13, 0.2], [13, 3.3], [12, 3.3]], height: 1 }],
    });
    const sim = createSim(RAPIER, map, CAR);
    let hitAt = -1;
    const frames = run(sim, 1000, (prev, k) => {
      if (k === 0) return { gearCmd: 'up' };
      if (hitAt < 0 && prev && prev.events.some((e) => e.type === 'collision')) hitAt = k;
      if (hitAt < 0) return { throttle: 0.3 };
      // Never reverse: the car stays on the wall while the push rises and falls each second.
      return { throttle: Math.floor((k - hitAt) / 60) % 2 === 0 ? 0.5 : 0 };
    });
    sim.dispose();
    expect(hitAt).toBeGreaterThan(0);
    const xs = frames.slice(hitAt + 30).map((f) => f.ego.pos.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.05);
    const hits = collisions(frames);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ otherKind: 'static', otherId: 'ob-wall' });
  });

  it('counts a new collision when the car backs off a wall and comes back to it, and one while it then pushes on it', () => {
    const map = mapWith({
      obstacles: [...MAP.obstacles, { id: 'ob-wall', kind: 'barrier', footprint: [[12, 0.2], [13, 0.2], [13, 3.3], [12, 3.3]], height: 1 }],
    });
    const sim = createSim(RAPIER, map, CAR);
    let hitAt = -1;
    const frames = run(sim, 1100, (prev, k) => {
      if (k === 0) return { gearCmd: 'up' };
      if (hitAt < 0 && prev && prev.events.some((e) => e.type === 'collision')) hitAt = k;
      if (hitAt < 0) return { throttle: 0.3 };
      const t = k - hitAt;
      // Back off for 2 s, creep onto the wall below 0.4 m/s and rest on it, then push hard.
      if (t === 1 || t === 3) return { gearCmd: 'down' };
      if (t < 60) return { throttle: 0.3 };
      if (t < 120) return { brake: 1 };
      if (t === 120 || t === 122) return { gearCmd: 'up' };
      if (t < 840) return { throttle: prev.ego.speed < 0.4 ? 0.12 : 0 };
      return { throttle: 1 };
    });
    sim.dispose();
    expect(hitAt).toBeGreaterThan(0);
    const hits = collisions(frames).filter((e) => e.otherId === 'ob-wall');
    expect(hits).toHaveLength(2);
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

describe('createSim assists option', () => {
  /** @type {GameMap[]} */
  const SHIPPED = JSON.parse(readFileSync(new URL('../../public/maps/index.json', import.meta.url), 'utf8')).map(
    (/** @type {{id: string}} */ m) => JSON.parse(readFileSync(new URL(`../../public/maps/${m.id}.json`, import.meta.url), 'utf8')),
  );

  /**
   * Policy that uses every control: gears, throttle, steering, brakes, indicators, lights, horn.
   * @param {Frame | null} _prev Last frame.
   * @param {number} k Step.
   * @returns {Partial<ControlInput>} Input.
   */
  const busy = (_prev, k) => ({
    throttle: k < 300 ? 0.7 : 0,
    brakeFront: k >= 400 ? 0.5 : 0,
    steer: Math.sin(k / 50) * 0.3,
    gearCmd: k === 0 || k === 120 ? 'up' : null,
    signalCmd: k === 10 ? 'left' : k === 200 ? 'right' : null,
    lightsCmd: k === 5 ? 'cycle' : null,
    horn: k % 97 === 0,
  });

  it('gives frames equal to no options with the assists absent or off, on every shipped map', () => {
    expect(SHIPPED.length).toBeGreaterThan(0);
    for (const map of SHIPPED) {
      for (const veh of [CAR, SCOOTER]) {
        const base = createSim(RAPIER, map, veh);
        const fBase = run(base, 600, busy);
        base.dispose();
        for (const options of [{}, { assists: { autoGearbox: false, signalAutoCancel: null } }]) {
          const sim = createSim(RAPIER, map, veh, options);
          const f = run(sim, 600, busy);
          sim.dispose();
          expect(f, `${map.id} ${veh.id}`).toEqual(fBase);
        }
      }
    }
  }, SHIPPED_MAP_TIMEOUT_MS);

  it('starts the car in D with autoGearbox and keeps the scooter unchanged', () => {
    const car = createSim(RAPIER, MAP, CAR, { assists: { autoGearbox: true, signalAutoCancel: null } });
    const frames = run(car, 300, (prev) => ({ throttle: 1, steer: prev ? 2 * prev.ego.heading : 0 }));
    car.dispose();
    expect(frames[0].ego.gear).toBe('D');
    expect(frames.every((f) => f.ego.gear === 'D')).toBe(true);
    expect(frames[299].ego.speed).toBeGreaterThan(kmhToMps(20));
    // The rpm falls at each up-shift.
    const drops = frames.filter((f, i) => i > 0 && f.ego.rpm < frames[i - 1].ego.rpm - 300);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('validates the assists', () => {
    expect(parseAssists(undefined)).toEqual({ autoGearbox: false, signalAutoCancel: null });
    expect(parseAssists({})).toEqual({ autoGearbox: false, signalAutoCancel: null });
    expect(parseAssists({ autoGearbox: true, signalAutoCancel: { turnMinDeg: 45, clearM: 30 } })).toEqual({
      autoGearbox: true,
      signalAutoCancel: { turnMinDeg: 45, clearM: 30 },
    });
    expect(() => parseAssists(null)).toThrow(TypeError);
    expect(() => parseAssists({ autoGearbox: 'yes' })).toThrow(TypeError);
    expect(() => parseAssists({ signalAutoCancel: 30 })).toThrow(TypeError);
    expect(() => parseAssists({ signalAutoCancel: { turnMinDeg: 0, clearM: 30 } })).toThrow(RangeError);
    expect(() => parseAssists({ signalAutoCancel: { turnMinDeg: 45, clearM: -1 } })).toThrow(RangeError);
    expect(() => parseAssists({ signalAutoCancel: { turnMinDeg: 45 } })).toThrow(RangeError);
    expect(() => createSim(RAPIER, MAP, CAR, /** @type {never} */ (null))).toThrow(TypeError);
    expect(() => createSim(RAPIER, MAP, CAR, { assists: /** @type {never} */ ({ autoGearbox: 1 }) })).toThrow(TypeError);
  });
});

describe('createSim traffic option', () => {
  /** @type {GameMap} */
  const JUNCTION = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
  /** @type {import('../contracts/traffic.js').TrafficParams} */
  const PARAMS = JSON.parse(readFileSync(new URL('../generated/traffic-params.json', import.meta.url), 'utf8'));
  /** @type {GameMap[]} */
  const SHIPPED = JSON.parse(readFileSync(new URL('../../public/maps/index.json', import.meta.url), 'utf8')).map(
    (/** @type {{id: string}} */ m) => JSON.parse(readFileSync(new URL(`../../public/maps/${m.id}.json`, import.meta.url), 'utf8')),
  );
  const TRAFFIC = /** @type {const} */ ({ traffic: 'map', params: PARAMS, runSeed: 7 });
  /** map-junction with the start mid-way along rw-e1, so traffic from the lane's source runs up behind the ego. */
  const MID_LANE = structuredClone(JUNCTION);
  MID_LANE.route.start = { pos: { x: -60, z: 1.75 }, heading: 0 };

  /**
   * Same policy as the assists block: every control in use.
   * @param {Frame | null} _prev Last frame.
   * @param {number} k Step.
   * @returns {Partial<ControlInput>} Input.
   */
  const busy = (_prev, k) => ({
    throttle: k < 300 ? 0.7 : 0,
    brakeFront: k >= 400 ? 0.5 : 0,
    steer: Math.sin(k / 50) * 0.3,
    gearCmd: k === 0 || k === 120 ? 'up' : null,
    signalCmd: k === 10 ? 'left' : k === 200 ? 'right' : null,
    lightsCmd: k === 5 ? 'cycle' : null,
    horn: k % 97 === 0,
  });

  /**
   * Holds the lane centre of map-junction's rw-e0 heading east.
   * @param {Frame | null} f Last frame.
   * @returns {number} Steer.
   */
  const holdLane = (f) => (f ? Math.max(-1, Math.min(1, -0.3 * (1.75 - f.ego.pos.z) + 2 * f.ego.heading)) : 0);

  /**
   * Whether a traffic pose overlaps the ego footprint of a frame.
   * @param {Frame} f Frame.
   * @returns {boolean} Some agent overlaps the ego.
   */
  const agentOverlapsEgo = (f) =>
    f.actors.some((a) => a.id.startsWith('npc-') && polygonsIntersect(footprint(a.pos, a.heading, a.lengthM, a.widthM), f.ego.footprint));

  it('gives the frames of a sim without traffic when off, absent, or the map has no traffic block', () => {
    for (const map of [...SHIPPED, JUNCTION]) {
      const noTraffic = { ...structuredClone(map) };
      delete noTraffic.traffic;
      for (const veh of [CAR, SCOOTER]) {
        const base = createSim(RAPIER, map, veh);
        const fBase = run(base, 600, busy);
        base.dispose();
        for (const [m, options] of /** @type {const} */ ([
          [map, { traffic: 'off' }],
          [map, { traffic: 'off', params: PARAMS, runSeed: 3 }],
          [noTraffic, TRAFFIC],
        ])) {
          const sim = createSim(RAPIER, m, veh, options);
          const f = run(sim, 600, busy);
          sim.dispose();
          expect(JSON.stringify(f), `${map.id} ${veh.id} ${options.traffic}`).toBe(JSON.stringify(fBase));
        }
      }
    }
  }, SHIPPED_MAP_TIMEOUT_MS);

  it('validates the traffic options', () => {
    expect(() => createSim(RAPIER, JUNCTION, CAR, { traffic: /** @type {never} */ ('on') })).toThrow(RangeError);
    expect(() => createSim(RAPIER, JUNCTION, CAR, { traffic: 'map', params: PARAMS, runSeed: -1 })).toThrow(RangeError);
    expect(() => createSim(RAPIER, JUNCTION, CAR, { traffic: 'map', params: PARAMS, runSeed: 1.5 })).toThrow(RangeError);
    expect(() => createSim(RAPIER, JUNCTION, CAR, { traffic: 'map' })).toThrow(/params/);
    expect(() => createSim(RAPIER, JUNCTION, CAR, { traffic: 'map', params: /** @type {never} */ ({ ...PARAMS, maxMirrored: 2.5 }) })).toThrow(/maxMirrored/);
  });

  it('times the world step and mirror with an injected clock and leaves the frames unchanged', () => {
    let clock = 0;
    // Each clock read advances 0.25 ms, so a timed step reads exactly two of them.
    const now = () => (clock += 0.25);
    const timed = createSim(RAPIER, JUNCTION, CAR, { ...TRAFFIC, now });
    const plain = createSim(RAPIER, JUNCTION, CAR, TRAFFIC);
    expect(timed.trafficMs?.()).toBeNull();
    expect(plain.trafficMs?.()).toBeNull();
    const ft = run(timed, 120, busy);
    const fp = run(plain, 120, busy);
    expect(timed.trafficMs?.()).toBe(0.25);
    expect(clock).toBe(120 * 0.5);
    expect(plain.trafficMs?.()).toBeNull();
    timed.dispose();
    plain.dispose();
    expect(JSON.stringify(ft)).toBe(JSON.stringify(fp));
    expect(() => createSim(RAPIER, JUNCTION, CAR, { ...TRAFFIC, now: /** @type {never} */ (5) })).toThrow(/now/);
  });

  it('steps traffic after the scripted actors and gives equal frames for the same seed and input', () => {
    const map = structuredClone(JUNCTION);
    map.actors = [{ id: 'ped-x', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, path: [[-60, 12], [-60, 14]], trigger: { atS: 1e6 }, loop: false, speed: 1 }];
    /** @type {(prev: Frame | null, k: number) => Partial<ControlInput>} */
    const drive = (prev, k) => ({ gearCmd: k === 0 ? 'up' : null, throttle: k < 900 ? 0.35 : 0, brakeFront: k >= 900 ? 1 : 0, steer: holdLane(prev) });
    const a = createSim(RAPIER, map, CAR, TRAFFIC);
    const b = createSim(RAPIER, map, CAR, TRAFFIC);
    const fa = run(a, 3600, drive);
    const fb = run(b, 3600, drive);
    a.dispose();
    b.dispose();
    expect(JSON.stringify(fb)).toBe(JSON.stringify(fa));
    for (const f of fa.filter((_, i) => i % 60 === 0)) assertFrame(f);
    expect(fa[0].actors[0].id).toBe('ped-x');
    expect(fa[0].actors.length).toBeGreaterThan(5);
    for (const f of fa) {
      expect(f.actors[0].id).toBe('ped-x');
      const npc = f.actors.slice(1).map((p) => Number(p.id.slice(4)));
      expect(npc).toEqual([...npc].sort((x, y) => x - y));
    }
    // Another seed gives other traffic.
    const c = createSim(RAPIER, map, CAR, { ...TRAFFIC, runSeed: 8 });
    const fc = run(c, 60, drive);
    c.dispose();
    expect(JSON.stringify(fc[59].actors)).not.toBe(JSON.stringify(fa[59].actors));
  }, SHIPPED_MAP_TIMEOUT_MS);

  it('wrecks the agent the reversing ego backs into, with the ego as striker', () => {
    const sim = createSim(RAPIER, MID_LANE, CAR, { ...TRAFFIC, assists: { autoGearbox: true, signalAutoCancel: null } });
    // Wait braked in rw-e1 until an agent stands close behind.
    /** @type {Frame} */
    let f = sim.step({ brakeFront: 1 });
    let behind = null;
    for (let k = 0; k < 60 * 60 && behind === null; k += 1) {
      f = sim.step({ brakeFront: 1 });
      behind =
        f.actors.find(
          (a) => a.id.startsWith('npc-') && a.state === 'stopped' && Math.abs(a.pos.z - 1.75) < 1 && a.pos.x < f.ego.pos.x && f.ego.pos.x - a.pos.x < 2.25 + a.lengthM / 2 + 4,
        ) ?? null;
    }
    expect(behind).not.toBeNull();
    const target = /** @type {import('../contracts/index.js').ActorPose} */ (behind).id;
    sim.step({ gearCmd: 'down' });
    sim.step({ gearCmd: 'down' });
    /** @type {import('../contracts/index.js').CollisionEvent | null} */
    let hit = null;
    for (let k = 0; k < 600 && hit === null; k += 1) {
      f = sim.step({ throttle: 0.3, steer: 0 });
      hit = /** @type {import('../contracts/index.js').CollisionEvent | undefined} */ (f.events.find((e) => e.type === 'collision')) ?? null;
    }
    const next = sim.step({ brakeFront: 1 });
    sim.dispose();
    expect(f.ego.gear).toBe('R');
    expect(hit).toMatchObject({ otherId: target, striker: 'ego', otherFromBehind: false, otherViolations: [] });
    expect(/** @type {import('../contracts/index.js').CollisionEvent} */ (hit).otherModel).toBe(next.actors.find((a) => a.id === target)?.model);
    const wreck = next.actors.find((a) => a.id === target);
    expect(wreck?.speed).toBe(0);
    expect(['crashed', 'fallen']).toContain(wreck?.state);
  });

  it('resets the ego onto a following agent without a contact burst or an overlap', () => {
    const sim = createSim(RAPIER, MID_LANE, CAR, TRAFFIC);
    const start = MID_LANE.route.start;
    const startFp = footprint(start.pos, start.heading, CAR.lengthM, CAR.widthM);
    /** @type {Frame | null} */
    let f = null;
    let reset = false;
    // Creep ahead short of the first checkpoint (x −40), stop, and let the queue behind close up
    // over the start; reset as soon as an agent covers the start pose.
    for (let k = 0; k < 60 * 90 && !reset; k += 1) {
      const go = f === null || f.ego.pos.x < -50;
      f = sim.step({ gearCmd: k === 0 ? 'up' : null, throttle: go ? 0.3 : 0, brakeFront: go ? 0 : 1, steer: holdLane(f) });
      if (f.ego.pos.x > -55 && f.actors.some((a) => a.id.startsWith('npc-') && polygonsIntersect(footprint(a.pos, a.heading, a.lengthM, a.widthM), startFp))) {
        sim.reset();
        reset = true;
      }
    }
    expect(reset).toBe(true);
    const after = run(sim, 120, () => ({ brakeFront: 1 }));
    sim.dispose();
    expect(after[0].events).toContainEqual({ type: 'reset' });
    expect(after.some(agentOverlapsEgo)).toBe(false);
    expect(collisions(after)).toEqual([]);
    for (const x of after) {
      expect(Math.abs(x.ego.pos.x - start.pos.x)).toBeLessThan(0.3);
      expect(Math.abs(x.ego.speed)).toBeLessThan(0.5);
    }
  });

  it('gives a static collision with a solid tree and none with a non-solid prop', () => {
    for (const solid of [true, false]) {
      const map = mapWith({ props: [{ id: 'p-tree-x', kind: 'tree', pos: { x: 45, z: 1.75 }, heading: 0, solid }] });
      const sim = createSim(RAPIER, map, CAR);
      const frames = run(sim, 600, cruise(kmhToMps(25)));
      sim.dispose();
      const hits = collisions(frames);
      if (solid) {
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ otherKind: 'static', otherId: 'p-tree-x', sameLaneAhead: false });
        expect(hits[0]).not.toHaveProperty('striker');
      } else {
        expect(hits).toEqual([]);
      }
    }
  });

  it('makes the ego the striker against a static with traffic on', () => {
    const map = structuredClone(MID_LANE);
    map.obstacles.push({ id: 'ob-x', kind: 'barrier', footprint: [[-45, 0.2], [-44, 0.2], [-44, 3.3], [-45, 3.3]], height: 1 });
    const sim = createSim(RAPIER, map, CAR, TRAFFIC);
    const frames = run(sim, 600, (prev, k) => ({ gearCmd: k === 0 ? 'up' : null, throttle: 0.5, steer: holdLane(prev) }));
    sim.dispose();
    const hits = collisions(frames).filter((e) => e.otherId === 'ob-x');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ otherKind: 'static', striker: 'ego', otherModel: null, otherFromBehind: false, otherViolations: [] });
  });

  it('keeps the auto-shift and indicator auto-cancel assists with traffic on', () => {
    // Left at j1 into the northbound lane with the scenario driver, which signals before the
    // junction; its own indicator commands are dropped after the exit so the cancel is the assist's.
    /** @type {import('../contracts/index.js').Vec2[]} */
    const path = [[-150, 1.75], [-7, 1.75]];
    for (let k = 1; k <= 40; k += 1) {
      const p = ((Math.PI / 2) * k) / 40;
      path.push([-7 + 8.75 * Math.sin(p), -7 + 8.75 * Math.cos(p)]);
    }
    path.push([1.75, -120]);
    // The driver does not see traffic, so traffic runs only in the parallel lane rw-e0 (straight on
    // or right at j1), clear of the ego's lane and its left turn.
    const map = structuredClone(JUNCTION);
    const block = /** @type {NonNullable<GameMap['traffic']>} */ (map.traffic);
    block.sources = [{ laneId: 'rw-e0', ratePerH: 900 }];
    block.densityPerKm = { rw: 0, re: 0, rn: 0, rs: 0 };
    const driver = createDriver(map, 'car-sedan', { path, maxS: 230 });
    const sim = createSim(RAPIER, map, CAR, { ...TRAFFIC, assists: { autoGearbox: true, signalAutoCancel: { turnMinDeg: 45, clearM: 30 } } });
    /** @type {Frame[]} */
    const frames = [];
    /** @type {Frame | null} */
    let f = null;
    let exited = false;
    for (let k = 0; k < 60 * 60 && !(f && f.ego.pos.z < -60); k += 1) {
      let input = driver.next(f);
      if (exited) input = { ...input, signalCmd: null };
      f = sim.step(input);
      frames.push(f);
      if (f.ego.pos.z < -7.5) exited = true;
    }
    sim.dispose();
    expect(/** @type {Frame} */ (f).ego.pos.z).toBeLessThan(-60);
    expect(frames.some((x) => x.actors.some((a) => a.id.startsWith('npc-') && Math.hypot(a.pos.x - x.ego.pos.x, a.pos.z - x.ego.pos.z) < 20))).toBe(true);
    expect(collisions(frames)).toEqual([]);
    expect(new Set(frames.map((x) => x.ego.gear))).toEqual(new Set(['D']));
    const cancel = frames.findIndex((x, i) => i > 0 && frames[i - 1].ego.indicators === 'left' && x.ego.indicators === 'off' && x.ego.input.signalCmd === null);
    expect(cancel).toBeGreaterThan(0);
    expect(frames[cancel].ego.pos.z).toBeLessThan(-7);
  });
});

describe('createSim route option', () => {
  /**
   * Event types of a run.
   * @param {Frame[]} frames Frames.
   * @returns {string[]} Types.
   */
  const kinds = (frames) => frames.flatMap((f) => f.events.map((e) => e.type));

  it('accepts map or off and rejects anything else', () => {
    expect(parseRoute(undefined)).toBe('map');
    expect(parseRoute('off')).toBe('off');
    expect(() => parseRoute('free')).toThrow(RangeError);
    expect(() => createSim(RAPIER, MAP, CAR, /** @type {import('../contracts/index.js').SimOptions} */ (/** @type {unknown} */ ({ route: 1 })))).toThrow(RangeError);
  });

  it('runs twice the time limit over every checkpoint and the finish with no route event and a null route', () => {
    const map = mapWith({ route: { ...MAP.route, timeLimitS: 20 } });
    const sim = createSim(RAPIER, map, CAR, { route: 'off' });
    const drive = cruise(kmhToMps(30));
    // Stop short of the lanes' far end, so the run stays well inside the map edge.
    const frames = run(sim, Math.round(40 / DT), (prev, k) => (prev && prev.ego.pos.x > 192 ? { brakeFront: 1 } : drive(prev, k)));
    sim.dispose();
    for (const f of frames) assertFrame(f);
    expect(Math.max(...frames.map((f) => f.ego.pos.x))).toBeGreaterThan(190);
    expect(frames[frames.length - 1].t).toBeGreaterThan(2 * 20 - 0.1);
    expect(frames.every((f) => f.route === null)).toBe(true);
    const k = kinds(frames);
    for (const type of ['checkpoint', 'finish', 'timeout', 'reset']) expect(k).not.toContain(type);
    expect(k).toContain('run-start');
  });

  it('resets a fallen scooter onto the nearest lane point, facing along it, within 5 m of the fall', () => {
    const sim = createSim(RAPIER, MAP, SCOOTER, { route: 'off' });
    let braking = false;
    const frames = run(sim, 600, (prev) => {
      if (prev && prev.ego.speed >= kmhToMps(40)) braking = true;
      return braking ? { brakeFront: 1 } : { throttle: 1 };
    });
    sim.dispose();
    const fallAt = frames.findIndex((f) => f.events.some((e) => e.type === 'fall'));
    expect(fallAt).toBeGreaterThan(0);
    const fell = frames[fallAt].ego.pos;
    const after = frames[fallAt + 1];
    expect(after.events).toContainEqual({ type: 'reset' });
    expect(Math.hypot(after.ego.pos.x - fell.x, after.ego.pos.z - fell.z)).toBeLessThan(5);
    // Never back to the start: the lane rw-e runs east along z = 1.75.
    expect(after.ego.pos.x - MAP.route.start.pos.x).toBeGreaterThan(10);
    expect(after.ego.pos.z).toBeCloseTo(1.75, 1);
    expect(Math.abs(after.ego.heading)).toBeLessThan(0.01);
    expect(Math.abs(after.ego.speed)).toBeLessThan(0.2);
    expect(after.route).toBeNull();
  });

  it('puts reset() on the nearest lane point too, not on a checkpoint', () => {
    const sim = createSim(RAPIER, MAP, CAR, { route: 'off' });
    const frames = run(sim, 600, cruise(kmhToMps(30)));
    const x = frames[frames.length - 1].ego.pos.x;
    sim.reset();
    const f = sim.step(sanitizeInput({}));
    sim.dispose();
    expect(f.events).toContainEqual({ type: 'reset' });
    expect(Math.abs(f.ego.pos.x - x)).toBeLessThan(1);
    expect(f.ego.pos.z).toBeCloseTo(1.75, 1);
  });

  it('resets an ego that rides more than 60 m outside the lanes back onto the nearest lane', () => {
    // Start 50 m west of the lanes (they begin at x 0) heading west, away from them.
    const map = mapWith({ route: { ...MAP.route, start: { pos: { x: -50, z: 1.75 }, heading: Math.PI } } });
    const sim = createSim(RAPIER, map, SCOOTER, { route: 'off' });
    const frames = run(sim, 900, () => ({ throttle: 0.5 }));
    sim.dispose();
    const at = frames.findIndex((f) => f.events.some((e) => e.type === 'reset'));
    expect(at).toBeGreaterThan(0);
    expect(frames.filter((f) => f.events.some((e) => e.type === 'reset'))).toHaveLength(1);
    // The step before the reset is the first one past the margin.
    expect(-frames[at - 1].ego.pos.x).toBeGreaterThan(MAP_EDGE_RESET_M);
    expect(-frames[at - 2].ego.pos.x).toBeLessThanOrEqual(MAP_EDGE_RESET_M);
    expect(frames[at].ego.pos.x).toBeCloseTo(0, 0);
    expect(frames[at].ego.pos.z).toBeCloseTo(1.75, 1);
    expect(Math.abs(frames[at].ego.heading)).toBeLessThan(0.01);
  });

  it('does not reset at the map edge with the route on', () => {
    const map = mapWith({ route: { ...MAP.route, start: { pos: { x: -50, z: 1.75 }, heading: Math.PI } } });
    const sim = createSim(RAPIER, map, SCOOTER);
    const frames = run(sim, 600, () => ({ throttle: 0.5 }));
    sim.dispose();
    expect(kinds(frames)).not.toContain('reset');
    expect(frames[frames.length - 1].ego.pos.x).toBeLessThan(-60);
  });
});
