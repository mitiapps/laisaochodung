import { readFileSync } from 'node:fs';
import { Texture } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFrames } from '../testing/index.js';
import { COCKPIT_RIG, CHASE_FOV_DEG } from './scene.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */

/** Scenes the fake WebGL renderer was asked to draw, with the camera of each draw. */
const draws = /** @type {{scene: import('three').Scene, camera: import('three').PerspectiveCamera}[]} */ ([]);

// Node has no WebGL: a stand-in renderer records what it is asked to draw.
vi.mock('three', async (importOriginal) => {
  const actual = /** @type {typeof import('three')} */ (await importOriginal());
  class FakeWebGLRenderer {
    constructor() {
      this.shadowMap = { enabled: false, type: 0 };
      this.info = { render: { calls: 0 } };
      this.outputColorSpace = '';
      this.toneMapping = 0;
    }

    setPixelRatio() {}

    setSize() {}

    /**
     * @param {import('three').Scene} scene Scene.
     * @param {import('three').PerspectiveCamera} camera Camera.
     */
    render(scene, camera) {
      draws.push({ scene, camera });
      this.info.render.calls = 1;
    }

    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

// No fetch for the GLBs in Node; every view keeps its stand-in.
vi.mock('./assets.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    loadModel: (/** @type {string} */ path) => Promise.reject(new Error(`no model ${path}`)),
    loadTexture: () => Promise.resolve(new Texture()),
    releaseModels: () => Promise.resolve(),
  };
});

const { createRenderer } = await import('./renderer.js');

/**
 * @param {string} rel Repo-relative path.
 * @returns {unknown} Parsed JSON.
 */
const json = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
const MAP = /** @type {GameMap} */ (json('public/maps/tutorial-01-co-ban.json'));
const VEHICLES = /** @type {VehicleInfo[]} */ (json('data/vehicles/vehicles.json'));

/** A canvas whose document has no WebGL, so the renderer takes the high-quality path. */
const canvas = /** @type {HTMLCanvasElement} */ (
  /** @type {unknown} */ ({ clientWidth: 1280, clientHeight: 720, ownerDocument: { createElement: () => ({ getContext: () => null }) } })
);

afterEach(() => {
  draws.length = 0;
  vi.restoreAllMocks();
});

/**
 * Whether an object and all its parents are visible.
 * @param {import('three').Object3D} o Object.
 * @returns {boolean} Shown.
 */
function shown(o) {
  for (let n = /** @type {import('three').Object3D | null} */ (o); n; n = n.parent) if (!n.visible) return false;
  return true;
}

describe('renderer camera modes', () => {
  for (const legalClass of /** @type {const} */ (['car', 'motorbike'])) {
    it(`${legalClass}: a switch redraws the last frame at once, hides the body, shows the cockpit and keeps the headlight`, () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const vehicle = /** @type {VehicleInfo} */ (VEHICLES.find((v) => (legalClass === 'car' ? v.legalClass === 'car' : v.legalClass !== 'car')));
      const start = MAP.route.start.pos;
      const frames = buildFrames({ map: MAP, vehicle, path: [[start.x, start.z], [start.x + 1, start.z]], speed: 0, durationS: 0.1 });
      const renderer = createRenderer(canvas, MAP, vehicle);
      // Before any frame there is nothing to redraw.
      renderer.setCameraMode?.('cockpit');
      expect(draws).toHaveLength(0);
      renderer.render(null, frames[0], 1);
      expect(draws).toHaveLength(1);
      const { scene, camera } = draws[0];
      expect(camera.fov).toBe(COCKPIT_RIG[legalClass].fovDeg);
      const cockpit = /** @type {import('three').Object3D} */ (scene.getObjectByName('cockpit'));
      const ego = /** @type {import('three').Object3D} */ (scene.getObjectByName(`vehicle-${vehicle.id}`));
      const body = /** @type {import('three').Object3D[]} */ ([]);
      ego.traverse((o) => {
        if (o.userData.egoBody) body.push(o);
      });
      expect(body.length).toBeGreaterThan(0);
      expect(shown(cockpit)).toBe(true);
      expect(body.some(shown)).toBe(false);
      const spots = /** @type {import('three').Object3D[]} */ ([]);
      ego.traverse((o) => {
        if (/** @type {import('three').SpotLight} */ (o).isSpotLight) spots.push(o);
      });
      expect(spots).toHaveLength(1);
      expect(spots[0].parent && shown(spots[0].parent)).toBe(true);

      // Back to chase: one redraw of the same tick, body back, cockpit gone.
      renderer.setCameraMode?.('chase');
      expect(draws).toHaveLength(2);
      expect(draws[1].camera.fov).toBe(CHASE_FOV_DEG);
      expect(shown(cockpit)).toBe(false);
      expect(body.every(shown)).toBe(true);

      renderer.dispose();
      expect(() => renderer.setCameraMode?.('cockpit')).not.toThrow();
      expect(() => renderer.setCameraMode?.(/** @type {never} */ ('drone'))).not.toThrow();
      expect(draws).toHaveLength(2);
    });
  }

  it('a fall ghost copies the bike with its body shown and without the cockpit', async () => {
    const { createVehicleView } = await import('./vehicle-view.js');
    const { vehicleModel } = await import('./vehicles/index.js');
    const { buildCockpit } = await import('./cockpit.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = createVehicleView({ config: vehicleModel('scooter', 'motorbike'), lengthM: 1.85, widthM: 0.7, lamps: true });
    const cockpit = buildCockpit('motorbike', 0xff0000, 1.85, 0.7);
    view.mount(cockpit.group);
    view.setBodyVisible(false);
    const copy = view.ghost();
    let bodies = 0;
    copy.traverse((o) => {
      if (o.userData.egoBody) {
        bodies += 1;
        expect(o.visible).toBe(true);
      }
      if (o.userData.mounted) expect(o.visible).toBe(false);
      if (/** @type {import('three').SpotLight} */ (o).isSpotLight) expect(o.visible).toBe(false);
    });
    expect(bodies).toBeGreaterThan(0);
    cockpit.dispose();
    view.dispose();
  });

  it('rejects an unknown mode while live', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = createRenderer(canvas, MAP, VEHICLES[0]);
    expect(() => renderer.setCameraMode?.(/** @type {never} */ ('drone'))).toThrow(RangeError);
    renderer.dispose();
  });
});
