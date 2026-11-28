/**
 * Kenney Car Kit models prepared for instancing: the non-wheel meshes merged into one body
 * geometry with a `paint` attribute from the paint cells of the kit's colour map, one wheel
 * geometry, and the wheel pivots. Also the generated box car drawn until (or instead of) a GLB.
 */

import { Box3, BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import { KENNEY_WHEELS } from './model-config.js';
import { boxPart, CELL, FIXED, merge, PAINT_BODY } from './procedural.js';

/** @typedef {import('three/addons/loaders/GLTFLoader.js').GLTF} GLTF */

/**
 * @typedef {object} WheelPivot
 * @property {number} x Left offset.
 * @property {number} y Height of the axle.
 * @property {number} z Offset along the car.
 * @property {boolean} right Right-hand wheel (drawn as the left wheel turned half round).
 */

/**
 * @typedef {object} KenneyParts
 * @property {BufferGeometry} body Body geometry (`position`, `normal`, `uv`, `paint`).
 * @property {BufferGeometry | null} wheel Left wheel geometry around its pivot, or null when the
 *   model has none (debris).
 * @property {WheelPivot[]} pivots Wheel pivots in `KENNEY_WHEELS` order.
 * @property {Box3} box Bounds of the whole model.
 */

/**
 * Sets the `paint` attribute of a non-indexed Kenney geometry: 1 on triangles whose UV centre
 * lies in one of the paint cells (8 × 4 grid of the colour map), else 0.
 * @param {BufferGeometry} geometry Non-indexed geometry with `uv`.
 * @param {readonly (readonly number[])[]} cells Paint cells `[column, row]`.
 * @returns {BufferGeometry} The same geometry.
 */
export function paintFromUv(geometry, cells) {
  const uv = geometry.getAttribute('uv');
  if (!uv) throw new Error('Geometry has no uv');
  if (geometry.index) throw new Error('Geometry must be non-indexed');
  const n = uv.count;
  const paint = new Float32Array(n);
  for (let t = 0; t + 2 < n; t += 3) {
    const u = (uv.getX(t) + uv.getX(t + 1) + uv.getX(t + 2)) / 3;
    const v = (uv.getY(t) + uv.getY(t + 1) + uv.getY(t + 2)) / 3;
    const col = Math.floor(u * 8);
    const row = Math.floor(v * 4);
    if (cells.some((c) => c[0] === col && c[1] === row)) paint.fill(PAINT_BODY, t, t + 3);
  }
  geometry.setAttribute('paint', new BufferAttribute(paint, 1));
  return geometry;
}

/** Component getters by index, for any buffer attribute kind. */
const GETTERS = /** @type {const} */ (['getX', 'getY', 'getZ', 'getW']);

/**
 * Plain float copy of an attribute, expanded through an index when given: denormalizes quantized
 * data (`KHR_mesh_quantization`) and flattens interleaved views, so transforms cannot clamp it.
 * @param {import('three').BufferAttribute | import('three').InterleavedBufferAttribute} attr Attribute.
 * @param {import('three').BufferAttribute | null} index Index, or null for a non-indexed mesh.
 * @returns {BufferAttribute} Float attribute.
 */
function floatAttribute(attr, index) {
  const n = attr.itemSize;
  const count = index ? index.count : attr.count;
  const out = new Float32Array(count * n);
  for (let i = 0; i < count; i += 1) {
    const src = index ? index.getX(i) : i;
    for (let c = 0; c < n; c += 1) out[i * n + c] = attr[GETTERS[c]](src);
  }
  return new BufferAttribute(out, n);
}

/**
 * Copy of a mesh geometry in the model root frame, non-indexed, with only position, normal
 * and uv, all as plain floats.
 * @param {Mesh} mesh Mesh.
 * @param {import('three').Matrix4} toRoot Mesh-to-root matrix.
 * @returns {BufferGeometry} Geometry.
 */
export function rootGeometry(mesh, toRoot) {
  const src = mesh.geometry;
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const attr = src.getAttribute(name);
    if (!attr) throw new Error(`Mesh ${mesh.name} lacks ${name}`);
    out.setAttribute(name, floatAttribute(attr, src.index));
  }
  out.applyMatrix4(toRoot);
  return out;
}

