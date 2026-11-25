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

/** Turn of the drawn steering wheel at full lock, in degrees; a handlebar turns `HANDLEBAR_TURN_DEG`. */
export const WHEEL_TURN_DEG = 120;
/** Turn of the drawn handlebar at full lock, in degrees. */
export const HANDLEBAR_TURN_DEG = 25;

/**
 * Turn of the drawn steering control for an applied steering, in degrees, + clockwise.
 * @param {number} steer −1..1, + to the right; anything not finite reads as centred.
 * @param {'wheel' | 'handlebar'} shape Steering control.
 * @returns {number} Degrees.
 */
export function steeringTurnDeg(steer, shape) {
  const s = Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0;
  return s * (shape === 'wheel' ? WHEEL_TURN_DEG : HANDLEBAR_TURN_DEG);
}

/** Horizontal pointer travel on the steering control, in CSS px, that gives full lock. */
export const STEER_SLIDER_RANGE_PX = 72;

/**
 * Steering from the steering pointer's horizontal offset from where it went down.
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
 * @typedef {object} ControlLayout
 * The on-screen controls of a vehicle and preset, by cabin zone, left to right as in a cabin: the
 * indicator and light stalk (a motorbike's left switch cluster), the left lever, the steering, the
 * horn beside the wheel, the pedals, the right-hand console, and the game buttons at the top right.
 * @property {'wheel' | 'handlebar'} steering Steering control: a round wheel (car) or a handlebar.
 * @property {readonly (readonly ControlAction[])[]} stalk Stalk or switch-cluster rows, top row first.
 * @property {readonly ControlAction[]} lever Left-hand lever: the motorbike's rear brake on Thực tế.
 * @property {readonly ControlAction[]} horn Horn beside the wheel, on its right (car).
 * @property {readonly ControlAction[]} pedals Brake then throttle; the throttle sits nearest the edge.
 * @property {readonly ControlAction[]} console Right-hand console, top to bottom: hazard, then the
 *   car's gear lever and handbrake.
 * @property {boolean} consoleOverThrottle The console stands above the throttle at the screen edge
 *   (a motorbike's lone hazard switch) instead of in its own column beside it.
 * @property {readonly ControlAction[]} top Game buttons at the top right.
 */

/** Car zones; the stalk carries indicators and lights, the horn sits on the wheel's right. */
const CAR_LAYOUT = Object.freeze({
  steering: /** @type {const} */ ('wheel'),
  stalk: Object.freeze([Object.freeze(/** @type {ControlAction[]} */ (['lightsCycle', 'flash'])), Object.freeze(/** @type {ControlAction[]} */ (['signalLeft', 'signalRight']))]),
  lever: Object.freeze(/** @type {ControlAction[]} */ ([])),
  horn: Object.freeze(/** @type {ControlAction[]} */ (['horn'])),
  pedals: Object.freeze(/** @type {ControlAction[]} */ (['brake', 'throttle'])),
  console: Object.freeze(/** @type {ControlAction[]} */ (['hazard', 'gearUp', 'gearDown', 'handbrake'])),
  consoleOverThrottle: false,
  top: Object.freeze(/** @type {ControlAction[]} */ (['camera', 'pause'])),
});

/**
 * Motorbike zones: the left switch cluster holds the lights, the indicators and the horn; the
 * rear-brake lever shows only on Thực tế, since the Đơn giản brake applies both brakes.
 */
