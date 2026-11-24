import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { neutralInput } from '../contracts/controls.js';
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../contracts/telemetry.js';
import { DT } from '../contracts/units.js';
import { createVehicle } from '../physics/vehicle.js';
import { vehicleTuning } from '../physics/vehicles/index.js';
import { createTrafficMirror } from './traffic-mirror.js';
import { buildWorldColliders, drainCollisions, strikerOf } from './world-colliders.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').ActorPose} ActorPose */
/** @typedef {import('../contracts/index.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/index.js').CollisionEvent} CollisionEvent */
/** @typedef {import('../contracts/index.js').NpcViolation} NpcViolation */
/** @typedef {import('../contracts/traffic.js').TrafficParams} TrafficParams */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../generated/traffic-params.json', import.meta.url), 'utf8'));

/** Ego start on map-junction: lane rw-e0, heading east (+x). */
const START = { x: -150, z: 1.75 };

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * A hand-made agent: drives along its heading at a constant speed until the ego touched it, then
 * stops dead as a wreck on the next step, as traffic does with `egoContacts`.
 * @typedef {object} Agent
 * @property {string} id Id.
 * @property {'car' | 'motorbike'} kind Kind.
 * @property {string} model Model key.
 * @property {number} x Centre x.
 * @property {number} z Centre z.
 * @property {number} heading Heading.
 * @property {number} speed Speed.
 * @property {boolean} wreck Wrecked.
 * @property {NpcViolation[]} violations Latched violations.
 */

/**
 * @param {Partial<Agent> & {id: string, model: string, x: number, z: number}} a Agent fields.
 * @returns {Agent} Agent.
 */
function agent(a) {
  const kind = PARAMS.models[a.model].kind;
  return { kind, heading: 0, speed: 0, wreck: false, violations: [], ...a };
}

/**
 * Pose of a hand-made agent.
 * @param {Agent} a Agent.
 * @returns {ActorPose} Pose.
 */
function poseOf(a) {
  const m = PARAMS.models[a.model];
  const speed = a.wreck ? 0 : a.speed;
  return {
    id: a.id,
    kind: m.kind,
    pos: { x: a.x, z: a.z },
    heading: a.heading,
    speed,
    active: true,
    model: a.model,
    variant: 0,
    lengthM: m.lengthM,
    widthM: m.widthM,
    lights: a.wreck ? ACTOR_LIGHTS.hazard : ACTOR_LIGHTS.off,
    state: a.wreck ? (m.kind === 'motorbike' ? 'fallen' : 'crashed') : speed > 0 ? 'moving' : 'stopped',
    violations: a.violations.length > 0 ? a.violations : NO_VIOLATIONS,
  };
}

/**
 * The sim's physics order on a real world, with hand-made agents in place of traffic: poses at
 * `t`, mirror update, ego physics, contact drain; agents named in last step's contacts become wrecks.
 * @param {'car-sedan' | 'scooter'} vehicleId Ego vehicle.
 * @param {{maxMirrored?: number, egoHeading?: number, egoPos?: {x: number, z: number}}} [opts] Options.
 * @returns {{vehicle: import('../physics/vehicle.js').PhysicsVehicle, mirror: import('./traffic-mirror.js').TrafficMirror,
 *   world: import('@dimforge/rapier3d-compat').World, step: (agents: Agent[], input?: Partial<ControlInput>) => CollisionEvent[],
 *   egoPos: () => {x: number, z: number}, dispose: () => void}} Harness.
 */
