import { describe, expect, it } from 'vitest';
import { VOICE_MUTE_STORAGE_KEY, readVoiceMuted, writeVoiceMuted } from './voice-mute-store.js';

/**
 * In-memory storage.
 * @param {Record<string, string>} [init] Initial entries.
 * @returns {import('./voice-mute-store.js').VoiceMuteStorage & {data: Map<string, string>}} Storage.
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

describe('voice mute store', () => {
  it('round-trips the flag under its own key', () => {
    expect(VOICE_MUTE_STORAGE_KEY).toBe('laisaochodung.voiceMuted');
    const s = memory();
    expect(writeVoiceMuted(true, s)).toBe(true);
    expect(s.data.get(VOICE_MUTE_STORAGE_KEY)).toBe('1');
    expect(readVoiceMuted(s)).toBe(true);
    writeVoiceMuted(false, s);
    expect(readVoiceMuted(s)).toBe(false);
  });

  it('reads not muted for a missing, unknown or unreadable value', () => {
    expect(readVoiceMuted(memory())).toBe(false);
    expect(readVoiceMuted(memory({ [VOICE_MUTE_STORAGE_KEY]: 'yes' }))).toBe(false);
    expect(readVoiceMuted(broken)).toBe(false);
    expect(readVoiceMuted(null)).toBe(false);
  });

  it('reports a failed write', () => {
    expect(writeVoiceMuted(true, broken)).toBe(false);
    expect(writeVoiceMuted(true, null)).toBe(false);
  });
});
