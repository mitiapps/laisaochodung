import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box3, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { projectOntoPolyline } from '../../geometry/index.js';
import { headingToYaw } from '../math.js';
import { SCENERY_KIT } from './kit.js';
import { POLE_ATTACH, primitiveShape } from './props.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/map.js').Prop} Prop */
/** @typedef {[number, number]} Vec2 */

const PUBLIC = fileURLToPath(new URL('../../../public/', import.meta.url));
/** A lamp this close to a lane centre stands beside the carriageway, metres. */
const KERB_SIDE_M = 10;
/** Every shipped map. */
const MAPS = readdirSync(`${PUBLIC}maps`)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => /** @type {GameMap} */ (JSON.parse(readFileSync(`${PUBLIC}maps/${f}`, 'utf8'))));

/**
 * A shipped GLB without its external texture, which Node cannot decode.
 * @param {string} path Path relative to `public/`.
 * @returns {ArrayBuffer} GLB.
 */
function glbWithoutTexture(path) {
  const buf = readFileSync(PUBLIC + path);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) delete m.pbrMetallicRoughness?.baseColorTexture;
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const head = Buffer.from(text, 'utf8');
  const rest = buf.subarray(20 + jsonLength);
  const out = Buffer.alloc(20 + head.length + rest.length);
  buf.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(head.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  head.copy(out, 20);
  rest.copy(out, 20 + head.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

/**
 * Vertices of a prop kind as drawn: the kit's model turned by its yaw offset, or the primitive.
 * @param {'lamp' | 'power-pole'} kind Kind.
 * @returns {Promise<Vector3[]>} Vertices in the prop's local frame (up to scale).
 */
async function drawnVertices(kind) {
  const model = SCENERY_KIT.propModels?.[kind];
  /** @type {Vector3[]} */
  const out = [];
  if (!model) {
    const pos = primitiveShape(kind).toGeometry().getAttribute('position');
    for (let i = 0; i < pos.count; i += 1) out.push(new Vector3().fromBufferAttribute(pos, i));
    return out;
  }
  const gltf = await new GLTFLoader().parseAsync(glbWithoutTexture(model.path), '');
  gltf.scene.updateMatrixWorld(true);
  const turn = new Matrix4().makeRotationY(model.yawOffset);
  gltf.scene.traverse((o) => {
    const mesh = /** @type {import('three').Mesh} */ (o);
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 1) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(turn));
  });
  return out;
}

/**
 * Horizontal local direction from the base of a drawn prop to its top part.
 * @param {Vector3[]} vertices Vertices.
 * @returns {Vec2} Unit `[x, z]`.
 */
function reachOfTop(vertices) {
  const box = new Box3().setFromPoints(vertices);
  const h = box.max.y - box.min.y;
  const base = new Box3().setFromPoints(vertices.filter((v) => v.y < box.min.y + h * 0.2)).getCenter(new Vector3());
  const top = new Box3().setFromPoints(vertices.filter((v) => v.y > box.min.y + h * 0.9)).getCenter(new Vector3());
  const dx = top.x - base.x;
  const dz = top.z - base.z;
  const n = Math.hypot(dx, dz);
  return [dx / n, dz / n];
}

/**
 * A local horizontal direction of a prop in world `[x, z]`, as the scenery places it.
 * @param {Prop} prop Prop.
 * @param {Vec2} local Local `[x, z]`.
 * @returns {Vec2} World direction.
 */
function toWorld(prop, local) {
  const v = new Vector3(local[0], 0, local[1]).applyAxisAngle(new Vector3(0, 1, 0), headingToYaw(prop.heading));
  return [v.x, v.z];
}

/**
 * The nearest lane centreline point of a map and the lane direction there.
 * @param {GameMap} map Map.
 * @param {Vec2} p Point.
 * @returns {{point: Vec2, tangent: Vec2, distance: number}} Nearest lane centre.
 */
function nearestLane(map, p) {
  let best = { point: /** @type {Vec2} */ ([0, 0]), tangent: /** @type {Vec2} */ ([1, 0]), distance: Infinity };
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const hit = projectOntoPolyline(p, lane.centerline);
      if (hit.distance < best.distance) {
        best = { point: hit.point, tangent: [Math.cos(hit.heading), -Math.sin(hit.heading)], distance: hit.distance };
      }
    }
  }
  return best;
}

describe('prop orientation on the shipped maps', () => {
  it('points every kerb-side lamp arm over the road, towards the nearest lane centreline', async () => {
    const arm = reachOfTop(await drawnVertices('lamp'));
    let lamps = 0;
    for (const map of MAPS) {
      for (const lamp of (map.props ?? []).filter((p) => p.kind === 'lamp')) {
        const lane = nearestLane(map, [lamp.pos.x, lamp.pos.z]);
        // OSM lamps off every road (parks, yards) have no carriageway to reach over.
        if (lane.distance > KERB_SIDE_M) continue;
        const to = [(lane.point[0] - lamp.pos.x) / lane.distance, (lane.point[1] - lamp.pos.z) / lane.distance];
        const dir = toWorld(lamp, arm);
        // Within 30° of the way to the lane.
        expect(dir[0] * to[0] + dir[1] * to[1], `${map.id} ${lamp.id}`).toBeGreaterThan(Math.cos(Math.PI / 6));
        lamps += 1;
      }
    }
    expect(lamps).toBeGreaterThan(200);
  });

  it('sets every power-pole crossarm across the kerb, with the cables on its ends', async () => {
    const vertices = await drawnVertices('power-pole');
    // The crossarm: the widest part near the top, across the local Z axis.
    const upper = POLE_ATTACH.filter((a) => a[1] > 7);
    expect(upper).toHaveLength(2);
    const armY = upper[0][1];
    const arm = new Box3().setFromPoints(vertices.filter((v) => Math.abs(v.y - armY) < 0.1));
    const half = (arm.max.z - arm.min.z) / 2;
    expect(arm.max.z - arm.min.z).toBeGreaterThan((arm.max.x - arm.min.x) * 4);
    for (const a of upper) {
      // On the arm, in its outer third.
      expect(a[2]).toBeGreaterThanOrEqual(arm.min.z);
      expect(a[2]).toBeLessThanOrEqual(arm.max.z);
      expect(Math.abs(a[2])).toBeGreaterThan(half / 3 * 2 - 1e-9);
      expect(Math.abs(a[0])).toBeLessThan(arm.max.x - arm.min.x);
    }
    let poles = 0;
    for (const map of MAPS) {
      for (const pole of (map.props ?? []).filter((p) => p.kind === 'power-pole')) {
        const lane = nearestLane(map, [pole.pos.x, pole.pos.z]);
        const across = toWorld(pole, [0, 1]);
        // Perpendicular to the kerb (the nearest lane's direction) within 15°.
        expect(Math.abs(across[0] * lane.tangent[0] + across[1] * lane.tangent[1]), `${map.id} ${pole.id}`).toBeLessThan(Math.sin(Math.PI / 12));
        poles += 1;
      }
    }
    expect(poles).toBeGreaterThan(50);
  });
});
