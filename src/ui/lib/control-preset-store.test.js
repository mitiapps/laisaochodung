import { describe, expect, it } from 'vitest';
import { CONTROL_PRESET_STORAGE_KEY, readControlPreset, writeControlPreset } from './control-preset-store.js';

/**
 * In-memory storage.
 * @param {Record<string, string>} [init] Initial entries.
 * @returns {import('./control-preset-store.js').PresetStorage & {data: Map<string, string>}} Storage.
 */
function memory(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

/** Storage whose every call throws, as a blocked or full `localStorage` does. */
const broken = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('control preset store', () => {
  it('uses the shared key and round-trips both presets', () => {
    expect(CONTROL_PRESET_STORAGE_KEY).toBe('laisaochodung.controlPreset');
    const s = memory();
    expect(writeControlPreset('real', s)).toBe(true);
    expect(s.data.get(CONTROL_PRESET_STORAGE_KEY)).toBe('real');
    expect(readControlPreset(s)).toBe('real');
    writeControlPreset('simple', s);
    expect(readControlPreset(s)).toBe('simple');
  });

  it('reads simple for a missing, invalid or unreadable value', () => {
    expect(readControlPreset(memory())).toBe('simple');
    expect(readControlPreset(memory({ [CONTROL_PRESET_STORAGE_KEY]: 'arcade' }))).toBe('simple');
    expect(readControlPreset(broken)).toBe('simple');
    expect(readControlPreset(null)).toBe('simple');
  });

  it('reports a failed write and rejects an unknown preset', () => {
    expect(writeControlPreset('real', broken)).toBe(false);
    expect(writeControlPreset('real', null)).toBe(false);
    expect(() => writeControlPreset(/** @type {never} */ ('arcade'), memory())).toThrow(RangeError);
  });
});
