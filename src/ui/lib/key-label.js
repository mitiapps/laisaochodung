/**
 * Short key labels for the badges on the on-screen controls, and the rule for when badges show.
 * The labels are derived from `KEY_BINDINGS`; the contract carries no badge text.
 */

import { KEY_BINDINGS } from '../../contracts/controls.js';

/** @typedef {import('../../contracts/controls.js').ControlAction} ControlAction */

/** Short names of `KeyboardEvent.code` values that are not a single letter or digit. */
const SHORT_NAMES = Object.freeze({
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
});

/**
 * Short label of a key code for a badge.
 * @param {string} code `KeyboardEvent.code`.
 * @returns {string} E.g. `W`, `Space`, `Esc`, `↑`.
 */
export function keyLabel(code) {
  if (Object.hasOwn(SHORT_NAMES, code)) return SHORT_NAMES[/** @type {keyof SHORT_NAMES} */ (code)];
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/u.exec(code);
  return digit ? digit[1] : code;
}

/**
 * Badge text of an action: the label of the first key of its binding.
 * @param {ControlAction} action Action.
 * @returns {string} Label.
 */
export function badgeFor(action) {
  const binding = KEY_BINDINGS.find((b) => b.action === action);
  if (!binding) throw new RangeError(`No key binding for action "${String(action)}"`);
  return keyLabel(binding.keys[0]);
}

/**
 * Whether badges show after an input event: hidden after a touch, shown after a key or a mouse or
 * pen pointer. Other events leave the current choice.
 * @param {boolean} shown Current choice.
 * @param {Event} event Event.
 * @returns {boolean} New choice.
 */
export function badgesShownAfter(shown, event) {
  if (event.type === 'keydown') return true;
  if (event.type === 'pointerdown') return /** @type {PointerEvent} */ (event).pointerType !== 'touch';
  return shown;
}

/**
 * Follows the last input kind on `target` (the window) and reports when badges should show or hide.
 * It only reads events, in the capture phase, and never stops or prevents them.
 * @param {EventTarget} target Event target.
 * @param {(shown: boolean) => void} onChange Called when the choice changes.
 * @param {boolean} [initial] Starting choice; badges show by default.
 * @returns {() => void} Removes the listeners.
 */
export function watchBadgeVisibility(target, onChange, initial = true) {
  let shown = initial;
  /** @param {Event} event Event. */
  const listen = (event) => {
    const next = badgesShownAfter(shown, event);
    if (next === shown) return;
    shown = next;
    onChange(shown);
  };
  const capture = { capture: true };
  target.addEventListener('keydown', listen, capture);
  target.addEventListener('pointerdown', listen, capture);
  return () => {
    target.removeEventListener('keydown', listen, capture);
    target.removeEventListener('pointerdown', listen, capture);
  };
}
