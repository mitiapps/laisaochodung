/**
 * Actors drawn from frame poses.
 *
 * Scripted actors (NPC cars and pedestrians) get one view each, chosen by the map actor `model` and
 * sized to its `lengthM` and `widthM`. Inactive actors stay visible and idle where the frame puts
 * them (waiting for their trigger, or parked at the end of their path).
 *
 * Traffic agents get primitive views (a box car or a primitive scooter, by pose kind) from a small
 * pool keyed by agent id: a view is taken on the agent's first frame and given back when its id
 * leaves the frame. Free views are kept per kind, model and size for the next agent of that shape.
 */

import { Group } from 'three';
import { DT } from '../contracts/units.js';
import { interpolateActor } from './interpolate.js';
import { createPedestrianView, createVehicleView } from './vehicle-view.js';
import { actorModel } from './vehicles/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */

/** Stride length of the walk cycle in metres (a drawing choice). */
const STRIDE_M = 1.4;
/** Free traffic views kept per shape; more are freed (a drawing choice). */
const FREE_VIEWS_PER_SHAPE = 8;

/**
 * Primitive look of each traffic model key: body colour and height. Unknown keys use `default`.
 * Drawing choices only; the sizes come from the poses.
 * @type {Readonly<Record<string, {color: number, heightM: number}>>}
 */
const TRAFFIC_LOOKS = Object.freeze({
  car: { color: 0x9aa5b1, heightM: 1.45 },
  taxi: { color: 0x2e9e5b, heightM: 1.5 },
  bus: { color: 0x2f6db5, heightM: 3.1 },
  truck: { color: 0xd8d2c4, heightM: 2.6 },
  motorbike: { color: 0xc23b22, heightM: 1.1 },
  default: { color: 0x777777, heightM: 1.45 },
});

/**
 * Primitive model config of a traffic pose.
 * @param {import('../contracts/telemetry.js').ActorPose} pose Pose.
 * @returns {import('./vehicles/model-config.js').ModelConfig} Config.
 */
function trafficConfig(pose) {
  const look = TRAFFIC_LOOKS[pose.model] ?? TRAFFIC_LOOKS.default;
  const bike = pose.kind === 'motorbike';
  return {
    id: `traffic-${pose.model}`,
    kind: bike ? 'motorbike' : 'car',
    glb: null,
    wheelNodes: [],
    wheelRadiusM: bike ? 0.25 : pose.lengthM > 7 ? 0.5 : 0.32,
    heightM: look.heightM,
    color: look.color,
  };
}

/**
 * @typedef {object} ActorViews
 * @property {Group} group Meshes.
 * @property {(prev: Frame | null, frame: Frame, alpha: number, newTick: boolean) => void} update Pose every actor.
 * @property {() => void} reset Forget accumulated wheel and walk phases.
 * @property {() => void} dispose Free resources.
 */

/**
 * Builds a view per map actor.
 * @param {GameMap} map Map.
 * @returns {ActorViews} Views.
 */
export function buildActors(map) {
  const group = new Group();
  group.name = 'actors';
  /**
   * @type {Map<string, {kind: 'pedestrian', phase: number, view: import('./vehicle-view.js').PedestrianView}
   *   | {kind: 'car', phase: number, radius: number, view: import('./vehicle-view.js').VehicleView}>}
   */
  const views = new Map();
  for (const actor of map.actors) {
    const config = actorModel(actor.model, actor.kind);
    if (actor.kind === 'pedestrian') {
      const view = createPedestrianView(config, actor.lengthM, actor.widthM);
      group.add(view.root);
      views.set(actor.id, { kind: 'pedestrian', phase: 0, view });
    } else {
      const view = createVehicleView({ config, lengthM: actor.lengthM, widthM: actor.widthM, lamps: false });
      group.add(view.root);
      views.set(actor.id, { kind: 'car', phase: 0, radius: config.wheelRadiusM || 0.32, view });
    }
  }
  const noSteer = [{ steer: 0 }, { steer: 0 }, { steer: 0 }, { steer: 0 }];

  /**
   * @typedef {object} TrafficEntry
   * @property {string} shape Pool key: kind, model and size.
   * @property {number} phase Wheel phase.
   * @property {number} radius Wheel radius.
   * @property {import('./vehicle-view.js').VehicleView} view View.
   */
  /** @type {Map<string, TrafficEntry>} Views of the agents in the latest frame, by id. */
  const traffic = new Map();
  /** @type {Map<string, TrafficEntry[]>} Free views by shape. */
  const free = new Map();
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * View for a traffic agent seen for the first time.
   * @param {import('../contracts/telemetry.js').ActorPose} pose Pose.
   * @returns {TrafficEntry} Entry, already in the group.
   */
  const takeTrafficView = (pose) => {
    const shape = `${pose.kind}|${pose.model}|${pose.lengthM}|${pose.widthM}`;
    const reused = free.get(shape)?.pop();
    if (reused) {
      reused.phase = 0;
      group.add(reused.view.root);
      return reused;
    }
    const config = trafficConfig(pose);
    const view = createVehicleView({ config, lengthM: pose.lengthM, widthM: pose.widthM, lamps: false });
    group.add(view.root);
    return { shape, phase: 0, radius: config.wheelRadiusM, view };
  };

  /**
   * Gives a traffic view back to the pool, or frees it when the pool for its shape is full.
   * @param {TrafficEntry} entry Entry.
   */
  const releaseTrafficView = (entry) => {
    group.remove(entry.view.root);
    const list = free.get(entry.shape) ?? [];
    if (list.length >= FREE_VIEWS_PER_SHAPE) {
      entry.view.dispose();
      return;
    }
    list.push(entry);
    free.set(entry.shape, list);
  };

  return {
    group,
    update(prev, frame, alpha, newTick) {
      seen.clear();
      for (const pose of frame.actors) {
        const entry = views.get(pose.id);
        if (!entry) {
          if (pose.kind === 'pedestrian') continue;
          seen.add(pose.id);
          let t = traffic.get(pose.id);
          if (!t) {
            t = takeTrafficView(pose);
            traffic.set(pose.id, t);
          }
          const draw = interpolateActor(prev, frame, pose, alpha);
          if (newTick) t.phase += (pose.speed * DT) / t.radius;
          const a = t.phase;
          t.view.update(draw, { speed: pose.speed, yawRate: 0, wheels: noSteer }, [a, a, a, a], null);
          continue;
        }
        const draw = interpolateActor(prev, frame, pose, alpha);
        if (entry.kind === 'pedestrian') {
          if (newTick) entry.phase += (pose.speed * DT * 2 * Math.PI) / STRIDE_M;
          entry.view.update(draw, pose.speed > 0 ? entry.phase : 0);
        } else {
          if (newTick) entry.phase += (pose.speed * DT) / entry.radius;
          const a = entry.phase;
          entry.view.update(draw, { speed: pose.speed, yawRate: 0, wheels: noSteer }, [a, a, a, a], null);
        }
      }
      for (const [id, t] of traffic) {
        if (seen.has(id)) continue;
        traffic.delete(id);
        releaseTrafficView(t);
      }
    },
    reset() {
      for (const e of views.values()) e.phase = 0;
      for (const t of traffic.values()) releaseTrafficView(t);
      traffic.clear();
    },
    dispose() {
      for (const e of views.values()) e.view.dispose();
      for (const t of traffic.values()) t.view.dispose();
      for (const list of free.values()) for (const t of list) t.view.dispose();
      traffic.clear();
      free.clear();
    },
  };
}
