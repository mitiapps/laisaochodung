/**
 * Static world colliders and collision events.
 *
 * - Ground: one flat box under the whole map (every MVP map is flat).
 * - Kerbs: a low box along every pavement polygon edge. Wheel rays see kerb tops, so vehicles can
 *   mount a pavement; the chassis clears them unless it bottoms out.
 * - Obstacles: a wall box of the obstacle height along every footprint edge, which is exact for
 *   any polygon, convex or not.
 * - Solid props: trees and poles as a thin cylinder, clusters (parked motorbikes, stalls, bus
 *   stops, cabinets, bins) as a box turned to the prop heading; non-solid props get none.
 * - Finish: no sensor. Route progress (checkpoints, finish, timeout) is `stepRoute` in
 *   `src/world/`, on the ego centre, so the sim keeps no second copy of it.
 *
 * Contact-force events of the ego chassis are drained after each `world.step` and turned into one
 * `collision` event per contact episode and other body. A body is its kind and map id, so the
 * edge boxes of one obstacle count as one body and every kerb as one. A contact-force event above
 * the chassis threshold opens an episode; `holdContacts` keeps it open while the chassis still
 * touches the body at any force, so a body re-arms only after `COLLISION_REARM_S` without contact. With attribution on (traffic running), an event also
 * names the striker, whether the other party came from behind, and the other actor's model and
 * latched violations; the other actor's velocity always comes from its pose, never from the
 * kinematic body's position delta.
 */

import { DT, KERB_HEIGHT_M } from '../contracts/units.js';
import { NO_VIOLATIONS } from '../contracts/telemetry.js';
import { headingVector, pointInPolygon } from '../geometry/index.js';
import { mapIndex } from '../map-query/index.js';
import { GROUP, interactionGroups } from '../physics/collision-groups.js';
import { headingQuat } from '../physics/vehicle.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('@dimforge/rapier3d-compat').World} World */
/** @typedef {import('@dimforge/rapier3d-compat').EventQueue} EventQueue */
/** @typedef {import('@dimforge/rapier3d-compat').Collider} Collider */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {import('../contracts/telemetry.js').Vec2} Vec2 */
/** @typedef {import('../contracts/telemetry.js').CollisionEvent} CollisionEvent */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('../contracts/map.js').Prop} Prop */

/** Kerb thickness in metres; its height is the shared `KERB_HEIGHT_M`. */
const KERB_THICKNESS_M = 0.15;

/** Obstacle wall thickness in metres. */
const WALL_THICKNESS_M = 0.3;

/** Margin of the ground box around the map, in metres. */
const GROUND_MARGIN_M = 500;

/** Seconds without contact before the same body can produce another collision event. */
export const COLLISION_REARM_S = 0.5;

/** The ego counts as reversing below this signed speed, m/s (design). */
export const REVERSING_MPS = -0.1;

/**
 * Collider of a solid prop by kind (design sizes; the map gives only position and heading).
 * Cylinders are trunks and poles; boxes are `length` along the heading, `width` across it.
 * @type {Readonly<Record<Prop['kind'], {shape: 'cylinder', radius: number, height: number}
 *   | {shape: 'box', length: number, width: number, height: number}>>}
 */
export const PROP_COLLIDERS = Object.freeze({
  tree: { shape: 'cylinder', radius: 0.15, height: 4 },
  lamp: { shape: 'cylinder', radius: 0.15, height: 6 },
  'power-pole': { shape: 'cylinder', radius: 0.15, height: 8 },
  cabinet: { shape: 'box', length: 0.8, width: 0.5, height: 1.4 },
  'bus-stop': { shape: 'box', length: 4, width: 1.2, height: 2.5 },
  'parked-motorbikes': { shape: 'box', length: 4, width: 2, height: 1.1 },
  bin: { shape: 'box', length: 0.6, width: 0.6, height: 1 },
  stall: { shape: 'box', length: 2, width: 1.5, height: 1.8 },
});

