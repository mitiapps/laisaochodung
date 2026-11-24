/**
 * Kinematic mirror of the traffic agents near the ego: a fixed pool of `maxMirrored` cuboid
 * bodies, so Rapier sees agents only where the ego can touch them. Traffic motion stays in
 * `src/world/traffic/`; this module only places bodies at the poses it is given.
 *
 * Each `update(poses, ego)`, before `world.step`:
 * 1. Candidates are agents whose centre is within `mirrorRadiusM` of the ego, sorted by distance,
 *    ties by id. A body keeps its slot while its agent stays in range; others are parked.
 * 2. Free slots go to the nearest unassigned candidates. A newly assigned body is disabled,
 *    placed with `setTranslation`/`setRotation` and enabled, so it never sweeps through the world;
 *    it gets kinematic targets only from its next update. An agent already overlapping the ego is
 *    not assigned (it would start inside the ego).
 * 3. Each assigned body follows its agent's pose, except:
 *    - a standing wreck (`crashed` or `fallen` at speed 0) holds its body where it is, so an
 *      agent pose that ran on before traffic stopped it dead at an ego contact never pushes the
 *      ego. A car wreck from a contact between agents slides on (speed above 0): its body keeps
 *      following the pose, swept-touch rule included, up to and including the step it stops;
 *    - when the agent's swept footprint from the body to its pose reaches the ego footprint, the
 *      body travels freely to a small margin short of the touch, then moves by
 *      `v · m_npc / (m_npc + m_ego) · DT` per step instead of following its agent, so the contact
 *      imparts about the momentum-share velocity and a light NPC cannot launch the ego. The agent
 *      becomes a wreck on the traffic step after the contact and its body then holds still; until
 *      then the body trails its agent's pose by a few steps of the lost travel.
 *
 * Contacts read the agent's true velocity from its pose (`motionOf`), never the body's motion.
 */

import { footprint, headingVector, polygonsIntersect } from '../geometry/index.js';
import { GROUP, interactionGroups } from '../physics/collision-groups.js';
import { headingQuat } from '../physics/vehicle.js';
import { ACTOR_HEIGHT_M, motionOfPose } from './actors.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('@dimforge/rapier3d-compat').World} World */
/** @typedef {import('@dimforge/rapier3d-compat').RigidBody} RigidBody */
/** @typedef {import('@dimforge/rapier3d-compat').Collider} Collider */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('../contracts/telemetry.js').Vec2} Vec2 */
/** @typedef {import('./world-colliders.js').BodyTag} BodyTag */
/** @typedef {import('./world-colliders.js').ActorMotion} ActorMotion */

/** Bisection steps that find where a swept footprint first touches the ego (2⁻¹² of a step). */
const TOUCH_BISECT_STEPS = 12;
/**
 * Smallest gap, metres, at which a body approaching the ego stops travelling freely: well above
 * Rapier's contact prediction distance, so no contact starts during a free-travel step.
 */
const APPROACH_MARGIN_M = 0.02;


/**
 * @typedef {object} MirrorConfig
 * @property {number} maxMirrored Pool size, a positive integer.
 * @property {number} mirrorRadiusM Agents whose centre is within this distance of the ego are mirrored.
 * @property {number} egoMassKg Ego mass.
 * @property {{lengthM: number, widthM: number}} egoSize Ego collider footprint size.
 * @property {(model: string) => number} massOf Mass of an agent model, kg.
 * @property {number} dt Fixed step, s.
 */

/**
 * The ego as the mirror sees it: its pre-step pose.
 * @typedef {object} MirrorEgo
 * @property {{x: number, z: number}} pos Centre.
 * @property {number} heading Heading.
 */

/**
 * @typedef {object} TrafficMirror
 * @property {(poses: ActorPose[], ego: MirrorEgo) => void} update Assign slots and set
 *   the kinematic targets for the coming `world.step`.
 * @property {() => void} parkAll Park every body (before the ego is placed back at a checkpoint).
 * @property {(handle: number) => ActorMotion | null} motionOf Centre, true velocity and pose of
 *   the agent that owns a collider, or null.
 * @property {() => (string | null)[]} slots Agent id per slot, null for a parked slot.
 */

