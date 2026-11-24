/**
 * Bakes Kenney Mini Characters (CC0, skinned, two skins per GLB) into static geometry: the
 * character is posed by sampling one clip at one time, and the skinned vertices are transformed
 * on the CPU, so riders can be merged with their motorbike and drawn instanced.
 *
 * Output geometry is non-indexed, in the Kenney frame (facing +Z), scaled to metres, standing on
 * y = 0, with the `position`, `normal`, `uv` and `paint` attributes of the procedural parts
 * (`vehicles/procedural.js`); the character's own texels are `paint` 0.
 */

import { AnimationMixer, Box3, BufferAttribute, BufferGeometry, Matrix3, Matrix4, SkinnedMesh, Vector3 } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CELL, domePart, merge, PAINT_ACCENT } from './vehicles/procedural.js';

/** @typedef {import('three/addons/loaders/GLTFLoader.js').GLTF} GLTF */

/** Standing height of a baked adult, metres (a drawing choice; Vietnamese adult average). */
export const CHARACTER_HEIGHT_M = 1.62;

/**
 * Per-joint scale in the bind frame of each joint (x across, y up, z forward; the arms point
 * along x in the bind pose). Mini Characters have toy proportions: the head is about half the
 * height and the legs a quarter. Shrinking the head and lengthening the legs, torso and arms
 * gives an adult silhouette at street distances (drawing choices).
 * @type {Readonly<Record<string, readonly [number, number, number]>>}
 */
export const PROPORTIONS = Object.freeze({
  head: [0.42, 0.42, 0.42],
  torso: [0.72, 1.45, 0.75],
  'arm-left': [1.35, 0.62, 0.62],
  'arm-right': [1.35, 0.62, 0.62],
  'leg-left': [0.72, 1.9, 0.72],
  'leg-right': [0.72, 1.9, 0.72],
});

/**
 * Proportions of skinned (animated) figures. A joint that rotates inside a non-uniformly scaled
 * parent shears, so the torso, the parent of the arms and head, keeps a uniform scale here; the
 * legs and head still carry most of the change.
 * @type {Readonly<Record<string, readonly [number, number, number]>>}
 */
export const SKINNED_PROPORTIONS = Object.freeze({
  head: [0.5, 0.5, 0.5],
  torso: [1, 1, 1],
  'arm-left': [1.25, 0.8, 0.8],
  'arm-right': [1.25, 0.8, 0.8],
  'leg-left': [0.8, 1.8, 0.8],
  'leg-right': [0.8, 1.8, 0.8],
});

/** @typedef {Readonly<Record<string, readonly [number, number, number]>>} Proportions */

/**
 * @typedef {object} BakedPose
 * @property {BufferGeometry} geometry Posed geometry in metres.
 * @property {Vector3} hip Midpoint of the two leg joints, metres.
 * @property {Box3} head Bounds of the posed head mesh, metres.
 */

/**
 * Poses a character with adult proportions and returns its static geometry in metres.
 * @param {GLTF} gltf Loaded character (never changed; a skeleton-aware clone is posed).
 * @param {string} clipName Clip to sample (`drive`, `sit`, `die`, …).
 * @param {number | 'end'} time Sample time in seconds, or the last frame.
 * @param {number} [legPitch] Leg angle from straight down, radians, positive forward; the clip's
 *   own leg angle when omitted. The legs have no knee, so a seated rider's straight legs are
 *   tilted to reach the floorboard or footpegs instead of the clip's car-seat angle.
 * @returns {BakedPose} Baked pose.
 */
export function bakePose(gltf, clipName, time, legPitch) {
  const { scale, lift } = characterFit(gltf, PROPORTIONS);
  const posed = poseCharacter(gltf, clipName, time, PROPORTIONS, legPitch);
  posed.geometry.translate(0, lift, 0).scale(scale, scale, scale);
  posed.hip.y += lift;
  posed.hip.multiplyScalar(scale);
  posed.head.translate(new Vector3(0, lift, 0));
  posed.head.min.multiplyScalar(scale);
  posed.head.max.multiplyScalar(scale);
  return posed;
}

