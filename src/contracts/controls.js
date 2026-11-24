/**
 * Player input contract and the one key-binding table, read by the input module and the help overlay.
 */

/**
 * One step of player input. Analog values are clamped by the producer.
 * @typedef {object} ControlInput
 * @property {number} throttle 0..1.
 * @property {number} brakeFront 0..1; the foot brake on a car, the front brake on a motorbike.
 * @property {number} brakeRear 0..1; the rear brake on a motorbike, unused on a car.
 * @property {number} steer −1..1; −1 is full left, +1 full right.
 * @property {boolean} handbrake Car handbrake; unused on a motorbike (Space drives `brakeRear` there).
 * @property {'up' | 'down' | null} gearCmd Gear change requested this step (edge, not level).
 * @property {'left' | 'right' | 'hazard' | null} signalCmd Indicator toggle requested this step (edge).
 * @property {'cycle' | 'flash' | null} lightsCmd `cycle`: off → low → high → off; `flash`: high beam while held.
 * @property {boolean} horn Horn held.
 */

/**
 * @typedef {'throttle' | 'brake' | 'handbrake' | 'steerLeft' | 'steerRight' | 'gearUp' | 'gearDown'
 *   | 'signalLeft' | 'signalRight' | 'hazard' | 'lightsCycle' | 'flash' | 'horn' | 'pause'} ControlAction
 *   `pause` is handled by the game outside the sim step; it is not a `ControlInput` field.
 */

/**
 * @typedef {object} KeyBinding
 * @property {ControlAction} action Action name.
 * @property {string[]} keys `KeyboardEvent.code` values, first one shown in help.
 * @property {'hold' | 'press'} mode `hold` acts while held; `press` acts once per key-down.
 * @property {import('./vehicle.js').LocalText} label Help text.
 */

/**
 * Control preset, chosen on the home page and fixed for a run. `simple` (Đơn giản) turns the
 * assists on; `real` (Thực tế) is the game without assists. Presets never change scoring.
 * @typedef {'simple' | 'real'} ControlPreset
 */

/**
 * Driving assists a preset turns on. No assist performs a scored duty.
 * @typedef {object} ControlAssists
 * @property {boolean} autoGearbox Car: the selector R ← N ← D on the gear keys, ratios shift
 *   automatically.
 * @property {null | {turnMinDeg: number, clearM: number}} signalAutoCancel Cancel the indicator after
 *   a signalled junction turn of at least `turnMinDeg`, once no junction lies within `clearM` ahead;
 *   null when off.
 */

/** @type {readonly ControlPreset[]} */
export const CONTROL_PRESETS = Object.freeze(['simple', 'real']);

/** @type {readonly KeyBinding[]} */
export const KEY_BINDINGS = Object.freeze([
  { action: 'throttle', keys: ['KeyW', 'ArrowUp'], mode: 'hold', label: { vi: 'Ga' } },
  {
    action: 'brake',
    keys: ['KeyS', 'ArrowDown'],
    mode: 'hold',
    label: { vi: 'Phanh chân (ô tô) / phanh trước (xe máy)' },
  },
  {
    action: 'handbrake',
    keys: ['Space'],
    mode: 'hold',
    label: { vi: 'Phanh tay (ô tô) / phanh sau (xe máy)' },
  },
  { action: 'steerLeft', keys: ['KeyA', 'ArrowLeft'], mode: 'hold', label: { vi: 'Lái sang trái' } },
  { action: 'steerRight', keys: ['KeyD', 'ArrowRight'], mode: 'hold', label: { vi: 'Lái sang phải' } },
  { action: 'gearUp', keys: ['KeyE'], mode: 'press', label: { vi: 'Lên số' } },
  { action: 'gearDown', keys: ['KeyQ'], mode: 'press', label: { vi: 'Xuống số' } },
  { action: 'signalLeft', keys: ['KeyZ'], mode: 'press', label: { vi: 'Xi nhan trái' } },
  { action: 'signalRight', keys: ['KeyC'], mode: 'press', label: { vi: 'Xi nhan phải' } },
  { action: 'hazard', keys: ['KeyX'], mode: 'press', label: { vi: 'Đèn cảnh báo nguy hiểm' } },
  {
    action: 'lightsCycle',
    keys: ['KeyL'],
    mode: 'press',
    label: { vi: 'Đổi đèn: tắt, chiếu gần, chiếu xa' },
  },
  { action: 'flash', keys: ['KeyF'], mode: 'hold', label: { vi: 'Nháy đèn chiếu xa' } },
  { action: 'horn', keys: ['KeyH'], mode: 'hold', label: { vi: 'Còi' } },
  { action: 'pause', keys: ['Escape', 'KeyP'], mode: 'press', label: { vi: 'Tạm dừng / tiếp tục' } },
]);

/**
 * A fresh input with nothing pressed.
 * @returns {ControlInput} Neutral input.
 */
export function neutralInput() {
  return {
    throttle: 0,
    brakeFront: 0,
    brakeRear: 0,
    steer: 0,
    handbrake: false,
    gearCmd: null,
    signalCmd: null,
    lightsCmd: null,
    horn: false,
  };
}
