/**
 * Scripted actors with hold-when-blocked. Deterministic in its own state, the map, the blocker
 * footprints (the ego first, then traffic agents) and DT; no physics.
 *
 * Each call to `stepActors` returns the poses at the state's current time and the state one DT
 * later, so the frame of tick k shows the poses after k steps of motion:
 * 1. Triggers: an idle actor starts when the ego footprint overlaps its trigger polygon, or when
 *    the state time reaches `trigger.atS`.
 * 2. Hold: an active actor holds (speed 0) while any blocker footprint overlaps its path corridor
 *    ahead: the stretch of path from its centre to `stoppingDistance + lengthM / 2 + HOLD_MARGIN_M`,
 *    `widthM` wide. It resumes at full speed as soon as the corridor is clear; there is no
 *    acceleration model.
 * 3. Motion: an active, unheld actor moves `speed · DT` along its path. A looping path wraps from
 *    the last point back to the first; a non-looping actor stops at the last point and becomes
 *    inactive.
 *
 * Violation flags are facts of the pose: an active car on a lane, heading against that lane's
 * direction of travel, carries `wrong-way` (the fault table judges a contact with it).
 */

import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../contracts/telemetry.js';
import {
  angleDiff,
  offsetPolyline,
  pointInPolygon,
  projectOntoPolyline,
  pointAtDistance,
  polygonsIntersect,
  polylineLength,
  slicePolyline,
} from '../geometry/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').MapActor} MapActor */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('../contracts/telemetry.js').Vec2} Vec2 */

/** Deceleration assumed for an actor's stopping distance, m/s², by kind. */
export const ACTOR_DECEL_MPS2 = Object.freeze({ car: 4, pedestrian: 2 });

/** Extra clearance ahead of an actor's front, in metres. */
export const HOLD_MARGIN_M = 2;

/** The flags of an actor travelling against its lane. */
const WRONG_WAY = Object.freeze(/** @type {const} */ (['wrong-way']));

/**
 * Whether a point heading `heading` travels against the lane it stands on: inside a lane polygon
 * and more than 90° off that lane's centreline direction there. Off every lane (a junction box, a
 * pavement) it is not against any lane.
 * @param {GameMap} map Map.
 * @param {Vec2} p Point.
 * @param {number} heading Heading.
 * @returns {boolean} Against its lane.
 */
export function againstLane(map, p, heading) {
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      if (!pointInPolygon(p, lane.polygon)) continue;
      return Math.abs(angleDiff(heading, projectOntoPolyline(p, lane.centerline).heading)) > Math.PI / 2;
    }
  }
  return false;
}

/**
 * @typedef {object} ActorRuntime
 * @property {string} id Actor id.
 * @property {number} s Distance travelled along the path.
 * @property {boolean} triggered Trigger has fired.
 * @property {boolean} done Non-looping actor reached the end.
 */

/**
 * @typedef {object} ActorState
 * @property {number} t Time of this state in seconds.
 * @property {ActorRuntime[]} actors One entry per map actor, in map order.
 */

/**
 * Initial actor state at `t = 0`.
 * @param {GameMap} map Map.
 * @returns {ActorState} State.
 */
export function createActorState(map) {
  return { t: 0, actors: map.actors.map((a) => ({ id: a.id, s: 0, triggered: false, done: false })) };
}

/**
 * Stopping distance of an actor at its cruise speed.
 * @param {MapActor} actor Actor.
 * @returns {number} Metres.
 */
export function actorStoppingDistance(actor) {
  const decel = ACTOR_DECEL_MPS2[actor.kind];
  return (actor.speed * actor.speed) / (2 * decel);
}

/**
 * Closed path of a looping actor, or the path itself.
 * @param {MapActor} actor Actor.
 * @returns {Vec2[]} Path points.
 */
function travelPath(actor) {
  if (!actor.loop) return actor.path;
  const first = actor.path[0];
  return [...actor.path, [first[0], first[1]]];
}

/**
 * Corridor polygons covering the path from `s` to `s + ahead`, `width` wide. Two pieces when a
 * looping path wraps.
 * @param {Vec2[]} path Travel path.
 * @param {number} length Path length.
 * @param {boolean} loop Looping path.
 * @param {number} s Start distance.
 * @param {number} ahead Look-ahead distance.
 * @param {number} width Corridor width.
 * @returns {Vec2[][]} Corridor polygons.
 */
