/**
 * Static scenery soups split into square chunks so frustum culling can drop whole blocks: one
 * soup per material per chunk, merged into one mesh each.
 */

import { Mesh } from 'three';
import { TriangleSoup } from '../triangle-soup.js';

/** @typedef {import('three').Material} Material */
/** @typedef {import('three').Group} Group */

/**
 * Chunk side in metres. Measured headless on `osm-pasteur` (frustum of the chase camera at the
 * route poses, 300 m far plane): 100 m chunks leave up to 74 scenery draw calls in view, 200 m
 * chunks up to 38, inside the 40-call scenery budget.
 */
export const CHUNK_M = 200;

/**
 * Key of the chunk holding a ground point.
 * @param {number} x X.
 * @param {number} z Z.
 * @returns {string} Key `"i,j"`.
 */
export function chunkKey(x, z) {
  return `${Math.floor(x / CHUNK_M)},${Math.floor(z / CHUNK_M)}`;
}

export class ChunkedSoups {
  constructor() {
    /** @type {Map<string, Map<string, TriangleSoup>>} */
    this.chunks = new Map();
  }

  /**
   * The soup of one material in the chunk holding a point.
   * @param {number} x Anchor X.
   * @param {number} z Anchor Z.
   * @param {string} material Material key.
   * @returns {TriangleSoup} Soup.
   */
  at(x, z, material) {
    const key = chunkKey(x, z);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Map();
      this.chunks.set(key, chunk);
    }
    let soup = chunk.get(material);
    if (!soup) {
      soup = new TriangleSoup();
      chunk.set(material, soup);
    }
    return soup;
  }

  /**
   * Adds one mesh per non-empty soup to `group`, named `scenery-<material>@<chunk>`. Scenery
   * receives shadows but never casts them.
   * @param {Group} group Parent.
   * @param {Record<string, Material>} materials Materials by key.
   * @returns {Mesh[]} Meshes added.
   */
  build(group, materials) {
    /** @type {Mesh[]} */
    const out = [];
    for (const [key, chunk] of this.chunks) {
      for (const [material, soup] of chunk) {
        const mat = materials[material];
        if (!mat) throw new RangeError(`No scenery material ${material}`);
        const geometry = soup.toGeometry();
        if (!geometry) continue;
        const mesh = new Mesh(geometry, mat);
        mesh.name = `scenery-${material}@${key}`;
        mesh.userData.chunk = key;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        out.push(mesh);
      }
    }
    return out;
  }
}