/**
 * One pool slot.
 * @typedef {object} Slot
 * @property {RigidBody} body Kinematic body.
 * @property {Collider} collider Cuboid collider.
 * @property {string | null} id Mirrored agent, or null when parked.
 * @property {ActorPose | null} pose Agent pose this step.
 * @property {number} x Body centre x as last commanded.
 * @property {number} z Body centre z as last commanded.
 * @property {boolean} sliding The last pose was a wreck still sliding, so the body follows the
 *   pose once more, to where the slide ended.
 */

/**
 * Validates the mirror configuration.
 * @param {MirrorConfig} cfg Configuration.
 * @returns {void}
 */
function checkConfig(cfg) {
  if (!Number.isInteger(cfg.maxMirrored) || cfg.maxMirrored < 1) {
    throw new RangeError(`maxMirrored must be a positive integer, got ${String(cfg.maxMirrored)}`);
  }
  if (!(cfg.mirrorRadiusM > 0)) throw new RangeError(`mirrorRadiusM must be positive, got ${String(cfg.mirrorRadiusM)}`);
  if (!(cfg.egoMassKg > 0)) throw new RangeError(`egoMassKg must be positive, got ${String(cfg.egoMassKg)}`);
  if (!(cfg.egoSize.lengthM > 0) || !(cfg.egoSize.widthM > 0)) throw new RangeError('egoSize must be positive');
  if (!(cfg.dt > 0)) throw new RangeError(`dt must be positive, got ${String(cfg.dt)}`);
}

/**
 * Creates the pool, every body parked.
 * @param {Rapier} R Rapier.
 * @param {World} world World.
 * @param {Map<number, BodyTag>} tags Collider tags, updated in place as slots change hands.
 * @param {MirrorConfig} cfg Configuration.
 * @returns {TrafficMirror} Mirror.
 */
