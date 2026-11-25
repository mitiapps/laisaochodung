import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS } from '../../contracts/controls.js';
import { badgeFor, badgesShownAfter, keyLabel, keyName, watchBadgeVisibility } from './key-label.js';

/**
 * A pointer-down event of a kind.
 * @param {string} pointerType Pointer type.
 * @returns {Event} Event.
 */
const pointer = (pointerType) => Object.assign(new Event('pointerdown'), { pointerType });

describe('keyLabel and badgeFor', () => {
  it('gives short labels', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('PageUp')).toBe('PgUp');
    expect(keyLabel('PageDown')).toBe('PgDn');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('F13')).toBe('F13');
  });

  it('gives Vietnamese names for running text', () => {
    expect(keyName('KeyW')).toBe('W');
    expect(keyName('ArrowUp')).toBe('↑');
    expect(keyName('Space')).toBe('Phím cách');
    expect(keyName('PageUp')).toBe('Page Up');
    expect(keyName('PageDown')).toBe('Page Down');
    expect(keyName('Digit3')).toBe('3');
  });

  it('labels every action by the first key of its binding', () => {
    for (const b of KEY_BINDINGS) expect(badgeFor(b.action)).toBe(keyLabel(b.keys[0]));
    expect(badgeFor('throttle')).toBe('W');
    expect(badgeFor('handbrake')).toBe('L');
    expect(badgeFor('brakeRear')).toBe('Space');
    expect(badgeFor('gearUp')).toBe('I');
    expect(badgeFor('camera')).toBe('V');
    expect(badgeFor('pause')).toBe('Esc');
    expect(() => badgeFor(/** @type {never} */ ('jump'))).toThrow(RangeError);
  });
});

describe('badge visibility', () => {
  it('hides after a touch and shows after a key or a mouse', () => {
    expect(badgesShownAfter(true, pointer('touch'))).toBe(false);
    expect(badgesShownAfter(false, pointer('mouse'))).toBe(true);
    expect(badgesShownAfter(false, pointer('pen'))).toBe(true);
    expect(badgesShownAfter(false, new Event('keydown'))).toBe(true);
    expect(badgesShownAfter(false, new Event('pointerup'))).toBe(false);
  });

  it('reports changes only, and stops after dispose', () => {
    const target = new EventTarget();
    /** @type {boolean[]} */
    const seen = [];
    const off = watchBadgeVisibility(target, (s) => seen.push(s));
    target.dispatchEvent(pointer('mouse'));
    target.dispatchEvent(pointer('touch'));
    target.dispatchEvent(pointer('touch'));
    target.dispatchEvent(new Event('keydown'));
    off();
    target.dispatchEvent(pointer('touch'));
    expect(seen).toEqual([false, true]);
  });
});
