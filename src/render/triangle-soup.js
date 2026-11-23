/**
 * Collects world-space triangles for one material and turns them into a single BufferGeometry,
 * so each material costs one draw call. Every add method fixes the winding so the face normal
 * points the requested way (up for ground pieces, outwards for walls).
 */

import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';
import { pointInPolygon } from '../geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {[number, number, number]} Vec3 */

/**
 * Rotates a vector about +Y (three.js `rotation.y`).
 * @param {Vec3} v Vector.
 * @param {number} yaw Angle.
 * @returns {Vec3} Rotated vector.
 */
export function rotateY(v, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/**
 * Local point of a frame at `origin` turned by `yaw` to world space.
 * @param {{x: number, z: number}} origin Frame origin on the ground.
 * @param {number} yaw Rotation about +Y.
 * @param {Vec3} p Local point.
 * @returns {Vec3} World point.
 */
export function localToWorld(origin, yaw, p) {
  const r = rotateY(p, yaw);
  return [origin.x + r[0], r[1], origin.z + r[2]];
}

export class TriangleSoup {
  constructor() {
    /** @type {number[]} */
    this.positions = [];
  }

  /** @returns {number} Triangles added so far. */
  get triangleCount() {
    return this.positions.length / 9;
  }

  /**
   * Adds a triangle, flipping it when its normal points against `normal`.
   * @param {Vec3} a Corner.
   * @param {Vec3} b Corner.
   * @param {Vec3} c Corner.
   * @param {Vec3} normal Wanted facing direction.
   */
  addTriangle(a, b, c, normal) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const dot = nx * normal[0] + ny * normal[1] + nz * normal[2];
    if (dot === 0 && nx === 0 && ny === 0 && nz === 0) return; // degenerate
    const [p, q] = dot >= 0 ? [b, c] : [c, b];
    this.positions.push(...a, ...p, ...q);
  }

  /**
   * Adds a flat polygon at height `y`, facing up.
   * @param {Vec2[]} polygon Ring of `[x, z]`.
   * @param {number} y Height.
   */
  addGroundPolygon(polygon, y) {
    if (polygon.length < 3) return;
    const contour = polygon.map((p) => new Vector2(p[0], p[1]));
    const tris = ShapeUtils.triangulateShape(contour, []);
    for (const [i, j, k] of tris) {
      this.addTriangle(
        [polygon[i][0], y, polygon[i][1]],
        [polygon[j][0], y, polygon[j][1]],
        [polygon[k][0], y, polygon[k][1]],
        [0, 1, 0],
      );
    }
  }

  /**
   * Adds ground quads at height `y`, facing up.
   * @param {[Vec2, Vec2, Vec2, Vec2][]} quads Quads.
   * @param {number} y Height.
   */
  addGroundQuads(quads, y) {
    for (const [a, b, c, d] of quads) {
      const A = /** @type {Vec3} */ ([a[0], y, a[1]]);
      const B = /** @type {Vec3} */ ([b[0], y, b[1]]);
      const C = /** @type {Vec3} */ ([c[0], y, c[1]]);
      const D = /** @type {Vec3} */ ([d[0], y, d[1]]);
      this.addTriangle(A, B, C, [0, 1, 0]);
      this.addTriangle(A, C, D, [0, 1, 0]);
    }
  }

  /**
   * Adds the vertical outer walls of a polygon between two heights.
   * @param {Vec2[]} polygon Ring of `[x, z]`.
   * @param {number} y0 Bottom.
   * @param {number} y1 Top.
   */
  addWalls(polygon, y0, y1) {
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-9) continue;
      let n = /** @type {Vec2} */ ([dz / len, -dx / len]);
      const probe = /** @type {Vec2} */ ([(a[0] + b[0]) / 2 + n[0] * 1e-3, (a[1] + b[1]) / 2 + n[1] * 1e-3]);
      if (pointInPolygon(probe, polygon)) n = [-n[0], -n[1]];
      const normal = /** @type {Vec3} */ ([n[0], 0, n[1]]);
      const A = /** @type {Vec3} */ ([a[0], y0, a[1]]);
      const B = /** @type {Vec3} */ ([b[0], y0, b[1]]);
      const C = /** @type {Vec3} */ ([b[0], y1, b[1]]);
      const D = /** @type {Vec3} */ ([a[0], y1, a[1]]);
      this.addTriangle(A, B, C, normal);
      this.addTriangle(A, C, D, normal);
    }
  }

  /**
   * Adds a closed prism: walls plus a top at `height`.
   * @param {Vec2[]} footprint Ring of `[x, z]`.
   * @param {number} height Height in metres.
   */
  addPrism(footprint, height) {
    this.addWalls(footprint, 0, height);
    this.addGroundPolygon(footprint, height);
  }

  /**
   * Adds a box given in a local frame placed at `origin` and turned by `yaw` about +Y.
   * @param {{x: number, z: number}} origin Local origin on the ground.
   * @param {number} yaw Rotation about +Y.
   * @param {Vec3} center Box centre in the local frame.
   * @param {Vec3} size Box size along local X, Y, Z.
   */
  addBox(origin, yaw, center, size) {
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    /**
     * @param {number} sx Sign along X.
     * @param {number} sy Sign along Y.
     * @param {number} sz Sign along Z.
     * @returns {Vec3} World corner.
     */
    const corner = (sx, sy, sz) =>
      localToWorld(origin, yaw, [center[0] + sx * hx, center[1] + sy * hy, center[2] + sz * hz]);
    /** @type {[Vec3, [number, number, number][]][]} */
    const faces = [
      [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      [[-1, 0, 0], [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]]],
      [[0, 1, 0], [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]],
      [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
      [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [[0, 0, -1], [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]]],
    ];
    for (const [n, quad] of faces) {
      const [a, b, c, d] = quad.map(([sx, sy, sz]) => corner(sx, sy, sz));
      const normal = rotateY(n, yaw);
      this.addTriangle(a, b, c, normal);
      this.addTriangle(a, c, d, normal);
    }
  }

  /**
   * Adds a flat convex outline standing in a local plane `z = planeZ`, facing local `±Z`.
   * @param {{x: number, z: number}} origin Local origin on the ground.
   * @param {number} yaw Rotation about +Y.
   * @param {[number, number][]} outline Convex outline as local `[x, y]`.
   * @param {number} planeZ Local Z of the plane.
   * @param {1 | -1} facing Faces local +Z (1) or −Z (−1).
   */
  addStandingOutline(origin, yaw, outline, planeZ, facing) {
    const pts = outline.map(([x, y]) => localToWorld(origin, yaw, [x, y, planeZ]));
    const normal = rotateY([0, 0, facing], yaw);
    for (let i = 1; i < pts.length - 1; i += 1) this.addTriangle(pts[0], pts[i], pts[i + 1], normal);
  }

  /**
   * Builds the geometry, or null when nothing was added.
   * @returns {BufferGeometry | null} Geometry with flat normals.
   */
  toGeometry() {
    if (this.positions.length === 0) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