function harness(vehicleId, opts = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const queue = new RAPIER.EventQueue(true);
  const tags = buildWorldColliders(RAPIER, world, MAP);
  const tuning = vehicleTuning(vehicleId);
  const egoPos = opts.egoPos ?? START;
  const vehicle = createVehicle(RAPIER, world, tuning, 1, egoPos, opts.egoHeading ?? 0);
  const mirror = createTrafficMirror(RAPIER, world, tags, {
    maxMirrored: opts.maxMirrored ?? PARAMS.maxMirrored,
    mirrorRadiusM: PARAMS.mirrorRadiusM,
    egoMassKg: tuning.massKg,
    egoSize: { lengthM: 2 * tuning.chassis.halfLength, widthM: 2 * tuning.chassis.halfWidth },
    massOf: (model) => PARAMS.models[model].massKg,
    dt: DT,
  });
  /** @type {Map<string, number>} */
  const memory = new Map();
  let tick = 0;
  /** @type {string[]} */
  let touched = [];
  const settle = () => {
    for (let k = 0; k < 30; k += 1) {
      vehicle.prepare(neutralInput());
      world.step(queue);
      queue.drainContactForceEvents(() => {});
    }
    vehicle.read();
  };
  settle();
  return {
    vehicle,
    mirror,
    world,
    /**
     * One step.
     * @param {Agent[]} agents Agents, advanced in place.
     * @param {Partial<ControlInput>} [input] Ego input.
     * @returns {CollisionEvent[]} Collision events of the step.
     */
    step(agents, input = {}) {
      for (const a of agents) if (touched.includes(a.id)) a.wreck = true;
      const poses = agents.map(poseOf);
      for (const a of agents) {
        if (a.wreck) continue;
        a.x += Math.cos(a.heading) * a.speed * DT;
        a.z -= Math.sin(a.heading) * a.speed * DT;
      }
      const pre = vehicle.pose();
      mirror.update(poses, pre);
      vehicle.prepare({ ...neutralInput(), ...input });
      world.step(queue);
      const drained = drainCollisions(queue, memory, {
        tick,
        egoHandle: vehicle.collider.handle,
        ego: pre,
        tags,
        motionOf: mirror.motionOf,
        map: MAP,
        strikerShare: PARAMS.strikerShare,
      });
      touched = drained.touchedIds;
      vehicle.read();
      tick += 1;
      return drained.events;
    },
    /** @returns {{x: number, z: number}} Ego body centre. */
    egoPos() {
      const t = vehicle.body.translation();
      return { x: t.x, z: t.z };
    },
    dispose() {
      vehicle.dispose();
      queue.free();
      world.free();
    },
  };
}

const BRAKED = { brakeFront: 1, brakeRear: 1 };

/**
 * An agent drives into the stopped, braked ego from behind in its lane.
 * @param {'car-sedan' | 'scooter'} vehicleId Ego.
 * @param {string} model Agent model.
 * @param {number} speed Agent speed.
 * @param {NpcViolation[]} [violations] Agent violations.
 * @returns {{events: CollisionEvent[], displacementM: number, wreck: boolean, movedBeforeM: number}}
 *   Events, ego displacement 1 s after the first contact, whether the agent ended a wreck, and how
 *   far the ego moved before the step of the collision event.
 */
function rearEnd(vehicleId, model, speed, violations = []) {
  const h = harness(vehicleId);
  const len = PARAMS.models[model].lengthM;
  const a = agent({ id: 'npc-1', model, x: START.x - 12 - len / 2, z: START.z, speed, violations });
  const x0 = h.egoPos().x;
  /** @type {CollisionEvent[]} */
  const events = [];
  let eventStep = -1;
  let movedBeforeM = 0;
  for (let k = 0; k < 60 * 30; k += 1) {
    const before = h.egoPos().x;
    const ev = h.step([a], BRAKED);
    if (ev.length > 0 && eventStep < 0) {
      eventStep = k;
      movedBeforeM = Math.abs(before - x0);
    }
    events.push(...ev);
    if (eventStep >= 0 && k >= eventStep + 60) break;
  }
  const displacementM = h.egoPos().x - x0;
  h.dispose();
  return { events, displacementM, wreck: a.wreck, movedBeforeM };
}

