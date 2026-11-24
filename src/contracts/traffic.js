/**
 * Traffic parameters contract: driver and vehicle values shared by every map, compiled once from
 * `data/traffic/params.yaml` to `src/generated/traffic-params.json` by `npm run build:traffic` and
 * passed to `createTraffic(map, params, runSeed)`. Per-map values (seed, density, mix, sources,
 * sinks) live in `GameMap.traffic`, never here.
 *
 * The YAML keeps a `paramBasis` entry beside every number (`design`, or `{sourced: <source id>}`)
 * and a `sources` table; the compiled JSON drops both, so this typedef holds values only.
 */

import { Checker } from './check.js';

/** @typedef {import('./check.js').UntrustedJson} UntrustedJson */

/** @typedef {'car' | 'taxi' | 'truck' | 'bus' | 'motorbike'} TrafficClass Driving class of a model. */
/** @typedef {'careful' | 'normal' | 'reckless'} Personality Driver personality. */

/**
 * IDM row and class limits for the "normal" personality; personalities scale it.
 * @typedef {object} ClassParams
 * @property {number} v0Kmh Desired speed where no limit is known.
 * @property {number} v0LimitFactor Desired speed as a share of the limit in force.
 * @property {number} timeGapS IDM safe time gap T.
 * @property {number} minGapM IDM jam distance s0.
 * @property {number} accelMps2 IDM maximum acceleration a.
 * @property {number} comfortDecelMps2 IDM comfortable deceleration b.
 * @property {number} delta IDM acceleration exponent δ.
 * @property {number} maxDecelMps2 Physical braking limit bmax on a dry road.
 * @property {number} reactionMeanS Mean reaction time (lognormal population).
 * @property {number} reactionSdS Standard deviation of the reaction time.
 * @property {number} criticalGapS Gap-acceptance critical gap at unsignalled conflicts.
 * @property {number} followUpGapS Follow-up headway behind an accepted gap.
 * @property {number} tailgatingGapS Time gap below which the `tailgating` flag is set.
 */

/**
 * A traffic model: what an agent of `GameMap.traffic.mix` is, physically.
 * @typedef {object} ModelParams
 * @property {TrafficClass} class Driving class.
 * @property {'car' | 'motorbike'} kind Pose kind (`ActorPose.kind`); taxis, buses and trucks are cars.
 * @property {number} lengthM Body length.
 * @property {number} widthM Body width.
 * @property {number} massKg Mass with driver, for the kinematic push on the ego.
 * @property {number} variants Colour or livery variants; poses draw `variant` in `0..variants − 1`.
 */

/**
 * Per-personality probabilities of a violation, drawn at the matching decision point (motorbike
 * values; cars scale the red-light and early-start rows by `ViolationParams.carScale`).
 * @typedef {object} ViolationRates
 * @property {number} redLight Enter after red onset.
 * @property {number} earlyStart Start while the red has less than `earlyStartRedRemainingS` left.
 * @property {number} noSignal No indicator before a turn or lane change.
 * @property {number} distracted Prone to distraction episodes.
 * @property {number} speeding Draw the desired speed above the limit.
 * @property {number} cutIn Skip the lane-change safety check, per change.
 */

/**
 * @typedef {object} PersonalityParams
 * @property {number} share Share of agents; the three shares sum to 1.
 * @property {[number, number]} v0Factor Desired speed range as a share of the class desired speed.
 * @property {[number, number]} speedingV0Factor Desired speed range when the speeding draw hits.
 * @property {number} timeGapFactor Multiplier on T.
 * @property {number} minGapFactor Multiplier on s0.
 * @property {number} accelFactor Multiplier on a.
 * @property {number} comfortDecelFactor Multiplier on b.
 * @property {number} reactionFactor Multiplier on the drawn reaction time.
 * @property {number} distractedReactionFactor Reaction multiplier during a distraction episode.
 * @property {number} distanceErr Relative gap estimation error (HDM Vs).
 * @property {number} approachErr Approach-rate error per metre of gap, 1/s (HDM rc).
 * @property {number} mobilPoliteness MOBIL politeness p.
 * @property {number} mobilThresholdMps2 MOBIL switching threshold Δa_th.
 * @property {number} mobilSafeDecelMps2 MOBIL safe deceleration b_safe.
 * @property {number} criticalGapFactor Multiplier on the class critical gap.
 * @property {number} yellowStopDecelMps2 Deceleration b_stop up to which the agent stops on yellow.
 * @property {number} distractionIntervalS Mean time between distraction episodes (Poisson).
 * @property {ViolationRates} violations Violation probabilities.
 */

