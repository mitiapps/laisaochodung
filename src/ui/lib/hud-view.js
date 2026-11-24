/**
 * Small HUD view helpers.
 */

import { KEY_BINDINGS } from '../../contracts/controls.js';

/** @typedef {import('../../contracts/telemetry.js').Indicators} Indicators */
/** @typedef {import('../../contracts/controls.js').ControlAction} ControlAction */

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
 * Clamps a control value to 0..1; anything not finite reads as 0.
 * @param {number} v Value.
 * @returns {number} 0..1.
 */
function unit(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Steering as a 0..1 position across the slider: 0 full left, 0.5 centred, 1 full right.
 * @param {number} steer −1..1, + to the right.
 * @returns {number} 0..1.
 */
export function steerPosition(steer) {
  return unit(((Number.isFinite(steer) ? steer : 0) + 1) / 2);
}

/** Horizontal pointer travel on the steering slider, in CSS px, that gives full lock. */
export const STEER_SLIDER_RANGE_PX = 72;

/**
 * Steering from the slider pointer's horizontal offset from where it went down.
 * @param {number} dxPx Offset in CSS px, + to the right.
 * @param {number} [rangePx] Offset of full lock.
 * @returns {number} −1..1; 0 for a non-finite offset.
 */
export function sliderSteer(dxPx, rangePx = STEER_SLIDER_RANGE_PX) {
  if (!Number.isFinite(dxPx) || !(rangePx > 0)) return 0;
  return Math.max(-1, Math.min(1, dxPx / rangePx));
}

/**
 * Vietnamese name of an action, from its key binding (used for `aria-label`s).
 * @param {ControlAction} action Action.
 * @returns {string} Name.
 */
export function actionLabel(action) {
  const binding = KEY_BINDINGS.find((b) => b.action === action);
  if (!binding) throw new RangeError(`No key binding for action "${String(action)}"`);
  return binding.label.vi;
}

/**
 * @typedef {object} ArcButton
 * @property {ControlAction} action Action.
 * @property {'hold' | 'press'} mode Hold or press.
 * @property {string} label `aria-label`.
 * @property {string} text Short visible text.
 * @property {string | null} testId Test id of the state it shows, or null.
 * @property {boolean} on Its state is on.
 * @property {boolean} blink Blinks while on (indicators).
 */

/** Arc rows above the pedals: signals and hazard, then horn, lights, flash and the gear pair. */
export const ARC_ROWS = Object.freeze([
  Object.freeze(/** @type {ControlAction[]} */ (['signalLeft', 'hazard', 'signalRight'])),
  Object.freeze(/** @type {ControlAction[]} */ (['horn', 'lightsCycle', 'flash', 'gearDown', 'gearUp'])),
]);

/** Short visible text of the arc buttons; signals and hazard show icons instead. */
const ARC_TEXT = Object.freeze({
  signalLeft: '',
  hazard: '',
  signalRight: '',
  horn: 'Còi',
  lightsCycle: 'Đèn',
  flash: 'Nháy',
  gearDown: 'Số −',
  gearUp: 'Số +',
});

/**
 * The arc buttons with the state each shows. Every vehicle gets the gear pair: the scooter's
 * automatic gearbox moves between N and D on it.
 * @param {import('../../contracts/hud.js').HudState} state HUD state.
 * @returns {ArcButton[][]} Rows, top row first.
 */
export function arcButtons(state) {
  const lamps = indicatorLamps(state.indicators);
  /** @type {Partial<Record<ControlAction, {testId: string, on: boolean, blink?: boolean}>>} */
  const shows = {
    signalLeft: { testId: 'hud-indicator-left', on: lamps.left, blink: true },
    hazard: { testId: 'hud-hazard', on: lamps.hazard, blink: true },
    signalRight: { testId: 'hud-indicator-right', on: lamps.right, blink: true },
    horn: { testId: 'hud-horn', on: state.horn },
  };
  return ARC_ROWS.map((row) =>
    row.map((action) => {
      const binding = /** @type {import('../../contracts/controls.js').KeyBinding} */ (KEY_BINDINGS.find((b) => b.action === action));
      const show = shows[action];
      return {
        action,
        mode: binding.mode,
        label: binding.label.vi,
        text: ARC_TEXT[/** @type {keyof ARC_TEXT} */ (action)],
        testId: show?.testId ?? null,
        on: show?.on ?? false,
        blink: show?.blink ?? false,
      };
    }),
  );
}

/**
 * @typedef {object} PedalControl
 * @property {'handbrake' | 'brake' | 'throttle'} action Action.
 * @property {'hud-handbrake' | 'hud-brake-rear' | 'hud-brake-front' | 'hud-throttle'} testId Test
 *   id of the state it shows.
 * @property {string} label Vietnamese label.
 * @property {number} fraction Applied value 0..1.
 * @property {boolean} on Applied at all.
 * @property {'lever' | 'pedal'} shape A round lever button or a tall pedal.
 */

/**
 * Pedals and the lever beside them, left to right: handbrake (car) or rear brake (motorbike),
 * brake, throttle at the screen edge. On the simple preset the motorbike's one brake applies both
 * brakes, so its pedal reads "Phanh".
 * @param {import('../../contracts/hud.js').HudControls} controls Applied controls.
 * @param {boolean} isCar Car or motorbike.
 * @param {import('../../contracts/controls.js').ControlPreset} preset Control preset of the run.
 * @returns {PedalControl[]} Controls in display order.
 */
export function pedalControls(controls, isCar, preset) {
  const lever = isCar
    ? { action: /** @type {const} */ ('handbrake'), testId: /** @type {const} */ ('hud-handbrake'), label: 'Phanh tay', fraction: controls.handbrake ? 1 : 0 }
    : { action: /** @type {const} */ ('handbrake'), testId: /** @type {const} */ ('hud-brake-rear'), label: 'Phanh sau', fraction: unit(controls.brakeRear) };
  const brakeLabel = isCar ? 'Phanh chân' : preset === 'simple' ? 'Phanh' : 'Phanh trước';
  /** @type {Omit<PedalControl, 'on'>[]} */
  const controlsInOrder = [
    { ...lever, shape: 'lever' },
    { action: 'brake', testId: 'hud-brake-front', label: brakeLabel, fraction: unit(controls.brakeFront), shape: 'pedal' },
    { action: 'throttle', testId: 'hud-throttle', label: 'Ga', fraction: unit(controls.throttle), shape: 'pedal' },
  ];
  return controlsInOrder.map((c) => ({ ...c, on: c.fraction > 0 }));
}

/** Vietnamese name of each preset, for the pause menu and the home page. */
export const PRESET_NAMES = Object.freeze({ simple: 'Đơn giản', real: 'Thực tế' });

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
