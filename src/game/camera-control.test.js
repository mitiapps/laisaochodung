import { describe, expect, it, vi } from 'vitest';
import { CAMERA_MODE_STORAGE_KEY, readCameraMode, writeCameraMode } from '../ui/lib/camera-mode-store.js';
import { createCameraControl } from './camera-control.js';

/**
 * In-memory storage.
 * @param {Record<string, string>} [init] Initial entries.
 * @returns {import('../ui/lib/camera-mode-store.js').CameraStorage & {data: Map<string, string>}} Storage.
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

/**
 * The browser build's store, over the given storage.
 * @param {import('../ui/lib/camera-mode-store.js').CameraStorage} storage Storage.
 * @returns {import('./camera-control.js').CameraModeStore} Store.
 */
function storeOf(storage) {
  return { read: () => readCameraMode(storage), write: (mode) => writeCameraMode(mode, storage) };
}

describe('createCameraControl', () => {
  it('starts from the stored mode, chase for an unknown one', () => {
    expect(createCameraControl({ store: storeOf(memory({ [CAMERA_MODE_STORAGE_KEY]: 'cockpit' })) }).mode()).toBe('cockpit');
    expect(createCameraControl({ store: storeOf(memory({ [CAMERA_MODE_STORAGE_KEY]: 'drone' })) }).mode()).toBe('chase');
  });

  it('toggles, stores the choice, applies it to the attached renderer and tells subscribers', () => {
    const storage = memory();
    const camera = createCameraControl({ store: storeOf(storage) });
    const renderer = { setCameraMode: vi.fn() };
    /** @type {string[]} */
    const seen = [];
    const off = camera.subscribe((m) => seen.push(m));
    camera.attach(renderer);
    expect(renderer.setCameraMode).toHaveBeenLastCalledWith('chase');
    camera.toggle();
    expect(camera.mode()).toBe('cockpit');
    expect(storage.data.get(CAMERA_MODE_STORAGE_KEY)).toBe('cockpit');
    expect(renderer.setCameraMode).toHaveBeenLastCalledWith('cockpit');
    camera.toggle();
    expect(camera.mode()).toBe('chase');
    off();
    camera.set('cockpit');
    expect(seen).toEqual(['chase', 'cockpit', 'chase']);
    // A later control reads what this one stored, as a reload does.
    expect(createCameraControl({ store: storeOf(storage) }).mode()).toBe('cockpit');
  });

  it('detaches, accepts a renderer without camera modes and rejects an unknown mode', () => {
    const camera = createCameraControl({ store: storeOf(memory()) });
    const renderer = { setCameraMode: vi.fn() };
    camera.attach(renderer);
    camera.attach(null);
    camera.toggle();
    expect(renderer.setCameraMode).toHaveBeenCalledTimes(1);
    camera.attach({});
    expect(() => camera.toggle()).not.toThrow();
    expect(() => camera.set(/** @type {never} */ ('drone'))).toThrow(RangeError);
  });

  it('rejects a store that returns an unknown mode', () => {
    expect(() => createCameraControl({ store: { read: () => /** @type {never} */ ('drone'), write: () => true } })).toThrow(RangeError);
  });

  it('keeps working when storage is blocked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocked = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    const camera = createCameraControl({ store: storeOf(blocked) });
    expect(camera.mode()).toBe('chase');
    camera.toggle();
    expect(camera.mode()).toBe('cockpit');
    camera.toggle();
    camera.toggle();
    expect(camera.mode()).toBe('cockpit');
    // One warning per control, not one per toggle.
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
