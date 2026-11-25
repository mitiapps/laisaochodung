import { readFileSync, readdirSync } from 'node:fs';
import { DirectionalLight, InstancedMesh, Mesh, MeshLambertMaterial, MeshStandardMaterial, Texture } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFrames } from '../testing/index.js';
import { LOW_QUALITY_PIXEL_RATIO, buildWorld, detectRenderQuality, farFor, pixelRatioFor, softwareRenderer } from './renderer.js';
import { FAR_M, LOW_FAR_M } from './scene.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/traffic.js').TrafficParams} TrafficParams */

// Node has no fetch for the GLBs; every model load fails and each view keeps its stand-in.
vi.mock('./assets.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    /**
     * @param {string} path Path.
     * @returns {Promise<never>} Rejection.
     */
    loadModel: (path) => Promise.reject(new Error(`no model ${path}`)),
    loadTexture: () => Promise.resolve(new Texture()),
  };
});

/**
 * @param {string} rel Repo-relative path.
 * @returns {unknown} Parsed JSON.
 */
const json = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

const MAPS = readdirSync(new URL('../../public/maps/', import.meta.url))
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => /** @type {GameMap} */ (json(`public/maps/${f}`)));
const PARAMS = /** @type {TrafficParams} */ (json('src/generated/traffic-params.json'));
const VEHICLES = /** @type {VehicleInfo[]} */ (json('data/vehicles/vehicles.json'));

afterEach(() => vi.restoreAllMocks());

describe('the full scene of every shipped map', () => {
  it('has four maps to build', () => {
    expect(MAPS.map((m) => m.id).sort()).toEqual(['osm-pasteur', 'tutorial-01-co-ban', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem']);
  });

  it.each(MAPS.map((m) => [m.id, m]))('builds %s in draw order with scenery, shadows and instanced traffic', (_id, map) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const vehicle = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.legalClass === 'car'));
    const world = buildWorld(map, vehicle);
    const order = [world.road.group, world.scenery.group, world.signs.group, world.lights.group, world.markers.group, world.actors.group];
    const at = order.map((g) => world.scene.children.indexOf(g));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(world.scene.children.indexOf(world.ego.root)).toBeGreaterThan(at[at.length - 1]);

    // Buildings and furniture are there, and scenery only receives shadows.
    /** @type {Mesh[]} */
    const scenery = [];
    world.scenery.group.traverse((o) => {
      if (o instanceof Mesh) scenery.push(o);
    });
    expect(scenery.some((m) => m.name.startsWith('scenery-prop-'))).toBe(true);
    expect(scenery.length).toBeGreaterThan(3);
    expect(scenery.every((m) => !m.castShadow)).toBe(true);
    const sun = world.scene.children.find((o) => o instanceof DirectionalLight);
    expect(sun?.castShadow).toBe(true);

    // Traffic moves through instanced meshes, one per model, not one mesh per agent.
    const frames = map.traffic
      ? buildFrames({ map, vehicle, path: [[map.route.start.pos.x, map.route.start.pos.z], [map.route.start.pos.x + 1, map.route.start.pos.z]], speed: 0, durationS: 3, traffic: { params: PARAMS, runSeed: 7 } })
      : [];
    if (frames.length > 1) {
      const last = frames[frames.length - 1];
      world.actors.update(frames[frames.length - 2], last, 1, true);
      /** @type {InstancedMesh[]} */
      const instanced = [];
      world.actors.group.traverse((o) => {
        if (o instanceof InstancedMesh && o.count > 0) instanced.push(o);
      });
      const agents = last.actors.length - map.actors.length;
      expect(agents).toBeGreaterThan(0);
      expect(instanced.length).toBeGreaterThan(0);
      // Busy maps share meshes between agents of one model.
      if (agents > 10) expect(instanced.length).toBeLessThan(agents);
    }
    world.dispose();
  });
});

