/**
 * Violation flags of traffic agents, set as facts from the true state whatever caused them, and the
 * per-decision draws by which an agent chooses to break a rule.
 *
 * Each step the traffic module raises the conditions that hold now (`raise`); `latch` turns them
 * into "true within the last `LATCH_S`" and `violationsOf` returns the shared frozen list of the
 * flags still latched, one list per combination, so poses never allocate.
 *
 * Draws: an agent's rule-breaking choices (red-light run, early start, yellow choice, no signal,
 * cut-in, ignoring a signalling ego) each use their own stream from the agent's decision seed and a
 * running count, so they never shift its setup or route draws.
 */

import { NO_VIOLATIONS, NPC_VIOLATIONS } from '../../contracts/telemetry.js';
import { PERSONALITIES } from '../../contracts/traffic.js';
import { createStream, hash32, uniform } from '../random.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('../../contracts/telemetry.js').NpcViolation} NpcViolation */

/**
 * How long a flag stays latched after its condition ends, seconds. Equal to the scorer's
 * `crashCauseWindowS`, which `src/world/` cannot import (a test pins the two together).
 */
export const LATCH_S = 3;

/** Bit of each flag, in `NPC_VIOLATIONS` order. */
export const FLAG = Object.freeze(
  /** @type {Record<NpcViolation, number>} */ (Object.fromEntries(NPC_VIOLATIONS.map((f, i) => [f, 1 << i]))),
);
/** Number of flags. */
export const FLAG_COUNT = NPC_VIOLATIONS.length;

/** Shared frozen flag list per bit mask, in `NPC_VIOLATIONS` order. */
const LISTS = Object.freeze(
  Array.from({ length: 1 << FLAG_COUNT }, (_, mask) =>
    mask === 0 ? NO_VIOLATIONS : Object.freeze(NPC_VIOLATIONS.filter((_f, i) => (mask & (1 << i)) !== 0)),
  ),
);

/**
 * The shared frozen list of a flag mask.
 * @param {number} mask Flag bits.
 * @returns {readonly NpcViolation[]} List (the empty one is `NO_VIOLATIONS` itself).
 */
export function listOfMask(mask) {
  return LISTS[mask];
}

/**
 * Raises flag conditions that hold for `slot` this step.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} bits Flag bits.
 * @returns {void}
 */
export function raise(st, slot, bits) {
  st.flagNow[slot] |= bits;
}

/**
 * Latches this step's conditions at time `t` and clears them for the next step.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time of the step.
 * @returns {void}
 */
export function latch(st, slot, t) {
  const now = st.flagNow[slot];
  if (now === 0) return;
  const base = slot * FLAG_COUNT;
  for (let i = 0; i < FLAG_COUNT; i += 1) if (now & (1 << i)) st.flagUntil[base + i] = t + LATCH_S;
  st.flagNow[slot] = 0;
}

/**
 * Mask of the flags latched for `slot` at time `t`: raised at some step within the last `LATCH_S`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time.
 * @returns {number} Flag bits.
 */
export function maskOf(st, slot, t) {
  const base = slot * FLAG_COUNT;
  let mask = 0;
  for (let i = 0; i < FLAG_COUNT; i += 1) if (t <= st.flagUntil[base + i]) mask |= 1 << i;
  return mask;
}

/**
 * Latched flags of `slot` at time `t`, as a shared frozen list.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time.
 * @returns {readonly NpcViolation[]} Flags.
 */
export function violationsOf(st, slot, t) {
  return LISTS[maskOf(st, slot, t)];
}

/**
 * Clears every flag of a slot (at spawn).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function clearFlags(st, slot) {
  st.flagNow[slot] = 0;
  st.flagUntil.fill(-Infinity, slot * FLAG_COUNT, (slot + 1) * FLAG_COUNT);
}

/**
 * One rule-breaking draw of an agent: true with probability `p`, from the agent's own decision
 * stream.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} p Probability, clamped to [0, 1].
 * @returns {boolean} The agent breaks the rule this time.
 */
export function draw(st, slot, p) {
  const rng = createStream(hash32(st.decisionSeed[slot], st.decisions[slot]));
  st.decisions[slot] += 1;
  return uniform(rng) < Math.min(1, Math.max(0, p));
}

/**
 * Probability of a violation for an agent: its personality rate (cars and other non-motorbike
 * classes scaled by `carScale` on the rows it applies to), times the near-ego boost within its
 * radius.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {keyof import('../../contracts/traffic.js').ViolationRates} rate Rate.
 * @param {number} egoDistM Distance to the ego.
 * @returns {number} Probability.
 */
export function rateOf(st, slot, rate, egoDistM) {
  const pers = st.params.personalities[PERSONALITIES[st.personality[slot]]];
  const v = st.params.violations;
  let p = pers.violations[rate];
  const scaled = rate === 'redLight' || rate === 'earlyStart' || rate === 'wrongWay' || rate === 'sidewalk';
  if (scaled && st.params.models[st.modelKeys[st.model[slot]]].class !== 'motorbike') p *= v.carScale;
  if (egoDistM <= v.nearEgoBoostRadiusM) p *= v.nearEgoViolationBoost;
  return p;
}
