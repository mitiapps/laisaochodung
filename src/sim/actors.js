/**
 * Kinematic bodies that mirror the scripted actors of `src/world/actors.js` (no motion logic
 * here); traffic agents have their own pool in `traffic-mirror.js`. Each step the sim passes this
 * step's poses; the bodies move to them during the next `world.step`, so Rapier sees their real
 * velocity in contacts.
 */

import { GROUP, interactionGroups } from '../physics/collision-groups.js';
import { headingQuat } from '../physics/vehicle.js';
import { headingVector, pointAtDistance } from '../geometry/index.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('@dimforge/rapier3d-compat').World} World */
/** @typedef {import('@dimforge/rapier3d-compat').RigidBody} RigidBody */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./world-colliders.js').BodyTag} BodyTag */

/** Body heights in metres by actor kind (design; a motorbike includes its rider). */
export const ACTOR_HEIGHT_M = Object.freeze({ pedestrian: 1.7, car: 1.5, motorbike: 1.4 });

/**
 * @typedef {object} ActorBodies
 * @property {(poses: ActorPose[]) => void} update Set the next kinematic poses of the scripted
 *   actors, in map order.
 * @property {(handle: number) => import('./world-colliders.js').ActorMotion | null} motionOf
 *   Centre, true velocity and pose of the actor that owns a collider, or null.
 */

/**
 * Centre, true velocity and pose of an actor.
 * @param {ActorPose} p Pose.
 * @returns {import('./world-colliders.js').ActorMotion} Motion.
 */
export function motionOfPose(p) {
  const [fx, fz] = headingVector(p.heading);
  return { pos: p.pos, velocity: { x: fx * p.speed, z: fz * p.speed }, pose: p };
}

/**
 * Creates one kinematic body per map actor at the start of its path.
 * @param {Rapier} R Rapier.
 * @param {World} world World.
 * @param {GameMap} map Map.
 * @param {Map<number, BodyTag>} tags Collider tags, extended in place.
 * @returns {ActorBodies} Actor bodies.
 */
export function createActorBodies(R, world, map, tags) {
  const groups = interactionGroups(GROUP.ACTOR, GROUP.EGO);
  /** @type {Map<number, number>} */
  const indexByHandle = new Map();
  /** @type {RigidBody[]} */
  const bodies = map.actors.map((actor, i) => {
    if (!(actor.lengthM > 0) || !(actor.widthM > 0)) {
      throw new RangeError(`Actor ${actor.id} needs a positive size`);
    }
    const height = ACTOR_HEIGHT_M[actor.kind];
    const start = pointAtDistance(actor.path, 0);
    const body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(start.point[0], height / 2, start.point[1])
        .setRotation(headingQuat(start.heading)),
    );
    const collider = world.createCollider(
      R.ColliderDesc.cuboid(actor.lengthM / 2, height / 2, actor.widthM / 2).setCollisionGroups(groups),
      body,
    );
    tags.set(collider.handle, { kind: actor.kind, id: actor.id });
    indexByHandle.set(collider.handle, i);
    return body;
  });
  /** @type {ActorPose[]} */
  let current = [];

  return {
    update(poses) {
      if (poses.length !== bodies.length) throw new Error('Actor poses do not match the map actors');
      poses.forEach((p, i) => {
        const height = ACTOR_HEIGHT_M[p.kind];
        bodies[i].setNextKinematicTranslation({ x: p.pos.x, y: height / 2, z: p.pos.z });
        bodies[i].setNextKinematicRotation(headingQuat(p.heading));
      });
      current = poses;
    },
    motionOf(handle) {
      const i = indexByHandle.get(handle);
      if (i === undefined) return null;
      const p = current[i];
      return p ? motionOfPose(p) : null;
    },
  };
}
