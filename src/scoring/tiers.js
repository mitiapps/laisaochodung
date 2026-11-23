/**
 * Tier selection: a rule's tiers run from mildest to worst; the worst tier whose `when` matches
 * the detector's tier input applies.
 *
 * `when` forms, per key:
 * - `{min?, max?, minInclusive?, maxInclusive?}`: a numeric range (min inclusive and max
 *   exclusive by default), e.g. `overKmh: {min: 10, max: 20, maxInclusive: true}`;
 * - an array: the input value is one of them;
 * - any other value: equality;
 * - the key `decreeGroups` is not read from the input: it limits the tier to those groups.
 */

/** @typedef {import('../contracts/index.js').Rule} Rule */
/** @typedef {import('../contracts/index.js').DecreeGroup} DecreeGroup */

/**
 * @param {unknown} v Value.
 * @returns {v is {min?: number, max?: number, minInclusive?: boolean, maxInclusive?: boolean}} Range.
 */
function isRange(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && ('min' in v || 'max' in v);
}

/**
 * Whether a tier condition matches.
 * @param {Record<string, unknown> | undefined} when Condition.
 * @param {Record<string, unknown>} input Detector tier input.
 * @param {DecreeGroup} group Vehicle decree group.
 * @returns {boolean} Match.
 */
export function matchWhen(when, input, group) {
  if (!when) return true;
  for (const [key, cond] of Object.entries(when)) {
    if (key === 'decreeGroups') {
      if (!Array.isArray(cond) || !cond.includes(group)) return false;
      continue;
    }
    const v = input[key];
    if (isRange(cond)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (cond.min !== undefined && (cond.minInclusive === false ? v <= cond.min : v < cond.min)) return false;
      if (cond.max !== undefined && (cond.maxInclusive === true ? v > cond.max : v >= cond.max)) return false;
    } else if (Array.isArray(cond)) {
      if (!cond.includes(v)) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

/**
 * Index of the worst matching tier.
 * @param {Rule} rule Rule.
 * @param {Record<string, unknown>} input Detector tier input.
 * @param {DecreeGroup} group Vehicle decree group.
 * @returns {number} Tier index, −1 when none matches.
 */
export function selectTier(rule, input, group) {
  for (let i = rule.tiers.length - 1; i >= 0; i -= 1) {
    if (matchWhen(rule.tiers[i].when, input, group)) return i;
  }
  return -1;
}