/**
 * @typedef {object} HumanFactorParams
 * @property {number} perceptionTauS Time constant of the perception-error OU process.
 * @property {[number, number]} distractionDurationS Duration range of one distraction episode.
 * @property {number} v0VarCoeff Inter-driver variation coefficient of the desired speed.
 * @property {number} timeGapVarCoeff Inter-driver variation coefficient of T.
 */

/**
 * @typedef {object} ViolationParams
 * @property {number} carScale Factor on the red-light and early-start rates for every class except
 *   motorbikes.
 * @property {number} earlyStartRedRemainingS Red time left below which an early starter goes.
 * @property {number} yellowLogisticK Steepness of `P(stop) = 1 / (1 + exp(k·(b_req − b_stop)))`, s²/m.
 * @property {number} stopLineOvershootShare Share of queued motorbikes that stop past the stop line.
 * @property {number} nearEgoViolationBoost Factor on violation rates of agents near the ego (1 = off).
 * @property {number} nearEgoBoostRadiusM Radius of the near-ego boost.
 */

/**
 * @typedef {object} MotorbikeParams
 * @property {number} laneWidthPerMps Dynamic lane width `lw = laneWidthPerMps · v + laneWidthBaseM`.
 * @property {number} laneWidthBaseM Base of the dynamic lane width.
 * @property {number} passClearanceM Centre-to-centre lateral clearance when passing.
 * @property {number} sideBySideM Lateral distance below which two riders count as side by side.
 * @property {number} keepRightOffsetM Offset right of the lane centre held without slots.
 * @property {number} queueMinGapM Jam distance s0 between queued riders at a red light.
 * @property {number} slotHz Rate of the lateral slot choice.
 */

/**
 * @typedef {object} BehaviourParams
 * @property {{straight: number, left: number, right: number}} turnWeights Route choice at a
 *   junction; the weights sum to 1.
 * @property {number} deadlockS Wait after which the longest waiter at a standoff creeps in.
 * @property {number} mobilHz Rate of the car lane-change decision.
 * @property {number} indicatorLeadS Indicator on this long before a turn or lane change.
 * @property {number} rainDecelFactor Factor on `maxDecelMps2` in rain.
 * @property {number} wreckSlideDecelMps2 Deceleration of a wreck's post-impact slide.
 * @property {number} turnLateralMps2 Lateral acceleration a turning agent accepts on a connector.
 * @property {number} minTurnSpeedMps Slowest turn speed on a connector.
 * @property {number} longVehicleM Vehicles longer than this swing their body ends out of the path
 *   on a turn, so swing zones and hold-point move-back apply to them.
 * @property {number} swingConflictM Centreline distance below which two unlisted connectors of a
 *   junction still conflict when a long vehicle is involved.
 * @property {number} maxHoldBackM Furthest a hold point moves back out of a long vehicle's sweep.
 * @property {number} gapLookM Furthest a conflicting agent is looked for in gap acceptance.
 * @property {number} egoOnLaneM Lateral distance from an exit lane's centre within which the ego
 *   blocks that lane for the keep-clear rule.
 * @property {number} yellowGoMarginS Margin before the yellow ends by which an agent going on yellow
 *   must reach the stop line.
 * @property {number} brakeLampMps2 Deceleration above which the brake lamps light.
 * @property {number} corridorMarginM Margin on each side of an agent's body in its path corridor.
 */

/**
 * Target band of NPC–NPC incidents at full density, checked by a seed sweep.
 * @typedef {object} IncidentBand
 * @property {number} minPerMin Fewest incidents per simulated minute.
 * @property {number} maxPerMin Most incidents per simulated minute.
 */

