import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Frustum, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3 } from 'three';
import map from '../../../tests/fixtures/map-minimal.json' with { type: 'json' };
import { polygonSignedArea } from '../../geometry/index.js';
import { FAR_M, chaseTarget } from '../scene.js';
import { cablePoints, cableSpans } from './cables.js';
import { CHUNK_M, chunkKey } from './chunks.js';
import { buildScenery } from './index.js';
import { layoutBuilding } from './lots.js';
import { PROP_KINDS } from './props.js';
import { atlasCellUv } from './sign-atlas.js';
import { SHOP_NAMES } from './shop-names.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/map.js').Prop} Prop */
/** @typedef {import('three').Object3D} Object3D */

const loader = vi.hoisted(() => ({
  /** @type {((path: string) => Promise<unknown>) | null} */
  impl: null,
}));

vi.mock('../assets.js', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    /**
     * @param {string} path Path.
     * @returns {Promise<unknown>} Model.
     */
    loadModel: (path) => (loader.impl ? loader.impl(path) : Promise.reject(new Error(`no model ${path}`))),
  };
});

const fixture = /** @type {GameMap} */ (/** @type {unknown} */ (map));
const MAPS_DIR = new URL('../../../public/maps/', import.meta.url);

/** @returns {GameMap[]} Every shipped map. */
function shippedMaps() {
  return readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => /** @type {GameMap} */ (JSON.parse(readFileSync(new URL(f, MAPS_DIR), 'utf8'))));
}

/**
 * A map with every building use and every prop kind, beside the fixture roads.
 * @param {'tutorial' | 'osm'} kind Map kind.
 * @param {number} [clockMin] Start clock.
 * @returns {GameMap} Map.
 */
function richMap(kind, clockMin = 600) {
  /** @type {Prop[]} */
  const props = PROP_KINDS.map((k, i) => ({ id: `p-${k}`, kind: k, pos: { x: 10 + i * 8, z: -6 }, heading: 0, solid: true }));
  for (let i = 0; i < 4; i += 1) props.push({ id: `pole-${i}`, kind: 'power-pole', pos: { x: 110 + i * 35, z: 6 }, heading: 0, solid: true });
  props.push({ id: 'lamp-2', kind: 'lamp', pos: { x: 150, z: -6 }, heading: Math.PI / 2, solid: true });
  return {
    ...fixture,
    id: `rich-${kind}`,
    kind,
    environment: { ...fixture.environment, startClockMin: clockMin },
    obstacles: [
      ...fixture.obstacles,
      { id: 'b-row', kind: 'building', footprint: [[110, 8], [190, 8], [190, 20], [110, 20]], height: 12 },
      { id: 'b-civic', kind: 'building', use: 'civic', floors: 3, footprint: [[10, -40], [60, -40], [60, -20], [10, -20]], height: 13.5, frontEdge: 2 },
      { id: 'b-compound', kind: 'building', use: 'compound', footprint: [[110, -60], [150, -60], [150, -30], [110, -30]], height: 9 },
      { id: 'b-landmark', kind: 'building', use: 'landmark', floors: 2, footprint: [[160, -60], [185, -55], [190, -30], [170, -22], [158, -35]], height: 12 },
      { id: 'b-tower', kind: 'building', use: 'tower', floors: 18, footprint: [[10, 30], [40, 30], [40, 55], [10, 55]], height: 70 },
    ],
    props,
  };
}

/**
 * Every object under a root.
 * @param {Object3D} root Root.
 * @returns {Object3D[]} Objects.
 */
function all(root) {
  /** @type {Object3D[]} */
  const out = [];
  root.traverse((o) => out.push(o));
  return out;
}

/**
 * Renderable objects (meshes, lines and points) under a root.
 * @param {Object3D} root Root.
 * @returns {(Mesh | import('three').Points | import('three').LineSegments)[]} Drawables.
 */