/**
 * How a character with the given proportions is fitted to `CHARACTER_HEIGHT_M`: lift it by `lift`
 * native units (longer legs reach below the root), then scale it by `scale`.
 * @param {GLTF} gltf Character.
 * @param {Proportions} proportions Joint scales.
 * @returns {{scale: number, lift: number}} Fit.
 */
export function characterFit(gltf, proportions) {
  const standing = poseCharacter(gltf, 'static', 0, proportions);
  standing.geometry.computeBoundingBox();
  const box = /** @type {Box3} */ (standing.geometry.boundingBox);
  standing.geometry.dispose();
  const height = box.max.y - box.min.y;
  if (!(height > 0)) throw new Error('Character has an empty bounding box');
  return { scale: CHARACTER_HEIGHT_M / height, lift: -box.min.y };
}

/**
 * Gives a skinned clone (from `SkeletonUtils.clone`) the `SKINNED_PROPORTIONS`, as joint scales
 * relative to the parent joint, so it animates with adult proportions. Call again after each
 * animation update in case a clip writes joint scales.
 * @param {import('three').Object3D} figure Clone.
 */
export function applyProportions(figure) {
  figure.traverse((o) => {
    const own = SKINNED_PROPORTIONS[o.name];
    if (!own || !(/** @type {import('three').Bone} */ (o).isBone)) return;
    const parent = (o.parent && SKINNED_PROPORTIONS[o.parent.name]) || [1, 1, 1];
    o.scale.set(own[0] / parent[0], own[1] / parent[1], own[2] / parent[2]);
  });
}

/**
 * Poses a character in its native units, with proportions applied: each joint's offset from its
 * parent is scaled by the parent's factors, and each vertex by its joint's factors about the joint
 * (linear blend skinning done here, so the factors can sit between bind and pose).
 * @param {GLTF} gltf Character.
 * @param {string} clipName Clip.
 * @param {number | 'end'} time Sample time.
 * @param {Proportions} proportions Joint scales.
 * @param {number} [legPitch] Leg angle override, as for `bakePose`.
 * @returns {BakedPose} Pose in native units.
 */
