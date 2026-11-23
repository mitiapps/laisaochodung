/**
 * Model registry: the player vehicle configs by vehicle id, and the actor configs by map actor
 * `model` key. Unknown keys fall back to a generic config of the actor kind, so a map never fails
 * to draw because of a model name.
 */

import carSedan from './car-sedan.js';
import scooter from './scooter.js';
import { KENNEY_WHEELS } from './model-config.js';

/** @typedef {import('./model-config.js').ModelConfig} ModelConfig */

/** @type {Readonly<Record<string, ModelConfig>>} */
export const VEHICLE_MODELS = Object.freeze({ 'car-sedan': carSedan, scooter });

/**
 * Actor model keys a map may use. All Kenney Car Kit models (CC0).
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
 * Config of the player vehicle; an unknown id gets a box of its legal class.
 * @param {string} vehicleId Vehicle id.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Legal class.
 * @returns {ModelConfig} Config.
 */
export function vehicleModel(vehicleId, legalClass) {
  return (
    VEHICLE_MODELS[vehicleId] ?? {
      id: vehicleId,
      kind: legalClass === 'car' ? 'car' : 'motorbike',
      glb: null,
      wheelNodes: [],
      wheelRadiusM: legalClass === 'car' ? 0.32 : 0.25,
      heightM: legalClass === 'car' ? 1.45 : 1.15,
      color: 0x888888,
    }
  );
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