function drawables(root) {
  return /** @type {(Mesh | import('three').Points | import('three').LineSegments)[]} */ (
    all(root).filter((o) => 'geometry' in o && 'material' in o)
  );
}

afterEach(() => {
  loader.impl = null;
  vi.restoreAllMocks();
});

describe('scenery build', () => {
  const maps = [...shippedMaps(), richMap('tutorial'), richMap('osm'), richMap('tutorial', 1350)];

  it('finds the shipped maps', () => {
    expect(shippedMaps().length).toBeGreaterThanOrEqual(4);
  });

  it.each(maps.map((m) => [m.id, m]))('builds %s within the shadow, material and chunk budgets', (_id, m) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const scenery = buildScenery(/** @type {GameMap} */ (m));
    const objects = all(scenery.group);
    for (const o of objects) expect(o.castShadow, o.name).toBe(false);

    const meshes = drawables(scenery.group);
    const materials = new Set(meshes.map((d) => d.material));
    expect(materials.size).toBeLessThanOrEqual(8);

    /** @type {Map<string, Set<unknown>>} */
    const perChunk = new Map();
    for (const d of meshes) {
      const key = d.userData.chunk;
      if (key === undefined) continue;
      const set = perChunk.get(key) ?? new Set();
      set.add(d.material);
      perChunk.set(key, set);
    }
    for (const [key, set] of perChunk) {
      expect(set.size, key).toBeLessThanOrEqual(6);
      expect(meshes.filter((d) => d.userData.chunk === key).length, key).toBeLessThanOrEqual(6);
    }

    for (const d of meshes) {
      const values = [...d.geometry.getAttribute('position').array];
      if (d instanceof InstancedMesh) values.push(...d.instanceMatrix.array);
      expect(values.filter((v) => !Number.isFinite(v)), d.name).toEqual([]);
    }

    const geometries = new Set(meshes.map((d) => d.geometry));
    const freed = new Set();
    for (const g of geometries) g.addEventListener('dispose', () => freed.add(g));
    scenery.dispose();
    expect(freed.size).toBe(geometries.size);
  });

  it('keeps the scenery draw calls in view within 40 on osm-pasteur', () => {
    const osm = shippedMaps().find((m) => m.id === 'osm-pasteur');
    if (!osm) throw new Error('no osm-pasteur');
    const scenery = buildScenery(osm);
    scenery.group.updateMatrixWorld(true);
    const objects = drawables(scenery.group);
    let worst = 0;
    // The chase camera at the start and every checkpoint, looking four ways.
    for (const p of [osm.route.start, ...osm.route.checkpoints]) {
      for (const turn of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const t = chaseTarget({ x: p.pos.x, y: 0, z: p.pos.z, heading: p.heading + turn }, 'motorbike');
        const camera = new PerspectiveCamera(60, 16 / 9, 0.1, FAR_M);
        camera.position.set(...t.eye);
        camera.lookAt(...t.look);
        camera.updateMatrixWorld(true);
        const frustum = new Frustum().setFromProjectionMatrix(
          new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
        worst = Math.max(worst, objects.filter((o) => o.visible && frustum.intersectsObject(o)).length);
      }
    }
    expect(worst).toBeLessThanOrEqual(40);
    scenery.dispose();
  });

  it('gives every footprint area of every shipped tube-house row to a lot', () => {
    for (const m of shippedMaps()) {
      m.obstacles
        .filter((o) => o.kind === 'building')
        .forEach((b, i) => {
          const layout = layoutBuilding(m, b, i);
          if (layout.use !== 'shophouse') return;
          const total = layout.lots.reduce((sum, l) => sum + Math.abs(polygonSignedArea(l.polygon)), 0);
          expect(total, `${m.id} ${b.id}`).toBeCloseTo(Math.abs(polygonSignedArea(b.footprint)), 3);
        });
    }
  });

  it('chunks buildings into square blocks, one mesh per material each', () => {
    const scenery = buildScenery(richMap('osm'));
    const chunkMeshes = drawables(scenery.group).filter((d) => d.userData.chunk !== undefined);
    const chunks = new Set(chunkMeshes.map((d) => d.userData.chunk));
    expect(chunks.size).toBeGreaterThan(1);
    for (const d of chunkMeshes) {
      // Every vertex of a chunk mesh sits near its chunk (a lot or building may overhang it).
      d.geometry.computeBoundingBox();
      const box = d.geometry.boundingBox;
      if (!box) throw new Error('no box');
      const [i, j] = String(d.userData.chunk).split(',').map(Number);
      const c = box.getCenter(new Vector3());
      expect(c.x).toBeGreaterThan(i * CHUNK_M - CHUNK_M);
      expect(c.x).toBeLessThan((i + 2) * CHUNK_M);
      expect(c.z).toBeGreaterThan(j * CHUNK_M - CHUNK_M);
      expect(c.z).toBeLessThan((j + 2) * CHUNK_M);
    }
    expect(chunkKey(-0.5, 99.9)).toBe('-1,0');
    scenery.dispose();
  });

  it('draws one instanced layer per prop kind and awnings, with cables only on tutorials', () => {
    const tutorial = buildScenery(richMap('tutorial'));
    const names = drawables(tutorial.group).map((d) => d.name);
    for (const kind of PROP_KINDS) expect(names).toContain(`scenery-prop-${kind}`);
    expect(names).toContain('scenery-prop-awning');
    expect(names).toContain('scenery-cables');
    const osm = buildScenery(richMap('osm'));
    expect(drawables(osm.group).map((d) => d.name)).not.toContain('scenery-cables');
    tutorial.dispose();
    osm.dispose();
  });

  it('points building walls outwards', () => {
    const scenery = buildScenery(fixture);
    const facade = drawables(scenery.group).find((d) => d.name.startsWith('scenery-facade@'));
    if (!facade) throw new Error('no facade mesh');
    const pos = facade.geometry.getAttribute('position');
    const nrm = facade.geometry.getAttribute('normal');
    // Fixture building footprint 10..60 × 8..20.
    const centre = new Vector3(35, 6, 14);
    let walls = 0;
    for (let i = 0; i < pos.count; i += 3) {
      // Triangle centroid: party walls between lots touch the footprint only at their ends.
      const p = new Vector3();
      for (let k = 0; k < 3; k += 1) p.add(new Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
      p.divideScalar(3);
      const n = new Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      // Walls only: the hidden backs of small facade boxes also touch the facade plane.
      const ys = [0, 1, 2].map((k) => pos.getY(i + k));
      if (Math.abs(n.y) > 0.5 || Math.max(...ys) - Math.min(...ys) < 1.5) continue;
      const onFootprint = Math.abs(p.x - 10) < 1e-6 || Math.abs(p.x - 60) < 1e-6 || Math.abs(p.z - 8) < 1e-6 || Math.abs(p.z - 20) < 1e-6;
      if (!onFootprint) continue;
      walls += 1;
      expect(p.clone().sub(centre).dot(n)).toBeGreaterThan(0);
    }
    expect(walls).toBeGreaterThan(0);
    scenery.dispose();
  });

  it('lights windows and lamps at night only', () => {
    const day = buildScenery(richMap('tutorial', 600));
    const night = buildScenery(richMap('tutorial', 1350));
    /**
     * @param {{group: Group}} s Scenery.
     * @returns {{glow: boolean, emissive: number}} Night look.
     */
    const look = (s) => {
      const glow = drawables(s.group).find((d) => d.name === 'scenery-lamp-glow');
      const lit = drawables(s.group).find((d) => d.name.startsWith('scenery-glass-lit@'));
      const mat = /** @type {MeshStandardMaterial} */ (lit?.material);
      return { glow: Boolean(glow?.visible), emissive: mat.emissiveIntensity };
    };
    expect(look(day)).toEqual({ glow: false, emissive: 0 });
    expect(look(night)).toEqual({ glow: true, emissive: 1 });
    day.dispose();
    night.dispose();
  });

  it('keeps the same look for the same map', () => {
    /**
     * @param {GameMap} m Map.
     * @returns {number[]} Positions of every chunk mesh.
     */
    const snapshot = (m) => {
      const s = buildScenery(m);
      const out = drawables(s.group).flatMap((d) => [...d.geometry.getAttribute('position').array]);
      s.dispose();
      return out;
    };
    expect(snapshot(richMap('osm'))).toEqual(snapshot(richMap('osm')));
  });
});

describe('prop models', () => {
  it('keeps the primitive when a model fails to load', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scenery = buildScenery(richMap('osm'), { propModels: { tree: 'models/missing.glb' } });
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(scenery.group.getObjectByName('scenery-prop-tree')).toBeDefined();
    scenery.dispose();
  });

  it('swaps a loaded model in for the primitive, scaled to the prop height', async () => {
    const model = new Group();
    model.add(new Mesh(new BoxGeometry(2, 14, 2), new MeshStandardMaterial()));
    loader.impl = async () => ({ scene: model });
    const scenery = buildScenery(richMap('osm'), { propModels: { tree: 'models/tree.glb' } });
    await vi.waitFor(() => expect(scenery.group.getObjectByName('scenery-prop-tree-model')).toBeDefined());
    expect(scenery.group.getObjectByName('scenery-prop-tree')).toBeUndefined();
    const inst = /** @type {InstancedMesh} */ (scenery.group.getObjectByName('scenery-prop-tree-model'));
    expect(inst.castShadow).toBe(false);
    inst.computeBoundingBox();
    const box = inst.boundingBox;
    if (!box) throw new Error('no box');
    // A 14 m box fitted to the 7 m tree height, standing on the ground, at most 1.25× scaled.
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeGreaterThan(7 * 0.8 - 1e-6);
    expect(box.max.y).toBeLessThan(7 * 1.25 + 1e-6);
    scenery.dispose();
  });

  it('ignores a model that arrives after disposal', async () => {
    /** @type {(v: unknown) => void} */
    let resolve = () => {};
    loader.impl = () => new Promise((r) => (resolve = r));
    const scenery = buildScenery(richMap('osm'), { propModels: { lamp: 'models/lamp.glb' } });
    scenery.dispose();
    const model = new Group();
    model.add(new Mesh(new BoxGeometry(1, 9, 1)));
    resolve({ scene: model });
    await new Promise((r) => setTimeout(r, 0));
    expect(scenery.group.getObjectByName('scenery-prop-lamp-model')).toBeUndefined();
  });
});