/**
 * Splits a loaded Kenney model into instancing parts. The loaded scene is not changed.
 * @param {GLTF} gltf Loaded model.
 * @param {readonly (readonly number[])[]} paintCells Paint cells.
 * @returns {KenneyParts} Parts.
 */
export function kenneyParts(gltf, paintCells) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  /** @type {BufferGeometry[]} */
  const bodies = [];
  /** @type {Map<string, Mesh>} */
  const wheelMeshes = new Map();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    if (KENNEY_WHEELS.includes(o.name)) wheelMeshes.set(o.name, o);
    else bodies.push(rootGeometry(o, toRoot.clone().multiply(o.matrixWorld)));
  });
  if (bodies.length === 0) throw new Error('Model has no body mesh');
  const box = new Box3().setFromObject(root);
  /** @type {WheelPivot[]} */
  const pivots = [];
  /** @type {BufferGeometry | null} */
  let wheel = null;
  if (wheelMeshes.size === KENNEY_WHEELS.length) {
    for (const name of KENNEY_WHEELS) {
      const mesh = /** @type {Mesh} */ (wheelMeshes.get(name));
      const p = mesh.getWorldPosition(new Vector3()).applyMatrix4(toRoot);
      pivots.push({ x: p.x, y: p.y, z: p.z, right: p.x < 0 });
    }
    const left = /** @type {Mesh} */ (wheelMeshes.get('wheel-front-left'));
    // The wheel geometry around its own pivot: the node's rotation and scale, no translation.
    wheel = rootGeometry(left, toRoot.clone().multiply(left.matrixWorld).setPosition(0, 0, 0));
    paintFromUv(wheel, []);
  } else {
    // Wheels that are not all four named nodes stay part of the body.
    for (const mesh of wheelMeshes.values()) bodies.push(rootGeometry(mesh, toRoot.clone().multiply(mesh.matrixWorld)));
  }
  const body = paintFromUv(merge(bodies), paintCells);
  return { body, wheel, pivots, box };
}

/** Native size of a Kenney car body (the kit's sedan), so the box car fits like a GLB. */
const KENNEY_CAR = Object.freeze({ width: 1.5, height: 1.3, length: 2.55 });

/**
 * Generated box car in Kenney units with palette colours: painted lower body, dark cabin, four
 * unit-wheel pivots. Drawn until a GLB loads, or for good when it fails.
 * @returns {{body: BufferGeometry, pivots: WheelPivot[], box: Box3, wheelRadius: number, wheelWidth: number}} Box car.
 */
export function boxCarParts() {
  const { width: w, height: h, length: l } = KENNEY_CAR;
  const r = 0.28;
  const body = merge([
    boxPart([w, h * 0.42, l], [0, r * 0.6 + (h * 0.42) / 2, 0], CELL.white, PAINT_BODY),
    boxPart([w * 0.86, h * 0.4, l * 0.5], [0, r * 0.6 + h * 0.42 + h * 0.2, -l * 0.05], CELL.darkSlate, FIXED),
  ]);
  const x = w / 2 - 0.1;
  const z = l * 0.32;
  const pivots = [
    { x, y: r, z, right: false },
    { x: -x, y: r, z, right: true },
    { x, y: r, z: -z, right: false },
    { x: -x, y: r, z: -z, right: true },
  ];
  const box = new Box3(new Vector3(-w / 2, 0, -l / 2), new Vector3(w / 2, h, l / 2));
  return { body, pivots, box, wheelRadius: r, wheelWidth: 0.2 };
}