/**
 * What a collider is in the game.
 * @typedef {object} BodyTag
 * @property {'ground' | 'kerb' | 'static' | 'pedestrian' | 'car' | 'motorbike'} kind Kind.
 * @property {string | null} id Map id or traffic agent id, or null.
 */

/**
 * Every ground point of the map, for the ground extent.
 * @param {GameMap} map Map.
 * @returns {Vec2[]} Points.
 */
function mapPoints(map) {
  /** @type {Vec2[]} */
  const pts = [[map.route.start.pos.x, map.route.start.pos.z]];
  for (const road of map.roads) for (const lane of road.lanes) pts.push(...lane.polygon);
  for (const j of map.junctions) pts.push(...j.polygon);
  for (const p of map.pavements) pts.push(...p.polygon);
  for (const o of map.obstacles) pts.push(...o.footprint);
  for (const a of map.actors) pts.push(...a.path);
  for (const p of map.props ?? []) pts.push([p.pos.x, p.pos.z]);
  pts.push(...map.route.finish.polygon);
  return pts;
}

/**
 * Adds one box along a polygon edge.
 * @param {Rapier} R Rapier.
 * @param {World} world World.
 * @param {Vec2} a Edge start.
 * @param {Vec2} b Edge end.
 * @param {number} height Box height.
 * @param {number} thickness Box thickness.
 * @param {number} groups Packed interaction groups.
 * @returns {number | null} Collider handle, or null for a degenerate edge.
 */
function edgeBox(R, world, a, b, height, thickness, groups) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return null;
  // Box +X along the edge: a rotation about +Y by the edge heading.
  const heading = Math.atan2(-dz, dx);
  const desc = R.ColliderDesc.cuboid(len / 2, height / 2, thickness / 2)
    .setTranslation((a[0] + b[0]) / 2, height / 2, (a[1] + b[1]) / 2)
    .setRotation(headingQuat(heading))
    .setCollisionGroups(groups);
  return world.createCollider(desc).handle;
}

/**
 * Builds the static colliders of a map.
 * @param {Rapier} R Rapier.
 * @param {World} world World.
 * @param {GameMap} map Map.
 * @returns {Map<number, BodyTag>} Tags by collider handle.
 */
export function buildWorldColliders(R, world, map) {
  /** @type {Map<number, BodyTag>} */
  const tags = new Map();
  const pts = mapPoints(map);
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const minX = Math.min(...xs) - GROUND_MARGIN_M;
  const maxX = Math.max(...xs) + GROUND_MARGIN_M;
  const minZ = Math.min(...zs) - GROUND_MARGIN_M;
  const maxZ = Math.max(...zs) + GROUND_MARGIN_M;
  const ground = world.createCollider(
    R.ColliderDesc.cuboid((maxX - minX) / 2, 0.5, (maxZ - minZ) / 2)
      .setTranslation((minX + maxX) / 2, -0.5, (minZ + maxZ) / 2)
      .setFriction(0.8)
      .setCollisionGroups(interactionGroups(GROUP.GROUND, 0xffff)),
  );
  tags.set(ground.handle, { kind: 'ground', id: null });

  const kerbGroups = interactionGroups(GROUP.KERB, 0xffff);
  for (const pavement of map.pavements) {
    const ring = pavement.polygon;
    ring.forEach((a, i) => {
      const h = edgeBox(R, world, a, ring[(i + 1) % ring.length], KERB_HEIGHT_M, KERB_THICKNESS_M, kerbGroups);
      if (h !== null) tags.set(h, { kind: 'kerb', id: null });
    });
  }

  const staticGroups = interactionGroups(GROUP.STATIC, GROUP.EGO);
  for (const obstacle of map.obstacles) {
    if (!(obstacle.height > 0)) throw new RangeError(`Obstacle ${obstacle.id} needs a positive height`);
    const ring = obstacle.footprint;
    ring.forEach((a, i) => {
      const h = edgeBox(R, world, a, ring[(i + 1) % ring.length], obstacle.height, WALL_THICKNESS_M, staticGroups);
      if (h !== null) tags.set(h, { kind: 'static', id: obstacle.id });
    });
  }

  for (const prop of map.props ?? []) {
    if (!prop.solid) continue;
    const spec = PROP_COLLIDERS[prop.kind];
    if (!spec) throw new RangeError(`Prop ${prop.id} has an unknown kind ${String(prop.kind)}`);
    const desc =
      spec.shape === 'cylinder'
        ? R.ColliderDesc.cylinder(spec.height / 2, spec.radius)
        : R.ColliderDesc.cuboid(spec.length / 2, spec.height / 2, spec.width / 2);
    desc
      .setTranslation(prop.pos.x, spec.height / 2, prop.pos.z)
      .setRotation(headingQuat(prop.heading))
      .setCollisionGroups(staticGroups);
    tags.set(world.createCollider(desc).handle, { kind: 'static', id: prop.id });
  }
  return tags;
}

