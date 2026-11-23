/**
 * Scripted actors drawn from frame poses: NPC cars and pedestrians, chosen by the map actor
 * `model` and sized to its `lengthM` and `widthM`. Inactive actors stay visible and idle where the
 * frame puts them (waiting for their trigger, or parked at the end of their path).
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

  return {
    group,
    update(prev, frame, alpha, newTick) {
      for (const pose of frame.actors) {
        const entry = views.get(pose.id);
        if (!entry) continue;
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
    },
    reset() {
      for (const e of views.values()) e.phase = 0;
    },
    dispose() {
      for (const e of views.values()) e.view.dispose();
    },
  };
}