/**
 * @typedef {object} TrafficParams
 * @property {Record<TrafficClass, ClassParams>} classes One row per class.
 * @property {Record<string, ModelParams>} models Models by key; `GameMap.traffic.mix` names them.
 * @property {Record<Personality, PersonalityParams>} personalities Personality rows.
 * @property {HumanFactorParams} humanFactors Reaction, perception and distraction.
 * @property {ViolationParams} violations Violation mechanics.
 * @property {MotorbikeParams} motorbike Lateral behaviour of motorbikes.
 * @property {BehaviourParams} behaviour Junction, lane-change and wreck behaviour.
 * @property {IncidentBand} incidentBand Incident rate target.
 * @property {number} mirrorRadiusM Agents within this distance of the ego get a physics body.
 * @property {number} maxMirrored Most agents mirrored at once.
 * @property {number} strikerShare Share of the closing speed above which one party is the striker
 *   (otherwise `both`).
 * @property {number} wreckClearS A wreck clears after this long.
 * @property {number} wreckClearDistM A wreck behind the ego clears once this far from it.
 * @property {number} sourceMinEgoDistM A source spawns only when farther than this from the ego.
 * @property {number} despawnBehindM Agents this far behind the ego despawn.
 * @property {number} preRollS Traffic is stepped this long before `t = 0`.
 * @property {number} egoPerceptionM Agents within this distance perceive the ego exactly.
 * @property {number} viewHalfAngleDeg Half angle of the ego's view cone, in which the ring spawner
 *   and dead-end despawns avoid acting.
 * @property {number} viewRangeM Range of the ego's view cone.
 * @property {number} spawnClearM Extra clearance a new agent needs from agents around it.
 * @property {number} spawnEgoMarginM Margin around the ego footprint inside which no agent spawns.
 */

/** @type {readonly TrafficClass[]} */
export const TRAFFIC_CLASSES = Object.freeze(['car', 'taxi', 'truck', 'bus', 'motorbike']);
/** @type {readonly Personality[]} */
export const PERSONALITIES = Object.freeze(['careful', 'normal', 'reckless']);

/** Tolerance on sums of shares and weights. */
const SUM_TOLERANCE = 1e-6;

/** @type {readonly (keyof ClassParams)[]} */
const CLASS_KEYS = Object.freeze([
  'v0Kmh',
  'v0LimitFactor',
  'timeGapS',
  'minGapM',
  'accelMps2',
  'comfortDecelMps2',
  'delta',
  'maxDecelMps2',
  'reactionMeanS',
  'reactionSdS',
  'criticalGapS',
  'followUpGapS',
  'tailgatingGapS',
]);
/** @type {readonly (keyof PersonalityParams)[]} */
const PERSONALITY_SCALARS = Object.freeze([
  'timeGapFactor',
  'minGapFactor',
  'accelFactor',
  'comfortDecelFactor',
  'reactionFactor',
  'distractedReactionFactor',
  'distanceErr',
  'approachErr',
  'mobilPoliteness',
  'mobilThresholdMps2',
  'mobilSafeDecelMps2',
  'criticalGapFactor',
  'yellowStopDecelMps2',
  'distractionIntervalS',
]);
/** @type {readonly (keyof ViolationRates)[]} */
const VIOLATION_RATES = Object.freeze([
  'redLight',
  'earlyStart',
  'noSignal',
  'distracted',
  'speeding',
  'cutIn',
]);
/** Scalar keys of the top level, of `violations`, `motorbike`, `behaviour` and `incidentBand`. */
const TOP_SCALARS = Object.freeze([
  'mirrorRadiusM',
  'maxMirrored',
  'strikerShare',
  'wreckClearS',
  'wreckClearDistM',
  'sourceMinEgoDistM',
  'despawnBehindM',
  'preRollS',
  'egoPerceptionM',
  'viewHalfAngleDeg',
  'viewRangeM',
  'spawnClearM',
  'spawnEgoMarginM',
]);
const VIOLATION_SCALARS = Object.freeze([
  'carScale',
  'earlyStartRedRemainingS',
  'yellowLogisticK',
  'stopLineOvershootShare',
  'nearEgoViolationBoost',
  'nearEgoBoostRadiusM',
]);
const MOTORBIKE_SCALARS = Object.freeze([
  'laneWidthPerMps',
  'laneWidthBaseM',
  'passClearanceM',
  'sideBySideM',
  'keepRightOffsetM',
  'queueMinGapM',
  'slotHz',
]);
const BEHAVIOUR_SCALARS = Object.freeze([
  'deadlockS',
  'mobilHz',
  'indicatorLeadS',
  'rainDecelFactor',
  'wreckSlideDecelMps2',
  'turnLateralMps2',
  'minTurnSpeedMps',
  'longVehicleM',
  'swingConflictM',
  'maxHoldBackM',
  'gapLookM',
  'egoOnLaneM',
  'yellowGoMarginS',
  'brakeLampMps2',
  'corridorMarginM',
]);