/**
 * Lane whose polygon contains a point (first match in map order), or null. Uses the cached grid
 * index of `src/map-query/`, whose candidates come back in map order.
 * @param {GameMap} map Map.
 * @param {Vec2} p Point.
 * @returns {Lane | null} Lane.
 */
export function laneAt(map, p) {
  const hit = mapIndex(map).lanes.near(p).find((c) => pointInPolygon(p, c.lane.polygon));
  return hit ? hit.lane : null;
}

/**
 * Signed distance of another body along the ego heading, when it is in the ego's lane; null
 * when the ego is on no lane or the other body is outside that lane.
 * @param {GameMap} map Map.
 * @param {{pos: {x: number, z: number}, heading: number}} ego Ego pose.
 * @param {{x: number, z: number}} other Other body centre.
 * @returns {number | null} Distance ahead (negative behind), or null.
 */
function alongInEgoLane(map, ego, other) {
  const lane = laneAt(map, [ego.pos.x, ego.pos.z]);
  if (!lane || !pointInPolygon([other.x, other.z], lane.polygon)) return null;
  const [fx, fz] = headingVector(ego.heading);
  return (other.x - ego.pos.x) * fx + (other.z - ego.pos.z) * fz;
}

/**
 * Whether another body is ahead of the ego in the ego's lane.
 * @param {GameMap} map Map.
 * @param {{pos: {x: number, z: number}, heading: number}} ego Ego pose.
 * @param {{x: number, z: number}} other Other body centre.
 * @returns {boolean} Same lane and ahead.
 */
export function sameLaneAhead(map, ego, other) {
  const along = alongInEgoLane(map, ego, other);
  return along !== null && along > 0;
}

/**
 * Whether the other party came from behind: it is behind the ego in the ego's lane and faster
 * along the ego heading. Always false while the ego reverses.
 * @param {GameMap} map Map.
 * @param {{pos: {x: number, z: number}, heading: number, speed: number}} ego Ego pose, signed speed.
 * @param {{pos: {x: number, z: number}, velocity: {x: number, z: number}}} other Other body.
 * @returns {boolean} From behind.
 */
export function fromBehind(map, ego, other) {
  if (ego.speed < REVERSING_MPS) return false;
  const along = alongInEgoLane(map, ego, other.pos);
  if (along === null || along >= 0) return false;
  const [fx, fz] = headingVector(ego.heading);
  return other.velocity.x * fx + other.velocity.z * fz > Math.max(0, ego.speed);
}