describe('software rasteriser detection', () => {
  /**
   * A WebGL context stand-in that reports `name` as its unmasked renderer.
   * @param {string | null} name Renderer name, or null without the debug extension.
   * @param {() => void} [lose] Called when the context is released.
   * @returns {WebGLRenderingContext} Stand-in.
   */
  const ctxNamed = (name, lose = () => {}) =>
    /** @type {WebGLRenderingContext} */ (
      /** @type {unknown} */ ({
        getExtension: (/** @type {string} */ ext) => {
          if (ext === 'WEBGL_lose_context') return { loseContext: lose };
          return name === null ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
        },
        getParameter: () => name,
      })
    );

  /**
   * A document stand-in whose canvases return `ctx` for WebGL, or nothing.
   * @param {WebGLRenderingContext | null} ctx Context.
   * @returns {Document} Stand-in.
   */
  const docWith = (ctx) =>
    /** @type {Document} */ (/** @type {unknown} */ ({ createElement: () => ({ getContext: () => ctx }) }));

  it('treats SwiftShader and llvmpipe as software and a GPU or an unknown name as hardware', () => {
    expect(softwareRenderer(ctxNamed('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'))).toBe(true);
    expect(softwareRenderer(ctxNamed('llvmpipe (LLVM 19.1.1, 256 bits)'))).toBe(true);
    expect(softwareRenderer(ctxNamed('ANGLE (AMD, AMD Radeon 780M (radeonsi, gfx1103), OpenGL 4.6)'))).toBe(false);
    expect(softwareRenderer(ctxNamed(null))).toBe(false);
  });

  it('picks the quality from a probe context and releases it', () => {
    const lose = vi.fn();
    expect(detectRenderQuality(docWith(ctxNamed('llvmpipe (LLVM 19.1.1, 256 bits)', lose)))).toBe('low');
    expect(lose).toHaveBeenCalledTimes(1);
    const loseGpu = vi.fn();
    expect(detectRenderQuality(docWith(ctxNamed('ANGLE (AMD, AMD Radeon 780M (radeonsi, gfx1103), OpenGL 4.6)', loseGpu)))).toBe('high');
    expect(loseGpu).toHaveBeenCalledTimes(1);
    expect(detectRenderQuality(docWith(null))).toBe('high');
  });
});

describe('render quality', () => {
  const map = /** @type {GameMap} */ (MAPS.find((m) => m.id === 'tutorial-01-co-ban'));
  const vehicle = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.legalClass === 'motorbike'));

  /**
   * The materials of every scenery mesh.
   * @param {ReturnType<typeof buildWorld>} world World.
   * @returns {import('three').Material[]} Materials.
   */
  const sceneryMaterials = (world) => {
    /** @type {import('three').Material[]} */
    const out = [];
    world.scenery.group.traverse((o) => {
      if (o instanceof Mesh) out.push(...(Array.isArray(o.material) ? o.material : [o.material]));
    });
    return out;
  };

  it('keeps the hardware path: standard scenery materials and the device pixel ratio up to 2', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const world of [buildWorld(map, vehicle), buildWorld(map, vehicle, { quality: 'high' })]) {
      const materials = sceneryMaterials(world);
      expect(materials.length).toBeGreaterThan(3);
      expect(materials.every((m) => m instanceof MeshStandardMaterial)).toBe(true);
      world.dispose();
    }
    expect(pixelRatioFor('high', 1)).toBe(1);
    expect(pixelRatioFor('high', 1.5)).toBe(1.5);
    expect(pixelRatioFor('high', 3)).toBe(2);
    expect(pixelRatioFor('high', undefined)).toBe(1);
    expect(farFor('high')).toBe(FAR_M);
  });

  it('draws the scenery with Lambert materials and a reduced pixel ratio on the low-cost path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const world = buildWorld(map, vehicle, { quality: 'low' });
    const materials = sceneryMaterials(world);
    expect(materials.length).toBeGreaterThan(3);
    expect(materials.every((m) => m instanceof MeshLambertMaterial)).toBe(true);
    // The night glow still reaches the lit windows and sign boards.
    const night = materials.filter((m) => typeof m.userData.nightEmissive === 'number');
    expect(night.length).toBeGreaterThan(0);
    expect(night.every((m) => 'emissiveIntensity' in m)).toBe(true);
    world.dispose();
    expect(pixelRatioFor('low', 2)).toBe(LOW_QUALITY_PIXEL_RATIO);
    expect(LOW_QUALITY_PIXEL_RATIO).toBeGreaterThan(0);
    expect(LOW_QUALITY_PIXEL_RATIO).toBeLessThan(1);
    expect(farFor('low')).toBe(LOW_FAR_M);
    expect(LOW_FAR_M).toBeLessThan(FAR_M);
  });
});