describe('cables and sign atlas', () => {
  it('links poles along the shortest spans and skips gaps over 50 m', () => {
    const poles = [
      { x: 0, z: 0 },
      { x: 35, z: 0 },
      { x: 70, z: 0 },
      { x: 200, z: 0 },
    ];
    expect(cableSpans(poles)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('sags a cable by the given drop at mid-span', () => {
    const pts = cablePoints([0, 8, 0], [30, 8, 0], 1, 12);
    expect(pts).toHaveLength(13);
    expect(pts[6][1]).toBeCloseTo(7, 9);
    expect(pts[0]).toEqual([0, 8, 0]);
    expect(pts[12]).toEqual([30, 8, 0]);
  });

  it('gives every shop name its own atlas cell inside the texture', () => {
    const cells = SHOP_NAMES.map((_, i) => atlasCellUv(i));
    for (const [u0, v0, u1, v1] of cells) {
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(u1).toBeLessThanOrEqual(1);
      expect(v1).toBeLessThanOrEqual(1);
      expect(u1).toBeGreaterThan(u0);
      expect(v1).toBeGreaterThan(v0);
    }
    expect(new Set(cells.map((c) => c.join())).size).toBe(cells.length);
    expect(() => atlasCellUv(SHOP_NAMES.length)).toThrow(RangeError);
  });
});
