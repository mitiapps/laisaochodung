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

/**
 * @typedef {object} PedalBar
 * @property {'throttle' | 'brake-front' | 'brake-rear'} id Test id suffix.
 * @property {string} label Vietnamese label.
 * @property {number} fraction 0..1.
 */

/**
 * Clamps a control value to 0..1; anything not finite reads as 0.
 * @param {number} v Value.
 * @returns {number} 0..1.
 */
function unit(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Pedal and lever bars for the HUD, labelled for the vehicle: the car has a foot brake (its
 * handbrake is a lamp), the motorbike front and rear brakes.
 * @param {import('../../contracts/hud.js').HudControls} controls Applied controls.
 * @param {boolean} isCar Car or motorbike.
 * @returns {PedalBar[]} Bars in display order.
 */
export function pedalBars(controls, isCar) {
  /** @type {PedalBar[]} */
  const bars = [
    { id: 'throttle', label: 'Ga', fraction: unit(controls.throttle) },
    { id: 'brake-front', label: isCar ? 'Phanh chân' : 'Phanh trước', fraction: unit(controls.brakeFront) },
  ];
  if (!isCar) bars.push({ id: 'brake-rear', label: 'Phanh sau', fraction: unit(controls.brakeRear) });
  return bars;
}

/**
 * Steering as a 0..1 position across the HUD gauge: 0 full left, 0.5 centred, 1 full right.
 * @param {number} steer −1..1, + to the right.
 * @returns {number} 0..1.
 */
export function steerPosition(steer) {
  return unit(((Number.isFinite(steer) ? steer : 0) + 1) / 2);
}

/**
 * @typedef {object} NoticeItem
 * @property {string} key Stable key: the contact tick, plus a counter for contacts on the same tick.
 * @property {import('../../contracts/score.js').Notice} notice Notice.
 */

/**
 * Keys the HUD notices for a keyed list. Notices of one contact tick arrive and leave together, so
 * the counter stays stable while they are shown.
 * @param {readonly import('../../contracts/score.js').Notice[]} notices Notices, newest last.
 * @returns {NoticeItem[]} Items in the same order.
 */
export function noticeItems(notices) {
  /** @type {Map<number, number>} */
  const perTick = new Map();
  return notices.map((notice) => {
    const n = perTick.get(notice.tick) ?? 0;
    perTick.set(notice.tick, n + 1);
    return { key: `${notice.tick}#${n}`, notice };
  });
}
