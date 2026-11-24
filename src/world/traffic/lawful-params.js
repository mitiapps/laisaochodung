/**
 * The lawful driver population: the same traffic parameters with every rule-breaking draw,
 * distraction and perception error off, and no personality accepting a gap shorter than its
 * class's critical gap, and the yellow choice a fixed step at the driver's `b_stop`. Agents then obey signals and right of way and never drive into anything
 * they see, which is what the junction, signal and overlap invariants are checked against.
 */

/** @typedef {import('../../contracts/traffic.js').TrafficParams} TrafficParams */

/** Steepness that turns the logistic yellow choice into a step, s²/m. */
const LAWFUL_YELLOW_K = 1e3;

/**
 * @param {TrafficParams} params Compiled traffic parameters.
 * @returns {TrafficParams} A copy with the lawful population.
 */
export function lawfulParams(params) {
  const out = structuredClone(params);
  for (const row of Object.values(out.personalities)) {
    for (const key of /** @type {(keyof typeof row.violations)[]} */ (Object.keys(row.violations))) row.violations[key] = 0;
    row.distanceErr = 0;
    row.approachErr = 0;
    row.criticalGapFactor = Math.max(1, row.criticalGapFactor);
  }
  // A step at b_stop instead of a logistic yellow choice: stop whenever that is comfortable enough.
  out.violations.yellowLogisticK = LAWFUL_YELLOW_K;
  return out;
}
