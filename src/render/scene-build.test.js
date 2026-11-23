import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, Vector3 } from 'three';
import map from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import vehicles from '../../data/vehicles/vehicles.json' with { type: 'json' };
import { buildRoadMeshes } from './road-mesh.js';
import { buildSigns, plateOutline } from './signs.js';
import { buildTrafficLights, lampLit } from './traffic-lights.js';
import { buildRouteMarkers, markedCheckpoint } from './route-markers.js';
import { buildActors } from './actors.js';
import { createVehicleView, fitToFootprint, lampState } from './vehicle-view.js';
import { createShake, shakeAmplitude, skidSegments } from './effects.js';
import { environmentLook, chaseTarget } from './scene.js';
import { SIGN_ART } from './sign-art.js';
import { vehicleModel, actorModel } from './vehicles/index.js';
import { wheelOffsets } from './math.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */

const fixture = /** @type {GameMap} */ (/** @type {unknown} */ (map));
const all = /** @type {Frame[]} */ (/** @type {unknown} */ (frames));

/**
 * Meshes directly under a group.
 * @param {Group} group Group.
 * @returns {Mesh[]} Meshes.
 */
function meshes(group) {
  /** @type {Mesh[]} */
  const out = [];
  group.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('static map meshes', () => {
  it('merges the fixture map into one mesh per material', () => {
    const road = buildRoadMeshes(fixture);
    const names = meshes(road.group).map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const key of ['ground', 'asphalt', 'white', 'yellow', 'pavement', 'kerb', 'building']) {
      expect(names).toContain(`static-${key}`);
      expect(road.triangles[key]).toBeGreaterThan(0);
    }
    // Every ground piece faces up.
    const asphalt = meshes(road.group).find((m) => m.name === 'static-asphalt');
    const normals = asphalt?.geometry.getAttribute('normal');
    if (!normals) throw new Error('no normals');
    for (let i = 0; i < normals.count; i += 1) expect(normals.getY(i)).toBeCloseTo(1, 6);
    road.dispose();
  });

  it('points building walls outwards', () => {
    const road = buildRoadMeshes(fixture);
    const building = meshes(road.group).find((m) => m.name === 'static-building');
    if (!building) throw new Error('no building');
    const pos = building.geometry.getAttribute('position');
    const nrm = building.geometry.getAttribute('normal');
    const centre = new Vector3(35, 6, 14); // fixture building footprint 10..60 × 8..20
    for (let i = 0; i < pos.count; i += 3) {
      const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const n = new Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      if (Math.abs(n.y) > 0.5) continue;
      expect(p.clone().sub(centre).dot(n)).toBeGreaterThan(0);
    }
    road.dispose();
  });
});

describe('signs, lights and markers', () => {
  it('builds one face per placed sign plus merged posts and backs', () => {
    const signs = buildSigns(fixture);
    const faces = meshes(signs.group).filter((m) => m.name.startsWith('sign-s-'));
    expect(faces).toHaveLength(fixture.signs.length);
    expect(meshes(signs.group).map((m) => m.name)).toEqual(expect.arrayContaining(['sign-posts', 'sign-backs']));
    signs.dispose();
  });

  it('has a closed outline for every sign shape', () => {
    for (const art of Object.values(SIGN_ART)) {
      const o = plateOutline(art);
      expect(o.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of o) {
        expect(Math.abs(x)).toBeLessThanOrEqual(art.widthM / 2 + 1e-9 + 0.04);
        expect(Math.abs(y)).toBeLessThanOrEqual(art.heightM / 2 + 1e-9 + 0.04);
      }
    }
  });

  it('lights exactly the lamp of each signal state', () => {
    const lights = buildTrafficLights(fixture);
    lights.update(all[0].trafficLights);
    const lit = meshes(lights.group).filter((m) => m.name.startsWith('lamp-') && m.material.type === 'MeshBasicMaterial');
    expect(lit.map((m) => m.name).sort()).toEqual(
      ['lamp-sig-e-green', 'lamp-sig-n-red', 'lamp-sig-s-red', 'lamp-sig-w-green'].sort(),
    );
    expect(lampLit(undefined, 'red')).toBe(false);
    lights.dispose();
  });

  it('marks the next checkpoint and hides the marker when only the finish is left', () => {
    const markers = buildRouteMarkers(fixture);
    const frame = all[0];
    expect(markedCheckpoint(fixture, frame)).toBe(0);
    markers.update(frame, 0);
    const marker = markers.group.getObjectByName('checkpoint-marker');
    expect(marker?.visible).toBe(true);
    expect(marker?.position.x).toBe(60);
    const done = { ...frame, route: { ...frame.route, nextCheckpoint: fixture.route.checkpoints.length } };
    expect(markedCheckpoint(fixture, done)).toBeNull();
    markers.update(done, 0);
    expect(marker?.visible).toBe(false);
    markers.dispose();
  });
});

