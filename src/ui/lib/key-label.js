/**
 * Key names: short cap text for the badges on the on-screen controls (`keyLabel`), Vietnamese
 * names for running text and the help table (`keyName`), and the rule for when badges show. The
 * labels are derived from `KEY_BINDINGS`; the contract carries no badge text.
 */

import { KEY_BINDINGS } from '../../contracts/controls.js';

/** @typedef {import('../../contracts/controls.js').ControlAction} ControlAction */

const ARROWS = Object.freeze({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' });
/** Cap text of `KeyboardEvent.code` values that are not a single letter or digit. */
const CAP_NAMES = Object.freeze({ ...ARROWS, Space: 'Space', Escape: 'Esc', PageUp: 'PgUp', PageDown: 'PgDn' });
/** Vietnamese names of the same codes, for running text. */
const VI_NAMES = Object.freeze({ ...ARROWS, Space: 'Phím cách', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down' });

/**
 * Name of a key code from a table, then the letter or digit it carries, then the code itself.
 * @param {Readonly<Record<string, string>>} names Names of special keys.
 * @param {string} code `KeyboardEvent.code`.
 * @returns {string} Name.
 */
function nameFrom(names, code) {
  if (Object.hasOwn(names, code)) return names[code];
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/u.exec(code);
  return digit ? digit[1] : code;
}

/**
 * Short label of a key code for a badge (the text on the key cap).
 * @param {string} code `KeyboardEvent.code`.
 * @returns {string} E.g. `W`, `Space`, `Esc`, `PgUp`, `↑`.
 */
export function keyLabel(code) {
  return nameFrom(CAP_NAMES, code);
}

/**
 * Vietnamese name of a key code for running text and the help table.
 * @param {string} code `KeyboardEvent.code`.
 * @returns {string} E.g. `W`, `↑`, `Phím cách`.
 */
export function keyName(code) {
  return nameFrom(VI_NAMES, code);
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
