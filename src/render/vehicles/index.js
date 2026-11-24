/**
 * Model registry:
 *
 * - the player vehicle configs by vehicle id, and the scripted actor configs by map actor `model`
 *   key (unknown keys fall back to a generic config of the actor kind, so a map never fails to
 *   draw because of a model name);
 * - the looks of every actor model key, scripted or traffic (`resolveLook`): which instanced model
 *   draws a pose and in which colours.
 */

import carSedan from './car-sedan.js';
import scooter from './scooter.js';
import { KENNEY_WHEELS } from './model-config.js';
import { MOTORBIKE_TYPES } from './motorbike.js';

/** @typedef {import('./model-config.js').ModelConfig} ModelConfig */
/** @typedef {import('./model-config.js').KenneyBody} KenneyBody */
/** @typedef {import('../../contracts/telemetry.js').ActorPose} ActorPose */

/** @type {Readonly<Record<string, ModelConfig>>} */
export const VEHICLE_MODELS = Object.freeze({ 'car-sedan': carSedan, scooter });

/**
 * Scripted actor model keys a map may use. All Kenney Car Kit models (CC0).
 * @type {Readonly<Record<string, ModelConfig>>}
 */
export const ACTOR_MODELS = Object.freeze({
  'npc-sedan': {
    id: 'npc-sedan',
    kind: 'car',
    glb: 'models/car-kit/taxi.glb',
    wheelNodes: [...KENNEY_WHEELS],
    wheelRadiusM: 0.32,
    heightM: 1.45,
    color: 0xe0b020,
  },
  'npc-hatchback': {
    id: 'npc-hatchback',
    kind: 'car',
    glb: 'models/car-kit/hatchback-sports.glb',
    wheelNodes: [...KENNEY_WHEELS],
    wheelRadiusM: 0.32,
    heightM: 1.4,
    color: 0xb03030,
  },
  pedestrian: {
    id: 'pedestrian',
    kind: 'pedestrian',
    glb: null,
    wheelNodes: [],
    wheelRadiusM: 0,
    heightM: 1.65,
    color: 0x2b6cb0,
  },
});

/**
 * Kenney Car Kit bodies drawn by the traffic and scripted cars.
 * @type {Readonly<Record<string, KenneyBody>>}
 */
export const KENNEY_BODIES = Object.freeze({
  sedan: { glb: 'models/car-kit/sedan.glb', paint: [[6, 1]] },
  taxi: { glb: 'models/car-kit/taxi.glb', paint: [[4, 1]] },
  'hatchback-sports': { glb: 'models/car-kit/hatchback-sports.glb', paint: [[3, 1]] },
  suv: { glb: 'models/car-kit/suv.glb', paint: [[3, 1]] },
  van: { glb: 'models/car-kit/van.glb', paint: [[7, 1]] },
  truck: { glb: 'models/car-kit/truck.glb', paint: [[3, 1]] },
  delivery: { glb: 'models/car-kit/delivery.glb', paint: [[3, 1]] },
  'truck-flat': { glb: 'models/car-kit/truck-flat.glb', paint: [[6, 2]] },
});

/** Car Kit debris pieces (CC0) dropped where a vehicle crashed. */
export const DEBRIS = Object.freeze(['models/car-kit/debris-bumper.glb', 'models/car-kit/debris-door.glb', 'models/car-kit/debris-tire.glb']);

/** Mini Characters (CC0) that ride motorbikes, in rider order. */
export const RIDERS = Object.freeze(['models/mini-characters/character-male-b.glb', 'models/mini-characters/character-female-b.glb']);
/** Mini Character that rides pillion. */
export const PASSENGER = 'models/mini-characters/character-female-e.glb';
/** Mini Characters that walk as scripted pedestrians, in map order. */
export const WALKERS = Object.freeze([
  'models/mini-characters/character-male-a.glb',
  'models/mini-characters/character-female-c.glb',
  'models/mini-characters/character-male-e.glb',
  'models/mini-characters/character-female-e.glb',
]);

/**
 * Paint colours (sRGB hex). Weighted by repetition towards what Ho Chi Minh City streets show:
 * mostly white, silver, grey and black cars; brighter scooters; helmets in every colour (drawing
 * choices).
 */
const CAR_PAINTS = Object.freeze([0xf2f2f0, 0xf2f2f0, 0xb9bdc3, 0xb9bdc3, 0x1d1f23, 0x6b7079, 0x8c1c1c, 0x1f4e8c, 0xc8b89a]);
const TRUCK_PAINTS = Object.freeze([0xf2f2f0, 0xf2f2f0, 0x2a5db0, 0x2f8a4a, 0xd9a400, 0x8c1c1c]);
const BIKE_PAINTS = Object.freeze([0xf2f2f0, 0x1d1f23, 0xb02525, 0x9aa0a8, 0x2a5db0, 0x5a3a2a, 0xd86a9a, 0x1d1f23, 0xf2f2f0]);
const HELMET_PAINTS = Object.freeze([0xf2f2f0, 0xc0262d, 0x2563eb, 0xe8c21a, 0x1d1f23, 0xe58bb4, 0x2f8a4a, 0x9aa0a8]);
/** Taxi liveries by variant: green, white, cyan (the three common colours of HCMC taxi fleets). */
const TAXI_LIVERIES = Object.freeze([0x1f9d55, 0xf4f4f4, 0x22b8cc]);

