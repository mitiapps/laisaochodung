/**
 * Collects world-space triangles for one material and turns them into a single BufferGeometry,
 * so each material costs one draw call. Every add method fixes the winding so the face normal
 * points the requested way (up for ground pieces, outwards for walls).
 *
 * Two optional per-vertex attributes are opt-in per soup: texture coordinates (tiling ground and
 * atlas quads) and colours (`setColor`, so many differently painted pieces share one material).
 * A soup that never receives either emits only positions and normals, as before; once one triangle
 * carries UVs or a colour, earlier triangles are back-filled (UV 0, colour white).
 */

import { BufferGeometry, Color, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';
import { pointInPolygon } from '../geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {[number, number, number]} Vec3 */
/** @typedef {[Vec2, Vec2, Vec2]} TriangleUv UVs of the three corners, in the order given. */
/** @typedef {[number, number, number, number]} UvRect `[u0, v0, u1, v1]`. */

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

/**
 * Outward unit normal of polygon edge `i` on the ground plane, or null for a zero-length edge.
 * @param {Vec2[]} polygon Ring of `[x, z]`.
 * @param {number} i Edge index (point `i` to point `i + 1`).
 * @returns {Vec2 | null} Normal.
 */
export function outwardNormal(polygon, i) {
  const a = polygon[i];
  const b = polygon[(i + 1) % polygon.length];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return null;
  /** @type {Vec2} */
  const n = [dz / len, -dx / len];
  const probe = /** @type {Vec2} */ ([(a[0] + b[0]) / 2 + n[0] * 1e-3, (a[1] + b[1]) / 2 + n[1] * 1e-3]);
  return pointInPolygon(probe, polygon) ? [-n[0], -n[1]] : n;
}

export class TriangleSoup {
  constructor() {
    /** @type {number[]} */
    this.positions = [];
    /** @type {number[] | null} Two numbers per vertex once any triangle carries UVs. */
    this.uvs = null;
    /** @type {number[] | null} Three linear RGB numbers per vertex once any colour is set. */
    this.colors = null;
    /** @type {Vec3} Linear RGB of the triangles added next. */
    this.current = [1, 1, 1];
  }

  /**
   * Sets the vertex colour of every triangle added after this call (an sRGB hex, converted to
   * the linear values three.js expects in a colour attribute).
   * @param {number} hex Colour.
   * @returns {this} The soup.
   */
  setColor(hex) {
    const c = new Color(hex);
    this.current = [c.r, c.g, c.b];
    if (!this.colors) this.colors = new Array((this.positions.length / 3) * 3).fill(1);
    return this;
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
   * @param {TriangleUv} [uv] Corner UVs; they follow their corners when the winding flips.
   */
  addTriangle(a, b, c, normal, uv) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const dot = nx * normal[0] + ny * normal[1] + nz * normal[2];
    if (dot === 0 && nx === 0 && ny === 0 && nz === 0) return; // degenerate
    const keep = dot >= 0;
    const [p, q] = keep ? [b, c] : [c, b];
    this.positions.push(...a, ...p, ...q);
    if (uv) {
      if (!this.uvs) this.uvs = new Array(((this.positions.length - 9) / 3) * 2).fill(0);
      const [ua, ub, uc] = keep ? uv : [uv[0], uv[2], uv[1]];
      this.uvs.push(...ua, ...ub, ...uc);
    } else if (this.uvs) {
      this.uvs.push(0, 0, 0, 0, 0, 0);
    }
    if (this.colors) this.colors.push(...this.current, ...this.current, ...this.current);
  }

  /**
   * Adds a quad `a b c d` (ring order) as two triangles facing `normal`, with optional UVs from a
   * rectangle: `a` gets `(u0, v0)`, `b` `(u1, v0)`, `c` `(u1, v1)` and `d` `(u0, v1)`.
   * @param {Vec3} a Corner.
   * @param {Vec3} b Corner.
   * @param {Vec3} c Corner.
   * @param {Vec3} d Corner.
   * @param {Vec3} normal Wanted facing direction.
   * @param {UvRect} [rect] UV rectangle.
   */
  addQuad(a, b, c, d, normal, rect) {
    if (!rect) {
      this.addTriangle(a, b, c, normal);
      this.addTriangle(a, c, d, normal);
      return;
    }
    const [u0, v0, u1, v1] = rect;
    this.addTriangle(a, b, c, normal, [[u0, v0], [u1, v0], [u1, v1]]);
    this.addTriangle(a, c, d, normal, [[u0, v0], [u1, v1], [u0, v1]]);
  }

  /**
   * Adds a flat polygon at height `y`, facing up.
   * @param {Vec2[]} polygon Ring of `[x, z]`.
   * @param {number} y Height.
   * @param {number} [tileM] With a value, planar UVs of world `x / tileM`, `z / tileM`, so a
   *   repeating texture tiles every `tileM` metres.
   */
  addGroundPolygon(polygon, y, tileM) {
    if (polygon.length < 3) return;
    const contour = polygon.map((p) => new Vector2(p[0], p[1]));
    const tris = ShapeUtils.triangulateShape(contour, []);
    /**
     * @param {number} i Vertex index.
     * @returns {Vec2} UV.
     */
    const uvOf = (i) => /** @type {Vec2} */ ([polygon[i][0] / /** @type {number} */ (tileM), polygon[i][1] / /** @type {number} */ (tileM)]);
    for (const [i, j, k] of tris) {
      this.addTriangle(
        [polygon[i][0], y, polygon[i][1]],
        [polygon[j][0], y, polygon[j][1]],
        [polygon[k][0], y, polygon[k][1]],
        [0, 1, 0],
        tileM ? [uvOf(i), uvOf(j), uvOf(k)] : undefined,
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
      const n = outwardNormal(polygon, i);
      if (n) this.addWallSegment(polygon[i], polygon[(i + 1) % polygon.length], y0, y1, n);
    }
  }

  /**
   * Adds one vertical wall quad from `a` to `b` between two heights, facing `normal`.
   * @param {Vec2} a Start `[x, z]`.
   * @param {Vec2} b End `[x, z]`.
   * @param {number} y0 Bottom.
   * @param {number} y1 Top.
   * @param {Vec2} normal Facing direction on the ground plane.
   */
  addWallSegment(a, b, y0, y1, normal) {
    this.addQuad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [normal[0], 0, normal[1]]);
  }

  /**
   * Adds a closed prism: walls plus a top at `height`.
   * @param {Vec2[]} footprint Ring of `[x, z]`.
   * @param {number} height Height in metres.
   */
  addPrism(footprint, height) {
    this.addPrismBetween(footprint, 0, height);
  }

  /**
   * Adds a closed prism standing between two heights: walls plus a top at `y1`.
   * @param {Vec2[]} footprint Ring of `[x, z]`.
   * @param {number} y0 Bottom.
   * @param {number} y1 Top.
   */
  addPrismBetween(footprint, y0, y1) {
    this.addWalls(footprint, y0, y1);
    this.addGroundPolygon(footprint, y1);
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
   * Adds an axis-aligned rectangle standing in the local plane `z = planeZ` of a frame placed at
   * `origin` and turned by `yaw`, facing local `±Z`, with optional UVs (`x0, y0` gets `u0, v0`).
   * @param {{x: number, z: number}} origin Local origin on the ground.
   * @param {number} yaw Rotation about +Y.
   * @param {[number, number, number, number]} rect Local `[x0, y0, x1, y1]`.
   * @param {number} planeZ Local Z of the plane.
   * @param {1 | -1} facing Faces local +Z (1) or −Z (−1).
   * @param {UvRect} [uv] UV rectangle.
   */
  addStandingRect(origin, yaw, rect, planeZ, facing, uv) {
    const [x0, y0, x1, y1] = rect;
    this.addQuad(
      localToWorld(origin, yaw, [x0, y0, planeZ]),
      localToWorld(origin, yaw, [x1, y0, planeZ]),
      localToWorld(origin, yaw, [x1, y1, planeZ]),
      localToWorld(origin, yaw, [x0, y1, planeZ]),
      rotateY([0, 0, facing], yaw),
      uv,
    );
  }

  /**
   * Builds the geometry, or null when nothing was added.
   * @returns {BufferGeometry | null} Geometry with flat normals, plus `uv` and `color` when used.
   */
  toGeometry() {
    if (this.positions.length === 0) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    if (this.uvs) geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    if (this.colors) geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
