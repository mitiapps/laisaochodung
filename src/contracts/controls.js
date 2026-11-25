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
 * @property {boolean} handbrake Car handbrake; unused on a motorbike (the handbrake and rear-brake keys
 *   drive `brakeRear` there).
 * @property {'up' | 'down' | null} gearCmd Gear change requested this step (edge, not level).
 * @property {'left' | 'right' | 'hazard' | null} signalCmd Indicator toggle requested this step (edge).
 * @property {'cycle' | 'flash' | null} lightsCmd `cycle`: off → low → high → off; `flash`: high beam while held.
 * @property {boolean} horn Horn held.
 */

/**
 * @typedef {'throttle' | 'brake' | 'steerLeft' | 'steerRight' | 'signalLeft' | 'signalRight'
 *   | 'lightsCycle' | 'flash' | 'horn' | 'hazard' | 'gearUp' | 'gearDown' | 'handbrake' | 'brakeRear'
 *   | 'camera' | 'pause'} ControlAction
 *   `handbrake` (car) and `brakeRear` (motorbike) are one control in the input: either key applies the
 *   car's handbrake on a car and the rear brake on a motorbike. `gearUp` and `gearDown` act on a
 *   car only: the input switches them off by legal class, not by gearbox, which holds because every
 *   motorbike in the catalog has an automatic gearbox (a catalog test enforces it). A manual
 *   motorbike needs the input to key the gears on the gearbox first. `camera` and `pause` are
 *   handled by the game outside the sim step; they are not `ControlInput` fields.
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

/**
 * Camera of the run's view. `chase` (default) follows behind and above the vehicle; `cockpit` looks
 * from the driver's or rider's eyes over a dash or handlebar. A view choice only: it never reaches
 * the sim, a frame, the scorer or the HUD state, and it may change at any time in a run.
 * @typedef {'chase' | 'cockpit'} CameraMode
 */

/** @type {readonly ControlPreset[]} */
export const CONTROL_PRESETS = Object.freeze(['simple', 'real']);

/** @type {readonly CameraMode[]} */
export const CAMERA_MODES = Object.freeze(['chase', 'cockpit']);

/**
 * The key table, in cabin order: pedals and wheel under the left hand (W A S D, or the arrows),
 * the indicator and light stalk left of the wheel (Q E Z X), the horn on the wheel hub (F), the
 * hazard switch on the centre dash (H), and the gear lever and handbrake under the right hand
 * (I K L, or Page Up and Page Down beside the arrows).
 * @type {readonly KeyBinding[]}
 */
export const KEY_BINDINGS = Object.freeze([
  { action: 'throttle', keys: ['KeyW', 'ArrowUp'], mode: 'hold', label: { vi: 'Ga' } },
  {
    action: 'brake',
    keys: ['KeyS', 'ArrowDown'],
    mode: 'hold',
    label: { vi: 'Phanh chân (ô tô) / phanh trước (xe máy)' },
  },
  { action: 'steerLeft', keys: ['KeyA', 'ArrowLeft'], mode: 'hold', label: { vi: 'Lái sang trái' } },
  { action: 'steerRight', keys: ['KeyD', 'ArrowRight'], mode: 'hold', label: { vi: 'Lái sang phải' } },
  { action: 'signalLeft', keys: ['KeyQ'], mode: 'press', label: { vi: 'Xi nhan trái' } },
  { action: 'signalRight', keys: ['KeyE'], mode: 'press', label: { vi: 'Xi nhan phải' } },
  {
    action: 'lightsCycle',
    keys: ['KeyZ'],
    mode: 'press',
    label: { vi: 'Đổi đèn: tắt, chiếu gần, chiếu xa' },
  },
  { action: 'flash', keys: ['KeyX'], mode: 'hold', label: { vi: 'Nháy đèn chiếu xa' } },
  { action: 'horn', keys: ['KeyF'], mode: 'hold', label: { vi: 'Còi' } },
  { action: 'hazard', keys: ['KeyH'], mode: 'press', label: { vi: 'Đèn cảnh báo nguy hiểm' } },
  { action: 'gearUp', keys: ['KeyI', 'PageUp'], mode: 'press', label: { vi: 'Lên số (ô tô)' } },
  { action: 'gearDown', keys: ['KeyK', 'PageDown'], mode: 'press', label: { vi: 'Xuống số (ô tô)' } },
  { action: 'handbrake', keys: ['KeyL'], mode: 'hold', label: { vi: 'Phanh tay (ô tô)' } },
  { action: 'brakeRear', keys: ['Space'], mode: 'hold', label: { vi: 'Phanh sau (xe máy)' } },
  { action: 'camera', keys: ['KeyV'], mode: 'press', label: { vi: 'Đổi góc nhìn' } },
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