const MOTORBIKE_ZONES = Object.freeze({
  steering: /** @type {const} */ ('handlebar'),
  stalk: Object.freeze([
    Object.freeze(/** @type {ControlAction[]} */ (['lightsCycle', 'flash'])),
    Object.freeze(/** @type {ControlAction[]} */ (['signalLeft', 'signalRight', 'horn'])),
  ]),
  horn: Object.freeze(/** @type {ControlAction[]} */ ([])),
  pedals: Object.freeze(/** @type {ControlAction[]} */ (['brake', 'throttle'])),
  console: Object.freeze(/** @type {ControlAction[]} */ (['hazard'])),
  consoleOverThrottle: true,
  top: Object.freeze(/** @type {ControlAction[]} */ (['camera', 'pause'])),
});
const MOTORBIKE_REAL = Object.freeze({ ...MOTORBIKE_ZONES, lever: Object.freeze(/** @type {ControlAction[]} */ (['brakeRear'])) });
const MOTORBIKE_SIMPLE = Object.freeze({ ...MOTORBIKE_ZONES, lever: Object.freeze(/** @type {ControlAction[]} */ ([])) });

/**
 * The on-screen controls of a vehicle class and preset, by zone. The HUD draws these zones and the
 * browser tests read the same function, so what is drawn is what is checked.
 * @param {import('../../contracts/vehicle.js').LegalClass} legalClass Vehicle class.
 * @param {import('../../contracts/controls.js').ControlPreset} preset Control preset of the run.
 * @returns {ControlLayout} Zones.
 */
export function controlLayout(legalClass, preset) {
  if (legalClass === 'car') return CAR_LAYOUT;
  return preset === 'real' ? MOTORBIKE_REAL : MOTORBIKE_SIMPLE;
}

/**
 * Every action that has an on-screen control in a layout, the steering's two included.
 * @param {ControlLayout} layout Layout.
 * @returns {ControlAction[]} Actions in zone order.
 */
export function layoutActions(layout) {
  return [
    ...layout.stalk.flat(),
    ...layout.lever,
    'steerLeft',
    'steerRight',
    ...layout.horn,
    ...layout.pedals,
    ...layout.console,
    ...layout.top,
  ];
}

/**
 * @typedef {object} ButtonView
 * @property {ControlAction} action Action.
 * @property {'hold' | 'press'} mode Hold or press.
 * @property {string} label `aria-label`.
 * @property {string} text Short visible text.
 * @property {string | null} testId Test id of the state it shows, or null.
 * @property {boolean} on Its state is on.
 * @property {boolean} blink Blinks while on (indicators).
 */