export function createTrafficMirror(R, world, tags, cfg) {
  checkConfig(cfg);
  const groups = interactionGroups(GROUP.ACTOR, GROUP.EGO);
  /** @type {Slot[]} */
  const slots = [];
  /** @type {Map<number, Slot>} */
  const slotByHandle = new Map();
  for (let i = 0; i < cfg.maxMirrored; i += 1) {
    const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setEnabled(false));
    const collider = world.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.5).setCollisionGroups(groups), body);
    /** @type {Slot} */
    const slot = { body, collider, id: null, pose: null, x: 0, z: 0, sliding: false };
    slots.push(slot);
    slotByHandle.set(collider.handle, slot);
  }

  /**
   * @param {Slot} slot Slot.
   * @returns {void}
   */
  const park = (slot) => {
    if (slot.id === null) return;
    slot.body.setEnabled(false);
    tags.delete(slot.collider.handle);
    slot.id = null;
    slot.pose = null;
    slot.sliding = false;
  };

  /**
   * Places a parked body at a pose without sweeping.
   * @param {Slot} slot Slot.
   * @param {ActorPose} p Pose.
   * @returns {void}
   */
  const assign = (slot, p) => {
    const height = ACTOR_HEIGHT_M[p.kind];
    slot.body.setEnabled(false);
    slot.collider.setHalfExtents({ x: p.lengthM / 2, y: height / 2, z: p.widthM / 2 });
    slot.body.setTranslation({ x: p.pos.x, y: height / 2, z: p.pos.z }, false);
    slot.body.setRotation(headingQuat(p.heading), false);
    slot.body.setEnabled(true);
    tags.set(slot.collider.handle, { kind: p.kind, id: p.id });
    slot.id = p.id;
    slot.pose = p;
    slot.x = p.pos.x;
    slot.z = p.pos.z;
    slot.sliding = false;
  };

  /**
   * Next centre of a mirrored body moving towards its agent's pose.
   * @param {Slot} slot Slot.
   * @param {ActorPose} p Pose.
   * @param {Vec2[]} egoFp Ego footprint.
   * @returns {{x: number, z: number}} Next centre.
   */
  const nextCentre = (slot, p, egoFp) => {
    const dx = p.pos.x - slot.x;
    const dz = p.pos.z - slot.z;
    const d = Math.hypot(dx, dz);
    if (!(d > 1e-9)) return { x: p.pos.x, z: p.pos.z };
    const at = (/** @type {number} */ u) => footprint({ x: slot.x + dx * u, z: slot.z + dz * u }, p.heading, p.lengthM, p.widthM);
    // Swept footprint: the agent box stretched over the move, along the move direction.
    const moveHeading = Math.atan2(-dz, dx);
    const [fx, fz] = headingVector(p.heading);
    const along = Math.abs(dx * fx + dz * fz) / d;
    const swept = footprint(
      { x: slot.x + dx / 2, z: slot.z + dz / 2 },
      along > 0.5 ? p.heading : moveHeading,
      along > 0.5 ? p.lengthM + d : p.widthM + d,
      along > 0.5 ? p.widthM : p.lengthM,
    );
    if (!polygonsIntersect(swept, egoFp) && !polygonsIntersect(at(1), egoFp)) return { x: p.pos.x, z: p.pos.z };
    // Rapier pushes the ego with the kinematic velocity of the step in which it first sees the
    // contact, and it sees one only between bodies that are about touching at the start of a step.
    // So the body travels freely to `margin` short of the touch, and from there moves at the
    // momentum-share speed: the step that starts the contact always pushes at that speed.
    const share = cfg.massOf(p.model) / (cfg.massOf(p.model) + cfg.egoMassKg);
    const push = Math.min(d, Math.abs(p.speed) * cfg.dt) * share;
    const margin = Math.max(push, APPROACH_MARGIN_M);
    let lo = 0;
    if (!polygonsIntersect(at(0), egoFp)) {
      let hi = 1;
      for (let k = 0; k < TOUCH_BISECT_STEPS; k += 1) {
        const mid = (lo + hi) / 2;
        if (polygonsIntersect(at(mid), egoFp)) hi = mid;
        else lo = mid;
      }
    }
    const u = lo * d > margin ? lo - margin / d : push / d;
    return { x: slot.x + dx * u, z: slot.z + dz * u };
  };

  return {
    update(poses, ego) {
      const egoFp = footprint(ego.pos, ego.heading, cfg.egoSize.lengthM, cfg.egoSize.widthM);
      /** @type {{pose: ActorPose, dist: number}[]} */
      const inRange = [];
      for (const p of poses) {
        const dist = Math.hypot(p.pos.x - ego.pos.x, p.pos.z - ego.pos.z);
        if (dist <= cfg.mirrorRadiusM) inRange.push({ pose: p, dist });
      }
      inRange.sort((a, b) => a.dist - b.dist || (a.pose.id < b.pose.id ? -1 : a.pose.id > b.pose.id ? 1 : 0));
      /** @type {Map<string, ActorPose>} */
      const byId = new Map(inRange.map((c) => [c.pose.id, c.pose]));

      for (const slot of slots) {
        if (slot.id === null) continue;
        const p = byId.get(slot.id);
        if (!p) {
          park(slot);
          continue;
        }
        byId.delete(slot.id);
        slot.pose = p;
        if (p.state === 'crashed' || p.state === 'fallen') {
          const slides = p.speed > 0;
          const follow = slides || slot.sliding;
          slot.sliding = slides;
          if (!follow) continue;
        } else slot.sliding = false;
        const next = nextCentre(slot, p, egoFp);
        slot.x = next.x;
        slot.z = next.z;
        slot.body.setNextKinematicTranslation({ x: next.x, y: ACTOR_HEIGHT_M[p.kind] / 2, z: next.z });
        slot.body.setNextKinematicRotation(headingQuat(p.heading));
      }

      let free = 0;
      for (const c of inRange) {
        if (!byId.has(c.pose.id)) continue;
        while (free < slots.length && slots[free].id !== null) free += 1;
        if (free >= slots.length) break;
        const p = c.pose;
        if (polygonsIntersect(footprint(p.pos, p.heading, p.lengthM, p.widthM), egoFp)) continue;
        assign(slots[free], p);
      }
    },

    parkAll() {
      for (const slot of slots) park(slot);
    },

    motionOf(handle) {
      const slot = slotByHandle.get(handle);
      return slot && slot.pose ? motionOfPose(slot.pose) : null;
    },

    slots() {
      return slots.map((s) => s.id);
    },
  };
}
