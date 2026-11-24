/**
 * Street furniture as one `InstancedMesh` per prop kind. Each kind has a primitive shape built in
 * code (local +X along the prop heading, the travel direction of the nearside lanes, so local −Z
 * faces the carriageway), sized to the collider the sim gives that kind, so the layer works with
 * no model files. When the kit names a GLB for a kind, it is loaded through `loadModel` and
 * replaces the primitive once it arrives; a failed load keeps the primitive and logs the error. A
 * kit entry carries the yaw that turns the model's own axes into that local frame.
 *
 * Scenery never casts shadows; it only receives them.
 */

import { Box3, Color, InstancedMesh, Matrix4, Object3D, Vector3 } from 'three';
import { loadModel } from '../assets.js';
import { headingToYaw } from '../math.js';
import { TriangleSoup } from '../triangle-soup.js';

/** @typedef {import('../../contracts/map.js').Prop} Prop */
/** @typedef {import('three').Material} Material */
/** @typedef {import('three').Group} Group */
/** @typedef {import('three').BufferGeometry} BufferGeometry */
/** @typedef {[number, number]} Vec2 */
/** @typedef {Prop['kind'] | 'awning'} PropModelKey */

/**
 * A model for one prop kind.
 * @typedef {object} PropModel
 * @property {string} path GLB path relative to `public/`.
 * @property {number} yawOffset Yaw added to every instance, radians: turns the model's own front
 *   onto the prop's local frame (for a lamp, its arm onto local −Z).
 */

/**
 * One instance: ground position, yaw, scale and an instance tint.
 * @typedef {object} PropInstance
 * @property {number} x X.
 * @property {number} y Base height.
 * @property {number} z Z.
 * @property {number} yaw Yaw.
 * @property {[number, number, number]} scale Scale along local X, Y, Z.
 * @property {number} tint Instance colour (multiplies the vertex colours).
 */

/** Every prop kind of the map contract, in a fixed build order. */
export const PROP_KINDS = /** @type {const} */ ([
  'tree',
  'lamp',
  'power-pole',
  'cabinet',
  'bus-stop',
  'parked-motorbikes',
  'bin',
  'stall',
]);

/** Height a loaded model is scaled to, per key (design; primitives use the same sizes). */
export const PROP_HEIGHT_M = Object.freeze({
  tree: 7,
  lamp: 9,
  'power-pole': 8.5,
  cabinet: 1.4,
  'bus-stop': 2.6,
  'parked-motorbikes': 1.1,
  bin: 1,
  stall: 2.2,
  awning: 0.5,
});

/** Lamp head position on the primitive lamp, local `[x, y, z]` (the arm reaches along −Z, over the road). */
export const LAMP_HEAD = Object.freeze([0, 8.85, -1.6]);
/** Cable attachment points on a power pole, local `[x, y, z]` (crossarm across the heading). */
export const POLE_ATTACH = Object.freeze([
  [0, 7.6, -0.7],
  [0, 7.6, 0.7],
  [0, 6.1, -0.15],
  [0, 6, 0.15],
]);

/** Parked motorbike body colours (design). */
const BIKE_COLORS = Object.freeze([0xb3122e, 0x1d1d1d, 0xe6e6e6, 0x1f4fa0, 0x8a8f96]);
const ORIGIN = Object.freeze({ x: 0, z: 0 });

/**
 * Regular octagon ring around a local point.
 * @param {number} x Centre X.
 * @param {number} z Centre Z.
 * @param {number} r Radius.
 * @returns {Vec2[]} Ring.
 */
function octagon(x, z, r) {
  return Array.from({ length: 8 }, (_, i) => {
    const t = ((i + 0.5) / 8) * Math.PI * 2;
    return /** @type {Vec2} */ ([x + Math.cos(t) * r, z + Math.sin(t) * r]);
  });
}

/**
 * Primitive shape of a prop kind in its local frame, vertex-coloured.
 * @param {PropModelKey} kind Kind.
 * @returns {TriangleSoup} Shape.
 */
