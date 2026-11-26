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
 * 4. When the ego itself closes on the body (its pre-step velocity along the push direction is
 *    below `-CLOSING_MPS`), the first touch latches a push cap: the perfectly inelastic common
 *    speed `(m_npc · v_npc + m_ego · v_ego_along) / (m_npc + m_ego)`, clamped between 0 and the
 *    momentum-share speed. The body then pushes at that speed, and `limitEgo`, called after
 *    `world.step`, caps on every step the two still touch what the contact impulse added to the
 *    ego velocity along the push direction and along the contact normal: the ego leaves no faster
 *    than the body moves that way, while the velocity it has without the impulse (backing away
 *    under its own drive) stands. A body the swept-touch rule never moved (a standing agent)
 *    latches its cap at its first contact, pushing along its heading towards the ego. Without the
 *    cap Rapier's
 *    zero-restitution contact against a kinematic body sends the ego back at the body's speed
 *    plus about 0.3 to 0.7 m/s from the chassis pitch and suspension. The cap lasts until the
 *    slot is parked or reassigned. An ego that is not closing never takes this path, so its
 *    results are those of the plain momentum-share push.
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
 * The ego closes on an agent when its velocity along the agent's push direction is below minus
 * this, m/s (design). A braked ego at rest reads about ±1e-5 m/s, so it never counts as closing.
 */
const CLOSING_MPS = 0.05;

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
 * The ego as the mirror sees it: its pre-step pose and velocity.
 * @typedef {object} MirrorEgo
 * @property {{x: number, z: number}} pos Centre.
 * @property {number} heading Heading.
 * @property {{x: number, z: number}} velocity World velocity.
 */

/**
 * @typedef {object} TrafficMirror
 * @property {(poses: ActorPose[], ego: MirrorEgo) => void} update Assign slots and set
 *   the kinematic targets for the coming `world.step`.
 * @property {(egoBody: RigidBody, egoCollider: Collider) => void} limitEgo After `world.step`,
 *   before the ego is read: for every body the ego closed on and still touches, caps what the
 *   contact impulse added to the ego velocity along the push direction at that contact's
 *   common velocity.
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
 * @property {PushCap | null} cap Latched at the first contact the ego closed into; kept until the
 *   slot is parked or reassigned.
 */

/**
 * What a body may give an ego that drove into it: the unit push direction and the perfectly
 * inelastic common speed along it, clamped between 0 and the momentum-share speed.
 * @typedef {object} PushCap
 * @property {number} ux Push direction x.
 * @property {number} uz Push direction z.
 * @property {number} speed Common speed, m/s.
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
    const slot = { body, collider, id: null, pose: null, x: 0, z: 0, sliding: false, cap: null };
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
    slot.cap = null;
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
    slot.cap = null;
  };

  /** Ego velocity before the coming `world.step`. */
  let egoVel = { x: 0, z: 0 };

  /**
   * The push cap of an ego closing on a body along `u`, or null when the ego is not closing.
   * @param {ActorPose} p Agent pose.
   * @param {number} ux Push direction x, unit.
   * @param {number} uz Push direction z, unit.
   * @returns {PushCap | null} Cap.
   */
  const capFor = (p, ux, uz) => {
    const egoAlong = egoVel.x * ux + egoVel.z * uz;
    if (!(egoAlong < -CLOSING_MPS)) return null;
    const mNpc = cfg.massOf(p.model);
    const v = Math.abs(p.speed);
    const common = (mNpc * v + cfg.egoMassKg * egoAlong) / (mNpc + cfg.egoMassKg);
    return { ux, uz, speed: Math.min(Math.max(common, 0), (v * mNpc) / (mNpc + cfg.egoMassKg)) };
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
    // An ego that drives into the body takes no more than the common velocity of the two: the
    // first touch latches it, so later steps keep the ego's momentum in the push.
    if (slot.cap === null) slot.cap = capFor(p, dx / d, dz / d);
    const share = cfg.massOf(p.model) / (cfg.massOf(p.model) + cfg.egoMassKg);
    const push = slot.cap === null ? Math.min(d, Math.abs(p.speed) * cfg.dt) * share : Math.min(d, slot.cap.speed * cfg.dt);
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
      egoVel = { x: ego.velocity.x, z: ego.velocity.z };
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

    limitEgo(egoBody, egoCollider) {
      for (const slot of slots) {
        if (slot.id === null || slot.pose === null) continue;
        let touching = false;
        // Impulse the contact gave the ego this step, world frame.
        let jx = 0;
        let jz = 0;
        world.contactPair(egoCollider, slot.collider, (m, flipped) => {
          const n = m.numContacts();
          if (n === 0) return;
          touching = true;
          let j = 0;
          for (let i = 0; i < n; i += 1) j += m.contactImpulse(i);
          // The normal points from the first collider to the second; the ego is pushed against it.
          const normal = m.normal();
          const sign = flipped ? 1 : -1;
          jx += sign * j * normal.x;
          jz += sign * j * normal.z;
        });
        if (!touching) continue;
        if (slot.cap === null) {
          // A body the swept-touch rule never moved (a standing agent): push along its heading,
          // signed towards the ego.
          const p = slot.pose;
          const [hx, hz] = headingVector(p.heading);
          const t = egoBody.translation();
          const towards = (t.x - slot.x) * hx + (t.z - slot.z) * hz >= 0 ? 1 : -1;
          const moving = Math.abs(p.speed) > 0;
          const sign = moving ? Math.sign(p.speed) : towards;
          slot.cap = capFor(p, hx * sign, hz * sign);
          if (slot.cap === null) continue;
        }
        // Only what the contact added is capped: the velocity the ego would have without the
        // contact impulse (its own drive, when it backs away) always stands. The cap holds along
        // the push direction and along the contact normal, so an oblique hit, whose normal lies
        // across the agent's travel, cannot send the ego away faster than the body moves there.
        const { ux, uz, speed } = slot.cap;
        const mass = egoBody.mass();
        const v0 = egoBody.linvel();
        let vx = v0.x;
        let vz = v0.z;
        const along = vx * ux + vz * uz;
        const excess = along - Math.max(speed, along - (jx * ux + jz * uz) / mass);
        if (excess > 0) {
          vx -= excess * ux;
          vz -= excess * uz;
        }
        const jn = Math.hypot(jx, jz);
        if (jn > 0) {
          const nx = jx / jn;
          const nz = jz / jn;
          const own = v0.x * nx + v0.z * nz - jn / mass;
          const excessN = vx * nx + vz * nz - Math.max(speed * (ux * nx + uz * nz), own);
          if (excessN > 0) {
            vx -= excessN * nx;
            vz -= excessN * nz;
          }
        }
        if (vx !== v0.x || vz !== v0.z) egoBody.setLinvel({ x: vx, y: v0.y, z: vz }, true);
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
