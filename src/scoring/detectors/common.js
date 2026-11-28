/**
 * Helpers shared by detectors. Every detector has the shape
 * `detect(detectorState, frame, ctx, params) -> {detectorState, active, tierInput, severity?}`,
 * with `detectorState` plain JSON and `init()` giving its fresh state.
 */

import { headingVector, leftVector, segmentIntersection } from '../../geometry/index.js';

/** @typedef {import('../../contracts/index.js').Frame} Frame */
/** @typedef {import('../../contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../contracts/index.js').MapActor} MapActor */
/** @typedef {import('../../contracts/index.js').ActorPose} ActorPose */
/** @typedef {import('../../contracts/index.js').LaneLine} LaneLine */
/** @typedef {import('../context.js').StepContext} StepContext */

/**
 * @typedef {object} DetectorResult
 * @property {unknown} detectorState Next detector state (plain JSON).
 * @property {boolean} active The rule is breached this step.
 * @property {Record<string, unknown>} tierInput Values matched against `tier.when`.
 * @property {number} [severity] Episode escalation rank; defaults to the tier index.
 * @property {boolean} [basisVerified] False when the detection used unverified legal data (an
 *   unverified TT 38 default limit); defaults to true.
 */

/**
 * Shape of one detector parameter, checked by the rules validator: a finite number, one of some
 * strings, an array of such strings, or a record with exactly the given keys, each of shape `of`.
 * An `optional` key may be left out of `detection.params`.
 * @typedef {NumberSpec | EnumSpec | EnumListSpec | RecordSpec} ParamSpec
 */
/** @typedef {{type: 'number', optional?: boolean}} NumberSpec */
/** @typedef {{type: 'enum', values: ReadonlyArray<string>, optional?: boolean}} EnumSpec */
/** @typedef {{type: 'enum-list', values: ReadonlyArray<string>}} EnumListSpec */
/** @typedef {{type: 'record', keys: ReadonlyArray<string>, of: ParamSpec}} RecordSpec */
/** @typedef {Readonly<Record<string, ParamSpec>>} ParamSpecs Every parameter a detector reads. */

/** A required finite number parameter. */
export const NUMBER = Object.freeze({ type: /** @type {const} */ ('number') });
/** An optional finite number parameter (the detector has a default). */
export const OPTIONAL_NUMBER = Object.freeze({ type: /** @type {const} */ ('number'), optional: true });

/**
 * @typedef {object} Detector
 * @property {ParamSpecs} paramSpec The parameters `detection.params` must give, and no others.
 * @property {() => unknown} init Fresh state.
 * @property {(state: never, frame: Frame, ctx: StepContext, params: never) => DetectorResult} detect
 *   One step. Each detector declares its own state and params shapes; the scorer passes the
 *   detector's own state back and the rule's `detection.params`, which the validator checked
 *   against `paramSpec`.
 */

/** Degrees to radians. */
export const DEG = Math.PI / 180;

/** Tolerance for comparisons of times built from `tick · DT`. */
export const EPS_T = 1e-9;

/**
 * Whether the ego backs slowly: a signed speed below 0 and no faster than `backExemptMaxMps`
 * backwards. The scooter's push-back and a car's slow R-gear manoeuvring fall in this band; a car
 * reversing faster does not.
 * @param {number} signedSpeed Signed ego speed (negative backwards).
 * @param {number} backExemptMaxMps Fastest backward speed of the band.
 * @returns {boolean} Slow backing.
 */
export function slowBacking(signedSpeed, backExemptMaxMps) {
  return signedSpeed < 0 && signedSpeed >= -backExemptMaxMps;
}

/**
 * Start time of a condition held continuously, or null when it does not hold.
 * @param {number | null} since Previous start.
 * @param {boolean} cond Condition now.
 * @param {number} t Time now.
 * @returns {number | null} Start time.
 */
export function holdSince(since, cond, t) {
  if (!cond) return null;
  return since ?? t;
}

