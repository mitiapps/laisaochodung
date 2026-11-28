/**
 * Whether the player muted the spoken tutorial lines, kept in `localStorage`. Reading never
 * throws: a missing, invalid or unreadable value is "not muted". Nothing here touches storage at
 * import time.
 */

/** @typedef {Pick<Storage, 'getItem' | 'setItem'>} VoiceMuteStorage */

/** `localStorage` key of the voice mute flag. */
export const VOICE_MUTE_STORAGE_KEY = 'laisaochodung.voiceMuted';

/**
 * The browser's `localStorage`, or null where reading it throws (blocked storage) or it is absent.
 * @returns {VoiceMuteStorage | null} Storage.
 */
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the stored mute flag.
 * @param {VoiceMuteStorage | null} [storage] Storage; the browser's by default.
 * @returns {boolean} True only when the player muted the voice.
 */
export function readVoiceMuted(storage = browserStorage()) {
  if (!storage) return false;
  try {
    return storage.getItem(VOICE_MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Stores the mute flag.
 * @param {boolean} muted Muted.
 * @param {VoiceMuteStorage | null} [storage] Storage; the browser's by default.
 * @returns {boolean} Whether it was stored (false where storage is blocked or full).
 */
export function writeVoiceMuted(muted, storage = browserStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(VOICE_MUTE_STORAGE_KEY, muted ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