describe('vehicles and actors', () => {
  it('draws a box car of the footprint size with four wheels while no model is loaded', () => {
    const view = createVehicleView({ config: { ...vehicleModel('car-sedan', 'car'), glb: null }, lengthM: 4.5, widthM: 1.8, lamps: true });
    const frame = all[0];
    view.update({ ...frame.ego.pos, heading: 0 }, frame.ego, [0, 0, 0, 0], lampState(frame.ego, frame.t, 0));
    view.root.updateMatrixWorld(true);
    const box = new Box3();
    let wheels = 0;
    view.root.traverse((o) => {
      if (o instanceof Mesh && o.visible) box.union(new Box3().setFromObject(o));
      if (o instanceof Mesh && o.geometry.type === 'CylinderGeometry') wheels += 1;
    });
    const size = box.getSize(new Vector3());
    // Heading 0: length along X (lamps stick out a few centimetres), width along Z.
    expect(size.x).toBeGreaterThanOrEqual(4.5);
    expect(size.x).toBeLessThan(4.6);
    expect(size.z).toBeCloseTo(1.8, 6);
    expect(wheels).toBe(4);
    view.dispose();
  });

  it('fits a model to the footprint per axis and stands it on the ground', () => {
    const scene = new Group();
    // Kenney sedan body proportions: 1.5 wide, 1.3 high, 2.55 long, off-centre.
    const m = new Mesh(new BoxGeometry(1.5, 1.3, 2.55));
    m.position.set(0.2, 0.4, -0.1);
    scene.add(m);
    const holder = fitToFootprint(scene, 4.5, 1.8);
    holder.updateMatrixWorld(true);
    const size = new Box3().setFromObject(holder).getSize(new Vector3());
    expect(size.z).toBeCloseTo(4.5, 6);
    expect(size.x).toBeCloseTo(1.8, 6);
    expect(new Box3().setFromObject(holder).min.y).toBeCloseTo(0, 6);
  });

  it('falls back to generated configs for unknown keys', () => {
    expect(vehicleModel('mystery', 'motorbike').kind).toBe('motorbike');
    expect(actorModel('mystery', 'car').glb).toBeNull();
    expect(actorModel('npc-sedan', 'pedestrian').kind).toBe('pedestrian');
    expect(actorModel('npc-sedan', 'car').glb).toBe('models/car-kit/taxi.glb');
  });

  it('poses every fixture actor from frames', () => {
    // Model fetches fail under Node; the views keep their generated shapes and log the error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const actors = buildActors(fixture);
    actors.update(all[0], all[1], 1, true);
    const npc = actors.group.children[1];
    expect(npc.position.x).toBeCloseTo(all[1].actors[1].pos.x, 9);
    actors.dispose();
  });

  it('sizes the catalog vehicles from data', () => {
    for (const v of vehicles) expect(vehicleModel(v.id, /** @type {'car' | 'motorbike'} */ (v.legalClass)).id).toBe(v.id);
  });
});

describe('lamps and effects', () => {
  it('lights brakes from the brake inputs and blinks hazards on both sides', () => {
    const ego = { ...all[0].ego, indicators: /** @type {const} */ ('hazard'), input: { ...all[0].ego.input, brakeFront: 0.5 } };
    const on = lampState(ego, 0, 1);
    expect(on).toMatchObject({ brake: true, left: true, right: true, head: 'off' });
    const off = lampState(ego, 0.4, 1);
    expect(off.left).toBe(false);
    expect(off.right).toBe(false);
  });

  it('lays skid segments only while a wheel slides with contact, and breaks them on reset', () => {
    const offsets = wheelOffsets('car', 4.5, 1.8);
    /** @type {([number, number] | null)[]} */
    const last = offsets.map(() => null);
    /**
     * @param {Frame} f Frame.
     * @param {number} skid Skid value.
     * @returns {Frame} Copy with skidding wheels.
     */
    const skidding = (f, skid) => ({ ...f, ego: { ...f.ego, wheels: f.ego.wheels.map((w) => ({ ...w, skid })) } });
    expect(skidSegments(last, skidding(all[0], 0.8), offsets, false)).toHaveLength(0);
    expect(skidSegments(last, skidding(all[1], 0.8), offsets, false)).toHaveLength(4);
    expect(skidSegments(last, skidding(all[2], 0.1), offsets, false)).toHaveLength(0);
    expect(skidSegments(last, skidding(all[3], 0.8), offsets, false)).toHaveLength(0);
    expect(skidSegments(last, skidding(all[4], 0.8), offsets, true)).toHaveLength(0);
    expect(last.every((p) => p === null)).toBe(true);
  });

  it('shakes harder for faster collisions and decays to rest', () => {
    expect(shakeAmplitude(20)).toBeGreaterThan(shakeAmplitude(2));
    const shake = createShake();
    shake.kick(0.4, 10);
    expect(Math.max(...shake.offset(10.1).map(Math.abs))).toBeGreaterThan(0);
    expect(shake.offset(11)).toEqual([0, 0, 0]);
  });

  it('darkens the scene at night and thickens fog in rain', () => {
    expect(environmentLook({ clockMin: 720, weather: 'clear' }).night).toBe(0);
    expect(environmentLook({ clockMin: 0, weather: 'clear' }).night).toBe(1);
    expect(environmentLook({ clockMin: 720, weather: 'rain' }).fogDensity).toBeGreaterThan(
      environmentLook({ clockMin: 720, weather: 'clear' }).fogDensity,
    );
  });

  it('places the chase camera behind and above the vehicle', () => {
    const t = chaseTarget({ x: 0, y: 0, z: 0, heading: 0 }, 'car');
    expect(t.eye[0]).toBeLessThan(0);
    expect(t.eye[1]).toBeGreaterThan(1);
    expect(t.look[0]).toBeGreaterThan(0);
  });
});