export function primitiveShape(kind) {
  const s = new TriangleSoup();
  /**
   * @param {number} color Colour.
   * @param {[number, number, number]} c Centre.
   * @param {[number, number, number]} size Size.
   */
  const box = (color, c, size) => {
    s.setColor(color).addBox(ORIGIN, 0, c, size);
  };
  switch (kind) {
    case 'tree':
      s.setColor(0x5b4330).addPrismBetween(octagon(0, 0, 0.18), 0, 3.4);
      s.setColor(0x3f7a2e).addPrismBetween(octagon(0, 0, 2.2), 3.2, 4.6);
      s.setColor(0x4a8a35).addPrismBetween(octagon(0.2, -0.1, 2.8), 4.6, 6);
      s.setColor(0x3c7330).addPrismBetween(octagon(-0.1, 0.1, 1.7), 6, 7);
      break;
    case 'lamp':
      s.setColor(0x7d8287).addPrismBetween(octagon(0, 0, 0.11), 0, 9);
      box(0x7d8287, [0, 8.95, LAMP_HEAD[2] / 2], [0.08, 0.08, -LAMP_HEAD[2]]);
      box(0xd9d4c3, [LAMP_HEAD[0], LAMP_HEAD[1], LAMP_HEAD[2]], [0.3, 0.15, 0.6]);
      break;
    case 'power-pole':
      box(0xb9b5ad, [0, 4.25, 0], [0.3, 8.5, 0.3]);
      box(0x6e6a63, [0, 7.6, 0], [0.12, 0.12, 1.8]);
      box(0x6e6a63, [0, 6.05, 0], [0.12, 0.1, 0.6]);
      box(0x2a2a2a, [0.25, 5.2, 0], [0.3, 0.5, 0.4]);
      break;
    case 'cabinet':
      box(0x9aa39b, [0, 0.05, 0], [0.9, 0.1, 0.6]);
      box(0x8a9a8c, [0, 0.75, 0], [0.8, 1.3, 0.5]);
      break;
    case 'bus-stop':
      // Inside the 4 × 1.2 m collider footprint except the roof's overhang.
      box(0x1f5fa8, [0, 2.5, 0], [4.2, 0.1, 1.5]);
      box(0x8a8d90, [-1.8, 1.25, -0.5], [0.08, 2.5, 0.08]);
      box(0x8a8d90, [1.8, 1.25, -0.5], [0.08, 2.5, 0.08]);
      box(0xc8d4dc, [0, 1.3, -0.56], [3.8, 1.6, 0.04]);
      box(0x5a5f64, [0, 0.45, -0.45], [3, 0.08, 0.4]);
      box(0x1f5fa8, [2.3, 1.8, 0.5], [0.04, 0.6, 0.5]);
      box(0x8a8d90, [2.3, 1, 0.5], [0.06, 2, 0.06]);
      break;
    case 'parked-motorbikes':
      for (let i = 0; i < 5; i += 1) {
        const x = -1.6 + i * 0.8;
        const color = BIKE_COLORS[i % BIKE_COLORS.length];
        box(color, [x, 0.6, -0.05], [0.3, 0.45, 1.25]);
        box(0x161616, [x, 0.88, -0.15], [0.28, 0.1, 0.6]);
        box(0x161616, [x, 0.3, -0.65], [0.1, 0.56, 0.56]);
        box(0x161616, [x, 0.3, 0.6], [0.1, 0.56, 0.56]);
        box(0x2b2b2b, [x, 1.05, 0.65], [0.62, 0.05, 0.05]);
      }
      break;
    case 'bin':
      box(0x2f7d3a, [0, 0.45, 0], [0.6, 0.9, 0.6]);
      box(0x24622d, [0, 0.95, 0], [0.64, 0.1, 0.64]);
      break;
    case 'stall':
      box(0xb8c2c8, [0, 0.5, 0], [1.8, 0.9, 1]);
      box(0x404040, [0, 1.5, 0], [0.05, 1.3, 0.05]);
      s.setColor(0xd8352a).addPrismBetween(octagon(0, 0, 1.2), 2.1, 2.2);
      break;
    case 'awning':
      // Unit width along X; projects 1.2 m along +Z and drops 0.5 m. Both faces drawn.
      for (const up of [1, -1]) {
        s.setColor(0xffffff).addQuad([-0.5, 0, 0], [0.5, 0, 0], [0.5, -0.5, 1.2], [-0.5, -0.5, 1.2], [0, up, up * 0.4]);
      }
      s.setColor(0xffffff).addQuad([-0.5, -0.5, 1.2], [0.5, -0.5, 1.2], [0.5, -0.75, 1.2], [-0.5, -0.75, 1.2], [0, 0, 1]);
      break;
    default:
      throw new RangeError(`Unknown prop kind ${String(kind)}`);
  }
  return s;
}

