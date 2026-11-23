/**
 * Placed signs: textured plates on posts, facing the traffic they address. Posts and plate backs
 * are merged into one mesh each; faces share one material per code and value.
 */

import { Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import { createSignTexture } from './assets.js';
import { facingYaw } from './math.js';
import { signArt } from './sign-art.js';
import { TriangleSoup } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('./sign-art.js').SignArt} SignArt */

/** Height of the plate's lower edge above the ground (a drawing choice). */
export const SIGN_BOTTOM_M = 2;
/** Post side length. */
const POST_M = 0.07;

/**
 * Convex outline of a plate in its own plane, `[x, y]` around the plate centre.
 * @param {SignArt} art Sign art.
 * @returns {[number, number][]} Outline.
 */
export function plateOutline(art) {
  const w = art.widthM / 2;
  const h = art.heightM / 2;
  /**
   * @param {number} n Corners.
   * @param {number} start Start angle.
   * @returns {[number, number][]} Polygon.
   */
  const regular = (n, start) =>
    Array.from({ length: n }, (_, i) => {
      const a = start + (i * 2 * Math.PI) / n;
      return /** @type {[number, number]} */ ([Math.cos(a) * w, Math.sin(a) * h]);
    });
  switch (art.shape) {
    case 'round':
      return regular(20, 0);
    case 'octagon':
      return regular(8, Math.PI / 8).map(([x, y]) => [x / Math.cos(Math.PI / 8), y / Math.cos(Math.PI / 8)]);
    case 'diamond':
      return regular(4, Math.PI / 2);
    case 'triangle-down':
      return [
        [-w, h],
        [0, -h],
        [w, h],
      ];
    case 'rect':
      return [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h],
      ];
    default:
      throw new RangeError(`Unknown plate shape ${String(art.shape)}`);
  }
}

/**
 * Builds every sign of the map.
 * @param {GameMap} map Map.
 * @returns {{group: Group, dispose: () => void}} Signs.
 */
export function buildSigns(map) {
  const group = new Group();
  group.name = 'signs';
  const posts = new TriangleSoup();
  const backs = new TriangleSoup();
  /** @type {Map<string, MeshStandardMaterial>} */
  const faceMaterials = new Map();
  /** @type {Map<string, PlaneGeometry>} */
  const planes = new Map();

  for (const sign of map.signs) {
    const art = signArt(sign.code);
    const yaw = facingYaw(sign.heading);
    const origin = sign.pos;
    const centreY = SIGN_BOTTOM_M + art.heightM / 2;
    posts.addBox(origin, yaw, [0, centreY / 2 + art.heightM / 4, 0], [POST_M, centreY + art.heightM / 2, POST_M]);
    const outline = plateOutline(art).map(([x, y]) => /** @type {[number, number]} */ ([x, y + centreY]));
    backs.addStandingOutline(origin, yaw, outline, POST_M / 2 + 0.005, -1);

    const key = `${sign.code}|${sign.value ?? ''}`;
    let material = faceMaterials.get(key);
    if (!material) {
      const texture = createSignTexture(sign.code, sign.value);
      material = new MeshStandardMaterial({
        color: texture ? new Color(0xffffff) : new Color(0xcccccc),
        map: texture,
        alphaTest: 0.5,
        transparent: false,
        roughness: 0.5,
      });
      faceMaterials.set(key, material);
    }
    const planeKey = `${art.widthM}x${art.heightM}`;
    let plane = planes.get(planeKey);
    if (!plane) {
      plane = new PlaneGeometry(art.widthM, art.heightM);
      planes.set(planeKey, plane);
    }
    const face = new Mesh(plane, material);
    face.name = `sign-${sign.id}`;
    face.position.set(origin.x, centreY, origin.z);
    face.rotation.y = yaw;
    // Push the face just in front of the back plate along its normal.
    face.translateZ(POST_M / 2 + 0.01);
    face.updateMatrix();
    face.matrixAutoUpdate = false;
    group.add(face);
  }

  const metal = new MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.6, metalness: 0.3 });
  for (const [name, s] of /** @type {const} */ ([
    ['sign-posts', posts],
    ['sign-backs', backs],
  ])) {
    const geometry = s.toGeometry();
    if (!geometry) continue;
    const mesh = new Mesh(geometry, metal);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  return {
    group,
    dispose() {
      group.traverse((o) => {
        if (o instanceof Mesh && !(o.geometry instanceof PlaneGeometry)) o.geometry.dispose();
      });
      for (const p of planes.values()) p.dispose();
      for (const m of faceMaterials.values()) {
        m.map?.dispose();
        m.dispose();
      }
      metal.dispose();
    },
  };
}