function corridor(path, length, loop, s, ahead, width) {
  /** @type {[number, number][]} */
  const ranges = [];
  if (loop && s + ahead > length) ranges.push([s, length], [0, s + ahead - length]);
  else ranges.push([s, Math.min(length, s + ahead)]);
  /** @type {Vec2[][]} */
  const out = [];
  for (const [a, b] of ranges) {
    if (b - a < 1e-6) continue;
    const piece = slicePolyline(path, a, b);
    try {
      const left = offsetPolyline(piece, width / 2);
      const right = offsetPolyline(piece, -width / 2);
      out.push([...left, ...right.reverse()]);
    } catch {
      // A piece shorter than the offset tolerance has no area to block.
    }
  }
  return out;
}

/**
 * Whether the actor's trigger fires: its time has come, or the ego footprint overlaps it.
 * @param {MapActor} actor Actor.
 * @param {number} t State time.
 * @param {Vec2[] | null} egoFootprint Ego footprint, or null without an ego.
 * @returns {boolean} Trigger fires.
 */
function triggerFires(actor, t, egoFootprint) {
  const trig = actor.trigger;
  if ('atS' in trig) return t >= trig.atS;
  return egoFootprint !== null && polygonsIntersect(trig.polygon, egoFootprint);
}

/**
 * Advances every actor by one DT.
 * @param {ActorState} actorState Current state.
 * @param {GameMap} map Map.
 * @param {Vec2[][]} blockers Footprints now: the ego first, then traffic agents. Only the ego
 *   fires polygon triggers; every blocker holds an actor whose corridor it overlaps. An empty
 *   list means no ego, so only time triggers fire.
 * @param {number} egoSpeed Ego speed now (m/s). Accepted for the contract; the hold test depends
 *   only on the footprints, so an ego cutting across a path also holds the actor.
 * @param {number} dt Step in seconds.
 * @returns {{state: ActorState, poses: ActorPose[]}} Poses now and the next state.
 */
export function stepActors(actorState, map, blockers, egoSpeed, dt) {
  if (actorState.actors.length !== map.actors.length) {
    throw new Error('Actor state does not match the map actors');
  }
  // A single footprint passed where the list belongs would read its corners as footprints.
  if (!Array.isArray(blockers) || (blockers.length > 0 && !Array.isArray(blockers[0]?.[0]))) {
    throw new TypeError('stepActors needs a list of blocker footprints, the ego first');
  }
  const ego = blockers.length > 0 ? blockers[0] : null;
  /** @type {ActorPose[]} */
  const poses = [];
  /** @type {ActorRuntime[]} */
  const next = [];
  map.actors.forEach((actor, i) => {
    const rt = actorState.actors[i];
    const path = travelPath(actor);
    const length = polylineLength(path);
    const triggered = rt.triggered || triggerFires(actor, actorState.t, ego);
    const active = triggered && !rt.done;
    let speed = 0;
    if (active) {
      const ahead = actorStoppingDistance(actor) + actor.lengthM / 2 + HOLD_MARGIN_M;
      const pieces = corridor(path, length, actor.loop, rt.s, ahead, actor.widthM);
      const blocked = pieces.some((poly) => blockers.some((fp) => polygonsIntersect(poly, fp)));
      speed = blocked ? 0 : actor.speed;
    }
    const here = pointAtDistance(path, rt.s);
    poses.push({
      id: actor.id,
      kind: actor.kind,
      pos: { x: here.point[0], z: here.point[1] },
      heading: here.heading,
      speed,
      active,
      model: actor.model,
      variant: 0,
      lengthM: actor.lengthM,
      widthM: actor.widthM,
      lights: ACTOR_LIGHTS.off,
      state: speed > 0 ? 'moving' : 'stopped',
      violations: active && actor.kind === 'car' && againstLane(map, here.point, here.heading) ? WRONG_WAY : NO_VIOLATIONS,
    });
    let s = rt.s + speed * dt;
    let done = rt.done;
    if (actor.loop) {
      if (length > 0) s %= length;
    } else if (s >= length) {
      s = length;
      done = true;
    }
    next.push({ id: rt.id, s, triggered, done });
  });
  return { state: { t: actorState.t + dt, actors: next }, poses };
}