describe('createTrafficMirror', () => {
  it('validates its configuration', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const base = {
      maxMirrored: 4,
      mirrorRadiusM: 30,
      egoMassKg: 1300,
      egoSize: { lengthM: 4.5, widthM: 1.8 },
      massOf: () => 180,
      dt: DT,
    };
    expect(() => createTrafficMirror(RAPIER, world, new Map(), { ...base, maxMirrored: 0 })).toThrow(RangeError);
    expect(() => createTrafficMirror(RAPIER, world, new Map(), { ...base, maxMirrored: 2.5 })).toThrow(RangeError);
    expect(() => createTrafficMirror(RAPIER, world, new Map(), { ...base, mirrorRadiusM: 0 })).toThrow(RangeError);
    expect(() => createTrafficMirror(RAPIER, world, new Map(), { ...base, egoMassKg: -1 })).toThrow(RangeError);
    world.free();
  });

  it('mirrors at most maxMirrored agents in range, nearest first, and keeps slots while in range', () => {
    const h = harness('car-sedan', { maxMirrored: 4 });
    // Six parked cars ahead in lane rw-e1 (z 5.25), 4 m apart, all in range; one beyond the radius.
    const agents = [0, 1, 2, 3, 4, 5].map((i) => agent({ id: `npc-${i}`, model: 'car', x: START.x + 8 + 4 * i, z: 5.25 }));
    agents.push(agent({ id: 'npc-far', model: 'car', x: START.x + 80, z: 5.25 }));
    h.step(agents, BRAKED);
    expect(h.mirror.slots()).toEqual(['npc-0', 'npc-1', 'npc-2', 'npc-3']);
    // A closer agent appears: held slots stay with their agents while in range.
    agents.push(agent({ id: 'npc-new', model: 'motorbike', x: START.x - 6, z: 5.25 }));
    h.step(agents, BRAKED);
    expect(h.mirror.slots()).toEqual(['npc-0', 'npc-1', 'npc-2', 'npc-3']);
    // npc-1 leaves range: its slot goes to the nearest waiting agent.
    agents[1].x = START.x + 200;
    h.step(agents, BRAKED);
    expect(h.mirror.slots()).toEqual(['npc-0', 'npc-new', 'npc-2', 'npc-3']);
    // Every agent gone: all parked.
    h.step([], BRAKED);
    expect(h.mirror.slots()).toEqual([null, null, null, null]);
    h.dispose();
  });

  it('places a newly assigned body without sweeping it from its old place', () => {
    const h = harness('car-sedan', { maxMirrored: 1 });
    // The slot first holds an agent 20 m ahead of the ego in its lane.
    const ahead = agent({ id: 'npc-a', model: 'car', x: START.x + 20, z: START.z });
    for (let k = 0; k < 5; k += 1) expect(h.step([ahead], BRAKED)).toEqual([]);
    // It leaves and a new agent appears 8 m behind the ego: a sweep from the old place would pass
    // through the ego.
    const behind = agent({ id: 'npc-b', model: 'car', x: START.x - 8, z: START.z });
    const x0 = h.egoPos().x;
    expect(h.step([behind], BRAKED)).toEqual([]);
    expect(h.mirror.slots()).toEqual(['npc-b']);
    for (let k = 0; k < 10; k += 1) expect(h.step([behind], BRAKED)).toEqual([]);
    expect(Math.abs(h.egoPos().x - x0)).toBeLessThan(0.01);
    h.dispose();
  });

  it('does not assign an agent that already overlaps the ego', () => {
    const h = harness('car-sedan');
    const inside = agent({ id: 'npc-in', model: 'motorbike', x: START.x + 0.5, z: START.z });
    expect(h.step([inside], BRAKED)).toEqual([]);
    expect(h.mirror.slots().includes('npc-in')).toBe(false);
    h.dispose();
  });
});

