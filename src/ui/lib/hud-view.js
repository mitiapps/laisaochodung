/**
 * Small HUD view helpers.
 */

/** @typedef {import('../../contracts/telemetry.js').Indicators} Indicators */

/**
 * Full scale of the rpm bar. A display range only: the vehicle catalog carries no redline yet.
 */
export const RPM_BAR_MAX = 7000;

/**
 * Fill of the rpm bar.
 * @param {number} rpm Engine speed.
 * @param {number} [max] Full scale.
 * @returns {number} 0..1.
 */
export function rpmFraction(rpm, max = RPM_BAR_MAX) {
  if (!Number.isFinite(rpm) || rpm <= 0 || max <= 0) return 0;
  return Math.min(1, rpm / max);
}

/**
 * Which arrow lamps are lit.
 * @param {Indicators} indicators Turn-signal state.
 * @returns {{left: boolean, right: boolean, hazard: boolean}} Lamps.
 */
export function indicatorLamps(indicators) {
  const hazard = indicators === 'hazard';
  return { left: hazard || indicators === 'left', right: hazard || indicators === 'right', hazard };
}