/**
 * Keys that divide or size something, so zero is invalid: IDM a and b, the braking limit, time
 * constants, body size and mass, and decision rates.
 */
const POSITIVE_KEYS = new Set([
  'accelMps2',
  'comfortDecelMps2',
  'maxDecelMps2',
  'delta',
  'reactionMeanS',
  'lengthM',
  'widthM',
  'massKg',
  'perceptionTauS',
  'distractionIntervalS',
  'slotHz',
  'mobilHz',
  'mirrorRadiusM',
  'wreckClearS',
  'turnLateralMps2',
  'minTurnSpeedMps',
  'longVehicleM',
  'viewHalfAngleDeg',
  'viewRangeM',
]);

/**
 * Checks that `v` holds exactly `keys` (plus any `extra`) as non-negative finite numbers, positive
 * for `POSITIVE_KEYS`.
 * @param {Checker} c Checker.
 * @param {UntrustedJson} v Object (untrusted).
 * @param {readonly string[]} keys Required numeric keys.
 * @param {string} path Path.
 * @param {readonly string[]} [extra] Other allowed keys, checked by the caller.
 * @returns {void}
 */
function numbers(c, v, keys, path, extra = []) {
  for (const k of keys) {
    if (c.number(v[k], `${path}.${k}`, { min: 0 }) && v[k] === 0 && POSITIVE_KEYS.has(k)) c.fail(`${path}.${k}`, 'must be positive');
  }
  for (const k of Object.keys(v)) {
    if (!keys.includes(k) && !extra.includes(k)) c.fail(`${path}.${k}`, 'unknown key');
  }
}

/**
 * @param {Checker} c Checker.
 * @param {unknown} v Candidate `[min, max]`.
 * @param {string} path Path.
 * @returns {void}
 */
function range(c, v, path) {
  if (!c.array(v, path)) return;
  if (v.length !== 2) {
    c.fail(path, 'expected [min, max]');
    return;
  }
  const ok = c.number(v[0], `${path}[0]`, { min: 0 }) && c.number(v[1], `${path}[1]`, { min: 0 });
  if (ok && /** @type {number} */ (v[1]) < /** @type {number} */ (v[0])) c.fail(path, 'max is below min');
}

/**
 * @param {Checker} c Checker.
 * @param {number} sum Sum.
 * @param {string} path Path.
 * @returns {void}
 */
function sumsToOne(c, sum, path) {
  if (Math.abs(sum - 1) > SUM_TOLERANCE) c.fail(path, `shares sum to ${Number(sum.toFixed(6))}, expected 1`);
}

/**
 * Lists every problem of compiled traffic parameters; empty when valid.
 * @param {unknown} params Candidate parameters.
 * @returns {string[]} Problems.
 */