describe('mass-scaled contact', () => {
  it('keeps a stopped car within 0.5 m when a motorbike rear-ends it at 8 m/s', () => {
    const r = rearEnd('car-sedan', 'motorbike', 8);
    expect(r.events).toHaveLength(1);
    expect(r.displacementM).toBeLessThanOrEqual(0.5);
    expect(r.wreck).toBe(true);
  });

  it.each([
    ['car-sedan', 'motorbike'],
    ['car-sedan', 'car'],
    ['scooter', 'motorbike'],
    ['scooter', 'car'],
  ])('pushes a stopped %s hit by a %s at 0.5, 3, 8 and 15 m/s by about the momentum share', (egoId, model) => {
    const egoMass = vehicleTuning(egoId).massKg;
    const m = PARAMS.models[model].massKg;
    for (const v of [0.5, 3, 8, 15]) {
      const r = rearEnd(/** @type {'car-sedan' | 'scooter'} */ (egoId), model, v);
      expect(r.events, `${egoId} ${model} ${v}`).toHaveLength(1);
      // The event comes on the step the push begins: nothing moved the ego before it.
      expect(r.movedBeforeM, `${egoId} ${model} ${v}`).toBeLessThan(1e-3);
      expect(r.wreck).toBe(true);
      // The ego leaves the contact at no more than the momentum-share velocity, braked, for 1 s.
      expect(r.displacementM, `${egoId} ${model} ${v}`).toBeLessThan((v * m) / (m + egoMass) * 1 + 0.2);
    }
  });
});

describe('collision attribution', () => {
  it('names the agent as striker from behind when it rear-ends the stopped ego', () => {
    const r = rearEnd('car-sedan', 'motorbike', 8, ['tailgating']);
    expect(r.events[0]).toMatchObject({
      otherKind: 'motorbike',
      otherId: 'npc-1',
      otherModel: 'motorbike',
      striker: 'other',
      otherFromBehind: true,
      otherViolations: ['tailgating'],
      sameLaneAhead: false,
    });
    expect(r.events[0].relSpeed).toBeGreaterThan(6);
  });

  it.each([5, 15])('names the ego as striker when it side-swipes a slower agent at %i m/s', (v) => {
    const h = harness('car-sedan');
    // A motorbike riding east at 2 m/s near the lane line, partly in the ego's path.
    const a = agent({ id: 'npc-7', model: 'motorbike', x: START.x + 8, z: START.z + 1.1, speed: 2 });
    h.vehicle.setForwardSpeed(v);
    /** @type {CollisionEvent[]} */
    const events = [];
    for (let k = 0; k < 600 && events.length === 0; k += 1) events.push(...h.step([a]));
    h.dispose();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ otherKind: 'motorbike', otherId: 'npc-7', striker: 'ego', otherFromBehind: false, sameLaneAhead: true });
    // The closing speed uses the agent's true 2 m/s, not its body's motion.
    expect(events[0].relSpeed).toBeLessThanOrEqual(v - 2 + 0.5);
  });

  it('never calls a hit from behind while the ego reverses', () => {
    const h = harness('car-sedan');
    const a = agent({ id: 'npc-3', model: 'motorbike', x: START.x - 10, z: START.z, speed: 3 });
    h.vehicle.setForwardSpeed(-2);
    /** @type {CollisionEvent[]} */
    const events = [];
    for (let k = 0; k < 240 && events.length === 0; k += 1) events.push(...h.step([a]));
    h.dispose();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ otherId: 'npc-3', otherFromBehind: false });
  });

  it('splits strikers by the closing share', () => {
    expect(strikerOf({ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 8, z: 0 }, 0.65)).toBe('other');
    expect(strikerOf({ x: 1, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 0 }, 0.65)).toBe('ego');
    expect(strikerOf({ x: 1, z: 0 }, { x: 5, z: 0 }, { x: -5, z: 0 }, 0.65)).toBe('both');
    expect(strikerOf({ x: 1, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, 0.65)).toBe('both');
    expect(strikerOf({ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 0, z: 0 }, 0.65)).toBe('both');
  });
});
