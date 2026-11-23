/**
 * Static world colliders and collision events.
 *
 * - Ground: one flat box under the whole map (every MVP map is flat).
 * - Kerbs: a low box along every pavement polygon edge. Wheel rays see kerb tops, so vehicles can
 *   mount a pavement; the chassis clears them unless it bottoms out.
 * - Obstacles: a wall box of the obstacle height along every footprint edge, which is exact for
 *   any polygon, convex or not.
 * - Finish: no sensor. Route progress (checkpoints, finish, timeout) is `stepRoute` in
 *   `src/world/`, on the ego centre, so the sim keeps no second copy of it.
 *
 * Contact-force events of the ego chassis are drained after each `world.step` and turned into one
 * `collision` event per contact episode and other body. A body is its kind and map id, so the
 * edge boxes of one obstacle count as one body and every kerb as one; a body re-arms after
 * `COLLISION_REARM_S` without contact.
 */

import { DT } from '../contracts/units.js';
import { headingVector, pointInPolygon } from '../geometry/index.js';
import { GROUP, interactionGroups } from '../physics/collision-groups.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('@dimforge/rapier3d-compat').World} World */
/** @typedef {import('@dimforge/rapier3d-compat').EventQueue} EventQueue */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {import('../contracts/telemetry.js').Vec2} Vec2 */
/** @typedef {import('../contracts/telemetry.js').CollisionEvent} CollisionEvent */

/** Kerb height and thickness in metres. */
export const KERB_HEIGHT_M = 0.12;
const KERB_THICKNESS_M = 0.15;

/** Obstacle wall thickness in metres. */
const WALL_THICKNESS_M = 0.3;

/** Margin of the ground box around the map, in metres. */
const GROUND_MARGIN_M = 500;

/** Seconds without contact before the same body can produce another collision event. */
export const COLLISION_REARM_S = 0.5;

/**
 * What a collider is in the game.
 * @typedef {object} BodyTag
 * @property {'ground' | 'kerb' | 'static' | 'pedestrian' | 'car'} kind Kind.
 * @property {string | null} id Map id, or null.
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
    .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
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
  return tags;
}

/**
 * Lane whose polygon contains a point (first match in map order), or null.
 * @param {GameMap} map Map.
 * @param {Vec2} p Point.
 * @returns {Lane | null} Lane.
 */
export function laneAt(map, p) {
  for (const road of map.roads) for (const lane of road.lanes) if (pointInPolygon(p, lane.polygon)) return lane;
  return null;
}

/**
 * Whether another body is ahead of the ego in the ego's lane.
 * @param {GameMap} map Map.
 * @param {{pos: {x: number, z: number}, heading: number}} ego Ego pose.
 * @param {{x: number, z: number}} other Other body centre.
 * @returns {boolean} Same lane and ahead.
 */
export function sameLaneAhead(map, ego, other) {
  const egoPoint = /** @type {Vec2} */ ([ego.pos.x, ego.pos.z]);
  const lane = laneAt(map, egoPoint);
  if (!lane || !pointInPolygon([other.x, other.z], lane.polygon)) return false;
  const [fx, fz] = headingVector(ego.heading);
  return (other.x - ego.pos.x) * fx + (other.z - ego.pos.z) * fz > 0;
}

/**
 * State of the collision debouncer: last contact tick per body key (`kind:id`).
 * @typedef {Map<string, number>} ContactMemory
 */

/**
 * Context needed to describe a contact.
 * @typedef {object} ContactContext
 * @property {number} tick Current tick.
 * @property {number} egoHandle Ego chassis collider handle.
 * @property {{pos: {x: number, z: number}, heading: number, velocity: {x: number, z: number}}} ego
 *   Ego pose and velocity before the step.
 * @property {Map<number, BodyTag>} tags Tags by collider handle.
 * @property {(handle: number) => {pos: {x: number, z: number}, velocity: {x: number, z: number}} | null} motionOf
 *   Centre and velocity of an actor collider, or null for statics.
 * @property {GameMap} map Map.
 */

/**
 * Drains contact-force events into collision events, one per contact episode and body.
 * @param {EventQueue} queue Event queue filled by `world.step`.
 * @param {ContactMemory} memory Debouncer state, updated in place.
 * @param {ContactContext} ctx Context.
 * @returns {CollisionEvent[]} New collision events of this step.
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
  const keys = [...strongest.keys()].sort();
  for (const key of keys) {
    const last = memory.get(key);
    memory.set(key, ctx.tick);
    if (last !== undefined && ctx.tick - last <= rearmTicks) continue;
    const { handle, tag, force, dir } = /** @type {{handle: number, tag: BodyTag, force: number, dir: {x: number, y: number, z: number}}} */ (strongest.get(key));
    const motion = ctx.motionOf(handle);
    const ov = motion ? motion.velocity : { x: 0, z: 0 };
    const rvx = ctx.ego.velocity.x - ov.x;
    const rvz = ctx.ego.velocity.z - ov.z;
    const dirLen = Math.hypot(dir.x, dir.z);
    const relSpeed = dirLen > 1e-6 ? Math.abs((rvx * dir.x + rvz * dir.z) / dirLen) : Math.hypot(rvx, rvz);
    const otherKind = /** @type {CollisionEvent['otherKind']} */ (tag.kind);
    events.push({
      type: 'collision',
      otherKind,
      otherId: tag.id,
      impulse: force * DT,
      egoSpeed: Math.hypot(ctx.ego.velocity.x, ctx.ego.velocity.z),
      relSpeed,
      sameLaneAhead: otherKind === 'car' && motion !== null && sameLaneAhead(ctx.map, ctx.ego, motion.pos),
    });
  }
  return events;
}
