import { describe, expect, it } from 'vitest';
import { CAMERA_MODE_STORAGE_KEY, isCameraMode, readCameraMode, writeCameraMode } from './camera-mode-store.js';

/**
 * In-memory storage.
 * @param {Record<string, string>} [init] Initial entries.
 * @returns {import('./camera-mode-store.js').CameraStorage & {data: Map<string, string>}} Storage.
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

describe('camera mode store', () => {
  it('uses its own key and round-trips both modes', () => {
    expect(CAMERA_MODE_STORAGE_KEY).toBe('laisaochodung.cameraMode');
    const s = memory();
    expect(writeCameraMode('cockpit', s)).toBe(true);
    expect(s.data.get(CAMERA_MODE_STORAGE_KEY)).toBe('cockpit');
    expect(readCameraMode(s)).toBe('cockpit');
    writeCameraMode('chase', s);
    expect(readCameraMode(s)).toBe('chase');
  });

  it('reads chase for a missing, unknown or unreadable value', () => {
    expect(readCameraMode(memory())).toBe('chase');
    expect(readCameraMode(memory({ [CAMERA_MODE_STORAGE_KEY]: 'drone' }))).toBe('chase');
    expect(readCameraMode(broken)).toBe('chase');
    expect(readCameraMode(null)).toBe('chase');
  });

  it('reports a failed write and rejects an unknown mode', () => {
    expect(writeCameraMode('cockpit', broken)).toBe(false);
    expect(writeCameraMode('cockpit', null)).toBe(false);
    expect(() => writeCameraMode(/** @type {never} */ ('drone'), memory())).toThrow(RangeError);
    expect(isCameraMode('cockpit')).toBe(true);
    expect(isCameraMode('drone')).toBe(false);
  });
});