/** Short visible text of the round buttons; signals and hazard show icons instead. */
const BUTTON_TEXT = Object.freeze({
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
 * A round button with the state it shows.
 * @param {ControlAction} action Action of a stalk, horn or console button.
 * @param {import('../../contracts/hud.js').HudState} state HUD state.
 * @returns {ButtonView} Button.
 */
export function buttonView(action, state) {
  const binding = KEY_BINDINGS.find((b) => b.action === action);
  if (!binding || !Object.hasOwn(BUTTON_TEXT, action)) throw new RangeError(`"${String(action)}" is not a round-button action`);
  const lamps = indicatorLamps(state.indicators);
  /** @type {Partial<Record<ControlAction, {testId: string, on: boolean, blink?: boolean}>>} */
  const shows = {
    signalLeft: { testId: 'hud-indicator-left', on: lamps.left, blink: true },
    hazard: { testId: 'hud-hazard', on: lamps.hazard, blink: true },
    signalRight: { testId: 'hud-indicator-right', on: lamps.right, blink: true },
    horn: { testId: 'hud-horn', on: state.horn },
  };
  const show = shows[action];
  return {
    action,
    mode: binding.mode,
    label: binding.label.vi,
    text: BUTTON_TEXT[/** @type {keyof BUTTON_TEXT} */ (action)],
    testId: show?.testId ?? null,
    on: show?.on ?? false,
    blink: show?.blink ?? false,
  };
}

/**
 * @typedef {object} PedalControl
 * @property {'handbrake' | 'brakeRear' | 'brake' | 'throttle'} action Action.
 * @property {'hud-handbrake' | 'hud-brake-rear' | 'hud-brake-front' | 'hud-throttle'} testId Test
 *   id of the state it shows.
 * @property {string} label Vietnamese label.
 * @property {number} fraction Applied value 0..1.
 * @property {boolean} on Applied at all.
 * @property {'lever' | 'pedal'} shape A round lever button or a tall pedal.
 * @property {{testId: 'hud-brake-rear', fraction: number} | null} rear The rear brake the
 *   motorbike's Đơn giản brake applies with it, shown as a second fill; null elsewhere.
 */

/**
 * A pedal or a lever with the value it shows. On Đơn giản the motorbike's one brake applies both
 * brakes, so its pedal reads "Phanh" and also shows the rear brake.
 * @param {'handbrake' | 'brakeRear' | 'brake' | 'throttle'} action Action.
 * @param {import('../../contracts/hud.js').HudControls} controls Applied controls.
 * @param {boolean} isCar Car or motorbike.
 * @param {import('../../contracts/controls.js').ControlPreset} preset Control preset of the run.
 * @returns {PedalControl} Control.
 */
export function pedalControl(action, controls, isCar, preset) {
  /** @type {Omit<PedalControl, 'on'>} */
  let c;
  if (action === 'handbrake') {
    c = { action, testId: 'hud-handbrake', label: 'Phanh tay', fraction: controls.handbrake ? 1 : 0, shape: 'lever', rear: null };
  } else if (action === 'brakeRear') {
    c = { action, testId: 'hud-brake-rear', label: 'Phanh sau', fraction: unit(controls.brakeRear), shape: 'lever', rear: null };
  } else if (action === 'brake') {
    const combined = !isCar && preset === 'simple';
    const label = isCar ? 'Phanh chân' : combined ? 'Phanh' : 'Phanh trước';
    c = {
      action,
      testId: 'hud-brake-front',
      label,
      fraction: unit(controls.brakeFront),
      shape: 'pedal',
      rear: combined ? { testId: 'hud-brake-rear', fraction: unit(controls.brakeRear) } : null,
    };
  } else if (action === 'throttle') {
    c = { action, testId: 'hud-throttle', label: 'Ga', fraction: unit(controls.throttle), shape: 'pedal', rear: null };
  } else {
    throw new RangeError(`"${String(action)}" is not a pedal or lever action`);
  }
  return { ...c, on: c.fraction > 0 };
}

/** Vietnamese name of each camera mode, for the HUD button and the home page. */
export const CAMERA_NAMES = Object.freeze({ chase: 'Thứ ba (sau xe)', cockpit: 'Thứ nhất (trong xe)' });
/** Short name of each camera mode, on the HUD button. */
export const CAMERA_SHORT_NAMES = Object.freeze({ chase: 'Sau xe', cockpit: 'Trong xe' });

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

/**
 * @typedef {object} NewestToast
 * @property {string | null} key Key of the newest item: `notice:<NoticeItem key>` or
 *   `toast:<episodeId>`; null when the stack is empty.
 * @property {number} more How many older items a short screen hides.
 */

/**
 * The newest item of the toast stack, notices and breach toasts together, by simulated tick. A
 * short screen (a landscape phone) shows only that item and a count of the others, since two
 * toasts do not fit there above the speed arc; the result screen still lists everything. On a
 * tie the breach toast wins, since it carries a penalty.
 * @param {readonly NoticeItem[]} notices Notice items, newest last.
 * @param {readonly {episodeId: string, breach: {tick: number}}[]} toasts Breach toasts, oldest first.
 * @returns {NewestToast} Newest item and the hidden count.
 */
export function newestToast(notices, toasts) {
  /** @type {string | null} */
  let key = null;
  let tick = -Infinity;
  for (const item of notices) {
    if (item.notice.tick >= tick) {
      tick = item.notice.tick;
      key = `notice:${item.key}`;
    }
  }
  for (const toast of toasts) {
    if (toast.breach.tick >= tick) {
      tick = toast.breach.tick;
      key = `toast:${toast.episodeId}`;
    }
  }
  return { key, more: Math.max(0, notices.length + toasts.length - 1) };
}