/** Share of motorbikes that carry a passenger (a drawing choice). */
export const PASSENGER_SHARE = 0.2;

/**
 * How a pose is drawn.
 * @typedef {object} Look
 * @property {'kenney' | 'bike' | 'bus'} family Model family.
 * @property {string} body Kenney body key, motorbike type, or `bus`.
 * @property {number} rider Rider index into `RIDERS` (motorbikes only, else 0).
 * @property {boolean} passenger A passenger rides pillion (motorbikes only).
 * @property {number | null} paintA Body paint (sRGB hex), or null to keep the model's own paint.
 * @property {number | null} paintB Helmet paint, or null.
 */

/** @type {Readonly<Record<string, readonly string[]>>} Kenney bodies of each car model key. */
const CAR_BODIES = Object.freeze({
  car: ['sedan', 'hatchback-sports', 'suv'],
  taxi: ['taxi'],
  truck: ['truck', 'delivery', 'van', 'truck-flat'],
  'npc-sedan': ['taxi'],
  'npc-hatchback': ['hatchback-sports'],
});

/**
 * 32-bit FNV-1a hash of a string.
 * @param {string} text Text.
 * @returns {number} Hash.
 */
export function hashId(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic pick from a list.
 * @template T
 * @param {readonly T[]} list List.
 * @param {number} seed Seed.
 * @param {number} salt Salt per choice, so choices from one seed are independent.
 * @returns {T} Item.
 */
function pick(list, seed, salt) {
  const h = Math.imul((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0, 0x85ebca6b) >>> 0;
  return list[((h ^ (h >>> 13)) >>> 0) % list.length];
}

/**
 * Look of a pose. Deterministic: the pose `variant` and the actor id choose the model, colours,
 * rider and passenger, so an agent looks the same in every frame and in a replay. The variant
 * alone has too few values (`TrafficParams.models[*].variants`) to vary colour, helmet, rider
 * and passenger, so the id adds the rest.
 * @param {Pick<ActorPose, 'id' | 'kind' | 'model' | 'variant'>} pose Pose.
 * @returns {Look} Look.
 */
export function resolveLook(pose) {
  const seed = (hashId(pose.id) ^ Math.imul(pose.variant + 1, 0x27d4eb2d)) >>> 0;
  if (pose.kind === 'motorbike') {
    return {
      family: 'bike',
      body: MOTORBIKE_TYPES[pose.variant % MOTORBIKE_TYPES.length],
      rider: seed % RIDERS.length,
      passenger: pick([0, 1, 2, 3, 4], seed, 3) < PASSENGER_SHARE * 5,
      paintA: pick(BIKE_PAINTS, seed, 1),
      paintB: pick(HELMET_PAINTS, seed, 2),
    };
  }
  if (pose.model === 'bus') return { family: 'bus', body: 'bus', rider: 0, passenger: false, paintA: null, paintB: null };
  const scripted = pose.model in ACTOR_MODELS;
  const bodies = CAR_BODIES[pose.model] ?? CAR_BODIES.car;
  const body = pick(bodies, seed, 4);
  /** @type {number | null} */
  let paintA = null;
  if (pose.model === 'taxi') paintA = TAXI_LIVERIES[pose.variant % TAXI_LIVERIES.length];
  else if (!scripted) paintA = pick(pose.model === 'truck' ? TRUCK_PAINTS : CAR_PAINTS, seed, 1);
  return { family: 'kenney', body, rider: 0, passenger: false, paintA, paintB: null };
}

/**
 * Config of the player vehicle; an unknown id gets a box car or the procedural scooter of its
 * legal class.
 * @param {string} vehicleId Vehicle id.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Legal class.
 * @returns {ModelConfig} Config.
 */
export function vehicleModel(vehicleId, legalClass) {
  const known = VEHICLE_MODELS[vehicleId];
  if (known) return known;
  if (legalClass === 'car') {
    return { id: vehicleId, kind: 'car', glb: null, wheelNodes: [], wheelRadiusM: 0.32, heightM: 1.45, color: 0x888888 };
  }
  return { ...scooter, id: vehicleId };
}

/**
 * Config of an actor model key; an unknown key gets a primitive of the actor kind.
 * @param {string} model Map actor `model`.
 * @param {'pedestrian' | 'car'} kind Actor kind.
 * @returns {ModelConfig} Config.
 */
export function actorModel(model, kind) {
  const known = ACTOR_MODELS[model];
  if (known && (known.kind === 'pedestrian') === (kind === 'pedestrian')) return known;
  return kind === 'pedestrian'
    ? ACTOR_MODELS.pedestrian
    : { id: model, kind: 'car', glb: null, wheelNodes: [], wheelRadiusM: 0.32, heightM: 1.45, color: 0x777777 };
}