/**
 * Who struck: the closing speeds of the ego and the other party along the contact normal (from
 * the ego towards the other). A party whose share of the closing speed exceeds `share` is the
 * striker; otherwise, or with no closing at all, `both`.
 * @param {{x: number, z: number}} normal Contact normal, ego to other, any length.
 * @param {{x: number, z: number}} egoVel Ego velocity.
 * @param {{x: number, z: number}} otherVel Other party's true velocity.
 * @param {number} share Striker share, above 0.5.
 * @returns {'ego' | 'other' | 'both'} Striker.
 */
export function strikerOf(normal, egoVel, otherVel, share) {
  const len = Math.hypot(normal.x, normal.z);
  if (!(len > 1e-9)) return 'both';
  const nx = normal.x / len;
  const nz = normal.z / len;
  const egoClose = Math.max(0, egoVel.x * nx + egoVel.z * nz);
  const otherClose = Math.max(0, -(otherVel.x * nx + otherVel.z * nz));
  const total = egoClose + otherClose;
  if (!(total > 1e-6)) return 'both';
  if (egoClose / total > share) return 'ego';
  if (otherClose / total > share) return 'other';
  return 'both';
}

/**
 * State of the collision debouncer: last contact tick per body key (`kind:id`).
 * @typedef {Map<string, number>} ContactMemory
 */

/**
 * An actor body: centre and true velocity from its pose, and the pose itself.
 * @typedef {object} ActorMotion
 * @property {{x: number, z: number}} pos Centre.
 * @property {{x: number, z: number}} velocity Velocity from the pose speed and heading.
 * @property {ActorPose} pose Pose this step.
 */

/**
 * Context needed to describe a contact.
 * @typedef {object} ContactContext
 * @property {number} tick Current tick.
 * @property {number} egoHandle Ego chassis collider handle.
 * @property {{pos: {x: number, z: number}, heading: number, speed: number, velocity: {x: number, z: number}}} ego
 *   Ego pose, signed speed and velocity before the step.
 * @property {Map<number, BodyTag>} tags Tags by collider handle.
 * @property {(handle: number) => ActorMotion | null} motionOf Actor body of a collider, or null
 *   for statics.
 * @property {GameMap} map Map.
 * @property {number | null} strikerShare With a number, events carry `striker`,
 *   `otherFromBehind`, `otherModel` and `otherViolations` (traffic running); null leaves them out.
 */

/**
 * Contacts of one step.
 * @typedef {object} DrainResult
 * @property {CollisionEvent[]} events New collision events, one per new contact episode and body.
 * @property {string[]} touchedIds Ids of every actor the ego touched this step, debounced or not,
 *   sorted; traffic turns its own agents among them into wrecks next step.
 */

/**
 * Drains contact-force events into collision events, one per contact episode and body.
 * @param {EventQueue} queue Event queue filled by `world.step`.
 * @param {ContactMemory} memory Debouncer state, updated in place.
 * @param {ContactContext} ctx Context.
 * @returns {DrainResult} Events and touched actors of this step.
 */