/**
 * Whether a condition started at `since` has held for `duration` seconds.
 * @param {number | null} since Start time.
 * @param {number} t Time now.
 * @param {number} duration Seconds.
 * @returns {boolean} Held long enough.
 */
export function heldFor(since, t, duration) {
  return since !== null && t - since >= duration - EPS_T;
}

/**
 * A point in the ego frame: distance ahead along the heading and to the left.
 * @param {Vec2} origin Ego point.
 * @param {number} heading Ego heading.
 * @param {Vec2} p Point.
 * @returns {{along: number, lateral: number}} Coordinates.
 */
export function egoFrame(origin, heading, p) {
  const [fx, fz] = headingVector(heading);
  const [lx, lz] = leftVector(heading);
  const dx = p[0] - origin[0];
  const dz = p[1] - origin[1];
  return { along: dx * fx + dz * fz, lateral: dx * lx + dz * lz };
}

/**
 * Distance from `p` along `heading` to a segment, or null when the ray misses it. The ray runs
 * both ways, so a segment just behind gives a negative distance.
 * @param {Vec2} p Start.
 * @param {number} heading Heading.
 * @param {[Vec2, Vec2]} segment Segment.
 * @param {number} [reach] Ray length each way, metres.
 * @returns {number | null} Signed distance.
 */
export function distanceAlong(p, heading, segment, reach = 500) {
  const [fx, fz] = headingVector(heading);
  /** @type {Vec2} */
  const a = [p[0] - fx * reach, p[1] - fz * reach];
  /** @type {Vec2} */
  const b = [p[0] + fx * reach, p[1] + fz * reach];
  const hit = segmentIntersection(a, b, segment[0], segment[1]);
  return hit ? (hit.t - 0.5) * 2 * reach : null;
}

/**
 * Whether crossing a lane line from `fromSide` is allowed by its marking.
 * @param {LaneLine} line Line.
 * @param {'left' | 'right'} fromSide Side the vehicle came from (relative to the line direction).
 * @returns {boolean} Lawful.
 */
export function lawfulCross(line, fromSide) {
  if (line.crossable === 'both') return true;
  if (line.crossable === 'left-to-right') return fromSide === 'left';
  if (line.crossable === 'right-to-left') return fromSide === 'right';
  return false;
}

/** @type {WeakMap<GameMap, Map<string, MapActor>>} */
const ACTORS = new WeakMap();

/**
 * Map record of an actor pose.
 * @param {GameMap} map Map.
 * @param {string} id Actor id.
 * @returns {MapActor | null} Actor.
 */
export function actorInfo(map, id) {
  let byId = ACTORS.get(map);
  if (!byId) {
    byId = new Map(map.actors.map((a) => [a.id, a]));
    ACTORS.set(map, byId);
  }
  return byId.get(id) ?? null;
}

/**
 * Active actors near the ego (the step's distance-filtered list, `ctx.actors`) with their
 * ego-frame coordinates, sizes and effective speed (0 for a wreck).
 * @param {StepContext} ctx Context.
 * @param {ActorPose['kind'] | ReadonlyArray<ActorPose['kind']> | null} kind Kind or kinds to keep, null for all.
 * @returns {import('../context.js').NearActor[]} Actors in frame order.
 */
export function actorsAround(ctx, kind) {
  if (kind === null) return ctx.actors;
  const kinds = typeof kind === 'string' ? [kind] : kind;
  return ctx.actors.filter((a) => kinds.includes(a.pose.kind));
}

/** Kinds that are vehicles. */
export const VEHICLE_KINDS = Object.freeze(/** @type {const} */ (['car', 'motorbike']));

/**
 * Whether the time of day (minute) lies in a window that may wrap midnight.
 * @param {number} minute Minute of day.
 * @param {number} from Window start, inclusive.
 * @param {number} to Window end, exclusive.
 * @returns {boolean} Inside.
 */
export function inClockWindow(minute, from, to) {
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}