/**
 * Instance matrix of one placement.
 * @param {PropInstance} p Placement.
 * @param {Matrix4} out Target.
 * @returns {Matrix4} `out`.
 */
function placementMatrix(p, out) {
  const o = new Object3D();
  o.position.set(p.x, p.y, p.z);
  o.rotation.y = p.yaw;
  o.scale.set(...p.scale);
  o.updateMatrix();
  return out.copy(o.matrix);
}

/**
 * Instances of map props of one kind.
 * @param {Prop[]} props Props of that kind.
 * @param {(i: number) => number} scaleOf Uniform scale per prop index.
 * @param {(i: number) => number} tintOf Tint per prop index.
 * @returns {PropInstance[]} Instances.
 */
export function propInstances(props, scaleOf, tintOf) {
  return props.map((p, i) => {
    const k = scaleOf(i);
    return { x: p.pos.x, y: 0, z: p.pos.z, yaw: headingToYaw(p.heading), scale: [k, k, k], tint: tintOf(i) };
  });
}

/**
 * One instanced layer: a primitive mesh now, and the kit's model meshes once loaded.
 * @typedef {object} PropLayer
 * @property {import('three').Mesh[]} meshes Current meshes of the layer.
 * @property {() => void} dispose Free what the layer owns (not the shared loaded models).
 */

/**
 * Builds one instanced layer into `group`.
 * @param {Group} group Parent.
 * @param {PropModelKey} key Kind key.
 * @param {PropInstance[]} instances Placements.
 * @param {Material} material Shared vertex-coloured material of the primitives.
 * @param {PropModel | undefined} model Model of the kind, or undefined for the primitive only.
 * @returns {PropLayer} Layer.
 */
export function buildPropLayer(group, key, instances, material, model) {
  const geometry = /** @type {BufferGeometry} */ (primitiveShape(key).toGeometry());
  const mesh = new InstancedMesh(geometry, material, instances.length);
  mesh.name = `scenery-prop-${key}`;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  const m = new Matrix4();
  const color = new Color();
  instances.forEach((p, i) => {
    mesh.setMatrixAt(i, placementMatrix(p, m));
    mesh.setColorAt(i, color.setHex(p.tint));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);

  /** @type {import('three').Mesh[]} */
  const meshes = [mesh];
  let disposed = false;
  /** @type {InstancedMesh[]} */
  const loaded = [];

  if (model) {
    const modelPath = model.path;
    const turn = new Matrix4().makeRotationY(model.yawOffset);
    loadModel(modelPath)
      .then((gltf) => {
        if (disposed) return;
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(scene);
        const size = box.getSize(new Vector3());
        if (!(size.y > 0)) throw new Error(`${modelPath} has no height`);
        const k = PROP_HEIGHT_M[key] / size.y;
        const centre = box.getCenter(new Vector3());
        const fit = turn.multiply(new Matrix4().makeScale(k, k, k)).multiply(new Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));
        scene.traverse((o) => {
          const part = /** @type {import('three').Mesh} */ (o);
          if (!part.isMesh) return;
          const local = new Matrix4().multiplyMatrices(fit, part.matrixWorld);
          const inst = new InstancedMesh(part.geometry, part.material, instances.length);
          inst.name = `scenery-prop-${key}-model`;
          inst.castShadow = false;
          inst.receiveShadow = true;
          instances.forEach((p, i) => inst.setMatrixAt(i, placementMatrix(p, m).multiply(local)));
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
          loaded.push(inst);
        });
        if (loaded.length === 0) throw new Error(`${modelPath} has no mesh`);
        group.remove(mesh);
        geometry.dispose();
        meshes.length = 0;
        for (const inst of loaded) {
          group.add(inst);
          meshes.push(inst);
        }
      })
      .catch((err) => {
        console.error(`Prop model ${key}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  return {
    meshes,
    dispose() {
      disposed = true;
      geometry.dispose();
      mesh.dispose();
      for (const inst of loaded) inst.dispose();
    },
  };
}
