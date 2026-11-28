/**
 * Textured vehicle bodies generated with Tripo AI (`public/models/tripo/`), prepared for the
 * Kenney frame: front towards +Z, left towards +X, ground at y = 0, centred on X/Z.
 *
 * Each model is one textured mesh with its wheels baked in, so the wheels do not spin. The body
 * keeps its own colours: its `paint` attribute is all `FIXED`, so the look shader leaves it alone.
 * The procedural model of the same key stays the stand-in until the GLB loads, and for good when
 * it fails.
 */

import { BufferAttribute, Mesh } from 'three';
import { BUS_SIZE } from './bus.js';
import { rootGeometry } from './kenney.js';
import { MOTORBIKE_LENGTH_M } from './motorbike.js';
import { FIXED, merge } from './procedural.js';

/** @typedef {import('three/addons/loaders/GLTFLoader.js').GLTF} GLTF */

/**
 * @typedef {object} TripoModel
 * @property {string} glb GLB path relative to `public/`.
 * @property {number} yaw Turn about +Y (radians) that brings the model's front to +Z; measured
 *   once per file.
 * @property {number} lengthM Length along Z after fitting, in Kenney metres.
 * @property {number} [widthM] Width along X after fitting. When set, X and Z scale apart and the
 *   height takes their geometric mean (as `fitToFootprint`); when absent, the scale is uniform.
 * @property {[number, number]} [seat] Rider hip point `[z, y]` on this body, when it differs from
 *   the procedural model's.
 * @property {[number, number]} [pillion] Passenger hip point `[z, y]` on this body.
 */

/**
 * @typedef {object} TripoParts
 * @property {import('three').BufferGeometry} body Fitted body geometry (`position`, `normal`,
 *   `uv`, `paint`), non-indexed.
 * @property {import('three').Box3} box Bounds of the fitted body.
 * @property {import('three').Texture | null} map The model's base colour texture.
 */

/**
 * Tripo bodies by key: motorbike types and `bus`. Yaws measured from the files: the handlebar
 * and leg shield of both bikes stand towards +Z. The bus front was not confirmed.
 * @type {Readonly<Record<string, TripoModel>>}
 */
export const TRIPO_MODELS = Object.freeze({
  scooter: { glb: 'models/tripo/scooter.glb', yaw: 0, lengthM: MOTORBIKE_LENGTH_M, seat: [-0.32, 0.87], pillion: [-0.66, 0.88] },
  underbone: { glb: 'models/tripo/underbone.glb', yaw: 0, lengthM: MOTORBIKE_LENGTH_M, seat: [-0.28, 0.86], pillion: [-0.66, 0.86] },
  bus: { glb: 'models/tripo/bus.glb', yaw: 0, lengthM: BUS_SIZE.lengthM, widthM: BUS_SIZE.widthM },
});

/**
 * Merges every mesh of a loaded Tripo model into one geometry in the model root frame, turns it
 * by `spec.yaw`, and fits it: length `spec.lengthM` on Z (and width `spec.widthM` on X when set),
 * centred on X/Z and standing on y = 0. The loaded scene is not changed.
 * @param {GLTF} gltf Loaded model.
 * @param {TripoModel} spec Model spec.
 * @returns {TripoParts} Parts.
 */
export function tripoParts(gltf, spec) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  /** @type {import('three').BufferGeometry[]} */
  const parts = [];
  /** @type {import('three').Texture | null} */
  let map = null;
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    parts.push(rootGeometry(o, toRoot.clone().multiply(o.matrixWorld)));
    const material = Array.isArray(o.material) ? o.material[0] : o.material;
    map ??= /** @type {import('three').MeshStandardMaterial} */ (material).map ?? null;
  });
  if (parts.length === 0) throw new Error(`${spec.glb} has no mesh`);
  const body = parts.length === 1 ? parts[0] : merge(parts);
  if (spec.yaw !== 0) body.rotateY(spec.yaw);
  body.computeBoundingBox();
  const raw = /** @type {import('three').Box3} */ (body.boundingBox);
  const sizeX = raw.max.x - raw.min.x;
  const sizeZ = raw.max.z - raw.min.z;
  if (!(sizeX > 0 && sizeZ > 0)) throw new Error(`${spec.glb} has an empty bounding box`);
  const sz = spec.lengthM / sizeZ;
  const sx = spec.widthM ? spec.widthM / sizeX : sz;
  const sy = spec.widthM ? Math.sqrt(sx * sz) : sz;
  body.translate(-(raw.min.x + raw.max.x) / 2, -raw.min.y, -(raw.min.z + raw.max.z) / 2);
  body.scale(sx, sy, sz);
  body.setAttribute('paint', new BufferAttribute(new Float32Array(body.getAttribute('position').count).fill(FIXED), 1));
  body.computeBoundingBox();
  return { body, box: /** @type {import('three').Box3} */ (body.boundingBox).clone(), map };
}