export function checkTrafficParams(params) {
  const c = new Checker();
  if (!c.object(params, 'params')) return c.problems;
  const p = /** @type {UntrustedJson} */ (params);
  const sections = ['classes', 'models', 'personalities', 'humanFactors', 'violations', 'motorbike', 'behaviour', 'incidentBand'];
  numbers(c, p, TOP_SCALARS, 'params', sections);
  if (Number.isFinite(p.maxMirrored) && !Number.isInteger(p.maxMirrored)) c.fail('params.maxMirrored', 'expected an integer');
  if (Number.isFinite(p.viewHalfAngleDeg) && p.viewHalfAngleDeg > 180) c.fail('params.viewHalfAngleDeg', 'must be at most 180');
  if (Number.isFinite(p.strikerShare) && (p.strikerShare <= 0.5 || p.strikerShare > 1)) {
    c.fail('params.strikerShare', 'expected a share above 0.5 and at most 1');
  }

  if (c.object(p.classes, 'classes')) {
    for (const cls of TRAFFIC_CLASSES) {
      const row = p.classes[cls];
      if (row === undefined) c.fail(`classes.${cls}`, 'missing class row');
      else if (c.object(row, `classes.${cls}`)) numbers(c, row, CLASS_KEYS, `classes.${cls}`);
    }
    for (const k of Object.keys(p.classes)) {
      if (!TRAFFIC_CLASSES.includes(/** @type {TrafficClass} */ (k))) c.fail(`classes.${k}`, 'unknown class');
    }
  }

  if (c.object(p.models, 'models')) {
    const keys = Object.keys(p.models);
    if (keys.length === 0) c.fail('models', 'expected at least one model');
    for (const key of keys) {
      const m = p.models[key];
      const mp = `models.${key}`;
      if (!c.object(m, mp)) continue;
      numbers(c, m, ['lengthM', 'widthM', 'massKg', 'variants'], mp, ['class', 'kind']);
      c.oneOf(m.class, TRAFFIC_CLASSES, `${mp}.class`);
      c.oneOf(m.kind, ['car', 'motorbike'], `${mp}.kind`);
      if (TRAFFIC_CLASSES.includes(m.class) && (m.class === 'motorbike') !== (m.kind === 'motorbike')) {
        c.fail(`${mp}.kind`, `class ${m.class} needs kind ${m.class === 'motorbike' ? 'motorbike' : 'car'}`);
      }
      if (Number.isFinite(m.variants) && (!Number.isInteger(m.variants) || m.variants < 1)) {
        c.fail(`${mp}.variants`, 'expected an integer from 1');
      }
      if (Number.isFinite(m.lengthM) && Number.isFinite(m.widthM) && m.lengthM < m.widthM) {
        c.fail(mp, 'length is below width');
      }
    }
  }

  if (c.object(p.personalities, 'personalities')) {
    let sum = 0;
    let complete = true;
    for (const name of PERSONALITIES) {
      const row = p.personalities[name];
      const rp = `personalities.${name}`;
      if (row === undefined) {
        c.fail(rp, 'missing personality row');
        complete = false;
        continue;
      }
      if (!c.object(row, rp)) {
        complete = false;
        continue;
      }
      numbers(c, row, ['share', ...PERSONALITY_SCALARS], rp, ['v0Factor', 'speedingV0Factor', 'violations']);
      range(c, row.v0Factor, `${rp}.v0Factor`);
      range(c, row.speedingV0Factor, `${rp}.speedingV0Factor`);
      if (c.object(row.violations, `${rp}.violations`)) {
        numbers(c, row.violations, VIOLATION_RATES, `${rp}.violations`);
        for (const k of VIOLATION_RATES) {
          if (row.violations[k] > 1) c.fail(`${rp}.violations.${k}`, 'a probability is at most 1');
        }
      }
      if (Number.isFinite(row.share)) sum += row.share;
      else complete = false;
    }
    for (const k of Object.keys(p.personalities)) {
      if (!PERSONALITIES.includes(/** @type {Personality} */ (k))) c.fail(`personalities.${k}`, 'unknown personality');
    }
    if (complete) sumsToOne(c, sum, 'personalities');
  }

  if (c.object(p.humanFactors, 'humanFactors')) {
    numbers(c, p.humanFactors, ['perceptionTauS', 'v0VarCoeff', 'timeGapVarCoeff'], 'humanFactors', ['distractionDurationS']);
    range(c, p.humanFactors.distractionDurationS, 'humanFactors.distractionDurationS');
    if (p.humanFactors.perceptionTauS === 0) c.fail('humanFactors.perceptionTauS', 'must be positive');
  }
  if (c.object(p.violations, 'violations')) numbers(c, p.violations, VIOLATION_SCALARS, 'violations');
  if (c.object(p.motorbike, 'motorbike')) numbers(c, p.motorbike, MOTORBIKE_SCALARS, 'motorbike');
  if (c.object(p.behaviour, 'behaviour')) {
    numbers(c, p.behaviour, BEHAVIOUR_SCALARS, 'behaviour', ['turnWeights']);
    const w = p.behaviour.turnWeights;
    if (c.object(w, 'behaviour.turnWeights')) {
      numbers(c, w, ['straight', 'left', 'right'], 'behaviour.turnWeights');
      if ([w.straight, w.left, w.right].every(Number.isFinite)) sumsToOne(c, w.straight + w.left + w.right, 'behaviour.turnWeights');
    }
  }
  if (c.object(p.incidentBand, 'incidentBand')) {
    numbers(c, p.incidentBand, ['minPerMin', 'maxPerMin'], 'incidentBand');
    if (p.incidentBand.maxPerMin < p.incidentBand.minPerMin) c.fail('incidentBand', 'maxPerMin is below minPerMin');
  }
  return c.problems;
}