export function drainCollisions(queue, memory, ctx) {
  const rearmTicks = Math.round(COLLISION_REARM_S / DT);
  /** @type {Map<string, {handle: number, tag: BodyTag, force: number, dir: {x: number, y: number, z: number}}>} */
  const strongest = new Map();
  queue.drainContactForceEvents((event) => {
    const c1 = event.collider1();
    const c2 = event.collider2();
    let other;
    if (c1 === ctx.egoHandle) other = c2;
    else if (c2 === ctx.egoHandle) other = c1;
    else return;
    const tag = ctx.tags.get(other);
    if (!tag || tag.kind === 'ground') return;
    const key = `${tag.kind}:${tag.id ?? ''}`;
    const force = event.totalForceMagnitude();
    const prev = strongest.get(key);
    if (!prev || force > prev.force) strongest.set(key, { handle: other, tag, force, dir: event.maxForceDirection() });
  });

  /** @type {CollisionEvent[]} */
  const events = [];
  /** @type {string[]} */
  const touchedIds = [];
  const keys = [...strongest.keys()].sort();
  for (const key of keys) {
    const { handle, tag, force, dir } = /** @type {{handle: number, tag: BodyTag, force: number, dir: {x: number, y: number, z: number}}} */ (strongest.get(key));
    const isActor = tag.kind === 'pedestrian' || tag.kind === 'car' || tag.kind === 'motorbike';
    if (isActor && tag.id !== null) touchedIds.push(tag.id);
    const last = memory.get(key);
    memory.set(key, ctx.tick);
    if (last !== undefined && ctx.tick - last <= rearmTicks) continue;
    const motion = ctx.motionOf(handle);
    const ov = motion ? motion.velocity : { x: 0, z: 0 };
    const rvx = ctx.ego.velocity.x - ov.x;
    const rvz = ctx.ego.velocity.z - ov.z;
    const dirLen = Math.hypot(dir.x, dir.z);
    const relSpeed = dirLen > 1e-6 ? Math.abs((rvx * dir.x + rvz * dir.z) / dirLen) : Math.hypot(rvx, rvz);
    const otherKind = /** @type {CollisionEvent['otherKind']} */ (tag.kind);
    /** @type {CollisionEvent} */
    const event = {
      type: 'collision',
      otherKind,
      otherId: tag.id,
      impulse: force * DT,
      egoSpeed: Math.hypot(ctx.ego.velocity.x, ctx.ego.velocity.z),
      relSpeed,
      sameLaneAhead: (otherKind === 'car' || otherKind === 'motorbike') && motion !== null && sameLaneAhead(ctx.map, ctx.ego, motion.pos),
    };
    if (ctx.strikerShare !== null) {
      // The force direction has no reliable sign; orient it from the ego towards the other body.
      let nx = dir.x;
      let nz = dir.z;
      if (motion) {
        const cx = motion.pos.x - ctx.ego.pos.x;
        const cz = motion.pos.z - ctx.ego.pos.z;
        if (dirLen <= 1e-6) {
          nx = cx;
          nz = cz;
        } else if (nx * cx + nz * cz < 0) {
          nx = -nx;
          nz = -nz;
        }
      }
      event.otherModel = motion ? motion.pose.model : null;
      // Statics and kerbs never move, so the ego is always the striker against them.
      event.striker = motion ? strikerOf({ x: nx, z: nz }, ctx.ego.velocity, ov, ctx.strikerShare) : 'ego';
      event.otherFromBehind = motion !== null && fromBehind(ctx.map, ctx.ego, motion);
      event.otherViolations = motion ? motion.pose.violations : NO_VIOLATIONS;
    }
    events.push(event);
  }
  return { events, touchedIds };
}

/**
 * Keeps open contact episodes alive: refreshes the debouncer for every body that already has an
 * episode and whose collider still touches the ego chassis after `world.step`, whatever the
 * contact force. Bodies with no open episode (none yet, or one already re-armed) are left alone, so
 * only a contact-force event opens one.
 * Call it after `drainCollisions` on the same step.
 * @param {World} world World, after `world.step`.
 * @param {Collider} egoCollider Ego chassis collider.
 * @param {Map<number, BodyTag>} tags Tags by collider handle.
 * @param {ContactMemory} memory Debouncer state, updated in place.
 * @param {number} tick Current tick.
 */
export function holdContacts(world, egoCollider, tags, memory, tick) {
  const rearmTicks = Math.round(COLLISION_REARM_S / DT);
  world.contactPairsWith(egoCollider, (other) => {
    const tag = tags.get(other.handle);
    if (!tag || tag.kind === 'ground') return;
    const key = `${tag.kind}:${tag.id ?? ''}`;
    const last = memory.get(key);
    if (last === undefined || tick - last > rearmTicks) return;
    let touching = false;
    world.contactPair(egoCollider, other, (manifold) => {
      if (manifold.numContacts() > 0) touching = true;
    });
    if (touching) memory.set(key, tick);
  });
}