function poseCharacter(gltf, clipName, time, proportions, legPitch) {
  const clip = gltf.animations.find((a) => a.name === clipName);
  if (!clip) throw new Error(`Character has no "${clipName}" clip`);
  const scene = cloneSkinned(gltf.scene);
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(clip).play();
  mixer.setTime(time === 'end' ? Math.max(0, clip.duration - 1e-4) : time);
  if (legPitch !== undefined) {
    for (const name of ['leg-left', 'leg-right']) scene.getObjectByName(name)?.rotation.set(-legPitch, 0, 0);
  }
  // Move every joint by its parent's proportions (after the clip set the local positions).
  scene.traverse((o) => {
    const parentScale = o.parent ? proportions[o.parent.name] : undefined;
    if (parentScale && /** @type {import('three').Bone} */ (o).isBone) o.position.multiply(new Vector3(...parentScale));
  });
  scene.updateMatrixWorld(true);

  /** @type {SkinnedMesh[]} */
  const skinned = [];
  scene.traverse((o) => {
    if (o instanceof SkinnedMesh) skinned.push(o);
  });
  if (skinned.length === 0) throw new Error('Character has no skinned mesh');

  /** @type {BufferGeometry[]} */
  const parts = [];
  const head = new Box3();
  const v = new Vector3();
  const nrm = new Vector3();
  const m = new Matrix4();
  const sum = new Matrix4();
  const normalMatrix = new Matrix3();
  for (const mesh of skinned) {
    const isHead = mesh.name.includes('head');
    const { bones, boneInverses } = mesh.skeleton;
    // Per joint: posed world × proportion scale × bind inverse.
    const jointMatrices = bones.map((bone, i) => {
      const k = proportions[bone.name] ?? [1, 1, 1];
      return new Matrix4().multiplyMatrices(bone.matrixWorld, new Matrix4().makeScale(k[0], k[1], k[2])).multiply(boneInverses[i]);
    });
    const toMesh = new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    const nor = src.getAttribute('normal');
    const uv = src.getAttribute('uv');
    const skinIndex = src.getAttribute('skinIndex');
    const skinWeight = src.getAttribute('skinWeight');
    if (!pos || !nor || !uv || !skinIndex || !skinWeight) {
      throw new Error(`Skinned mesh ${mesh.name} lacks position, normal, uv or skin attributes`);
    }
    // Pose every source vertex once; the index then expands them into triangles.
    const count = pos.count;
    const posed = new Float32Array(count * 3);
    const posedNormal = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      sum.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let j = 0; j < 4; j += 1) {
        const w = skinWeight.getComponent(i, j);
        if (w === 0) continue;
        const e = jointMatrices[skinIndex.getComponent(i, j)].elements;
        for (let c = 0; c < 16; c += 1) sum.elements[c] += e[c] * w;
      }
      m.multiplyMatrices(toMesh, sum).multiply(mesh.bindMatrix);
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      nrm.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix.getNormalMatrix(m)).normalize();
      if (isHead) head.expandByPoint(v);
      posed.set([v.x, v.y, v.z], i * 3);
      posedNormal.set([nrm.x, nrm.y, nrm.z], i * 3);
    }
    const order = src.index ? Array.from(src.index.array) : [...Array(count).keys()];
    const n = order.length;
    const outPos = new Float32Array(n * 3);
    const outNor = new Float32Array(n * 3);
    const outUv = new Float32Array(n * 2);
    for (let k = 0; k < n; k += 1) {
      const i = order[k];
      outPos.set(posed.subarray(i * 3, i * 3 + 3), k * 3);
      outNor.set(posedNormal.subarray(i * 3, i * 3 + 3), k * 3);
      outUv[k * 2] = uv.getX(i);
      outUv[k * 2 + 1] = uv.getY(i);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(outPos, 3));
    g.setAttribute('normal', new BufferAttribute(outNor, 3));
    g.setAttribute('uv', new BufferAttribute(outUv, 2));
    g.setAttribute('paint', new BufferAttribute(new Float32Array(n), 1));
    parts.push(g);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);

  const hip = new Vector3();
  for (const name of ['leg-left', 'leg-right']) {
    const leg = scene.getObjectByName(name);
    if (!leg) throw new Error('Character lacks the leg-left and leg-right joints');
    hip.add(leg.getWorldPosition(new Vector3()));
  }
  hip.multiplyScalar(0.5);
  return { geometry: merge(parts), hip, head };
}

/**
 * A rider or passenger: the posed character with a helmet (second paint), moved so its hip
 * joint sits on `seat`.
 * @param {GLTF} gltf Character.
 * @param {string} clipName Pose clip (`drive` for a rider, `sit` for a passenger).
 * @param {[number, number]} seat Hip point `[z, y]` in the Kenney frame.
 * @param {number} legPitch Leg angle from straight down, radians, positive forward.
 * @returns {BufferGeometry} Geometry.
 */
export function bakeRider(gltf, clipName, seat, legPitch) {
  const baked = bakePose(gltf, clipName, 0, legPitch);
  const helmet = helmetFor(baked.head);
  const g = merge([baked.geometry, helmet]);
  g.translate(-baked.hip.x, seat[1] - baked.hip.y, seat[0] - baked.hip.z);
  return g;
}

/**
 * A rider lying where a motorbike fell: the last frame of the `die` clip, on the ground.
 * @param {GLTF} gltf Character.
 * @returns {BufferGeometry} Geometry standing on y = 0, centred on the hip.
 */
export function bakeFallenRider(gltf) {
  const baked = bakePose(gltf, 'die', 'end');
  const g = merge([baked.geometry, helmetFor(baked.head)]);
  g.computeBoundingBox();
  const box = /** @type {Box3} */ (g.boundingBox);
  g.translate(-baked.hip.x, -box.min.y, -baked.hip.z);
  return g;
}

/**
 * Helmet dome over a posed head.
 * @param {Box3} head Head bounds.
 * @returns {BufferGeometry} Helmet part.
 */
function helmetFor(head) {
  if (head.isEmpty()) throw new Error('Character has no head mesh to put a helmet on');
  const size = head.getSize(new Vector3());
  const centre = head.getCenter(new Vector3());
  const radius = Math.max(size.x, size.z) * 0.56;
  return domePart(radius, [centre.x, centre.y + size.y * 0.08, centre.z], CELL.white, PAINT_ACCENT);
}
