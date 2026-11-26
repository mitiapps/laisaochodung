import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import map from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import vehicles from '../../data/vehicles/vehicles.json' with { type: 'json' };
import { KERB_HEIGHT_M } from '../contracts/units.js';
import { GROUND_TILE_M, LAYER_Y, buildRoadMeshes, mapBounds } from './road-mesh.js';
import { buildScenery } from './scenery/index.js';
import { SIGN_BOTTOM_M, buildSigns, plateOutline } from './signs.js';
import { LENS_M, LOWEST_LAMP_Y_M, buildTrafficLights, countdown, digitCells, headCentreY, lampLit } from './traffic-lights.js';
import { buildRouteMarkers, markedCheckpoint } from './route-markers.js';
import { buildActors } from './actors.js';
import { createVehicleView, fitToFootprint, lampState } from './vehicle-view.js';
import { createShake, shakeAmplitude, skidSegments } from './effects.js';
import { FAR_M, LOW_FAR_M, applyNight, createEnvironment, environmentLook, chaseTarget, nightTargets } from './scene.js';
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
    for (const key of ['ground', 'asphalt', 'white', 'yellow', 'pavement', 'kerb']) {
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

  it('draws the ground in tiles no larger than GROUND_TILE_M, all facing up, under the road', () => {
    const road = buildRoadMeshes(fixture);
    const ground = meshes(road.group).find((m) => m.name === 'static-ground');
    const pos = ground?.geometry.getAttribute('position');
    const normals = ground?.geometry.getAttribute('normal');
    if (!pos || !normals) throw new Error('no ground geometry');
    expect(LAYER_Y.ground).toBeLessThan(LAYER_Y.road);
    // Every asphalt vertex lies above the ground plane, so the ground never wins the depth test.
    const asphalt = meshes(road.group).find((m) => m.name === 'static-asphalt')?.geometry.getAttribute('position');
    if (!asphalt) throw new Error('no asphalt geometry');
    let lowestAsphalt = Infinity;
    for (let i = 0; i < asphalt.count; i += 1) lowestAsphalt = Math.min(lowestAsphalt, asphalt.getY(i));
    expect(lowestAsphalt - LAYER_Y.ground).toBeGreaterThan(0.02);
    for (let t = 0; t < pos.count; t += 3) {
      const xs = [pos.getX(t), pos.getX(t + 1), pos.getX(t + 2)];
      const zs = [pos.getZ(t), pos.getZ(t + 1), pos.getZ(t + 2)];
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(GROUND_TILE_M + 1e-9);
      expect(Math.max(...zs) - Math.min(...zs)).toBeLessThanOrEqual(GROUND_TILE_M + 1e-9);
      for (let k = 0; k < 3; k += 1) {
        expect(pos.getY(t + k)).toBeCloseTo(LAYER_Y.ground, 6);
        expect(normals.getY(t + k)).toBeCloseTo(1, 6);
      }
    }
    // The tiles cover the map's bounds without a gap: their areas add up to the whole rectangle.
    let area = 0;
    for (let t = 0; t < pos.count; t += 3) {
      const ax = pos.getX(t + 1) - pos.getX(t);
      const az = pos.getZ(t + 1) - pos.getZ(t);
      const bx = pos.getX(t + 2) - pos.getX(t);
      const bz = pos.getZ(t + 2) - pos.getZ(t);
      area += Math.abs(ax * bz - az * bx) / 2;
    }
    const b = mapBounds(fixture);
    const xs = [];
    const zs = [];
    for (let i = 0; i < pos.count; i += 1) {
      xs.push(pos.getX(i));
      zs.push(pos.getZ(i));
    }
    const w = Math.max(...xs) - Math.min(...xs);
    const d = Math.max(...zs) - Math.min(...zs);
    expect(w).toBeGreaterThan(b.maxX - b.minX);
    expect(d).toBeGreaterThan(b.maxZ - b.minZ);
    expect(Math.abs(area - w * d) / (w * d)).toBeLessThan(1e-9);
    road.dispose();
  });

  it('leaves buildings to the scenery and keeps other obstacles', () => {
    const road = buildRoadMeshes(fixture);
    expect(meshes(road.group).map((m) => m.name)).not.toContain('static-building');
    expect(road.triangles.building).toBeUndefined();
    road.dispose();
    const scenery = buildScenery(fixture);
    expect(meshes(scenery.group).some((m) => m.name.startsWith('scenery-facade@'))).toBe(true);
    scenery.dispose();
    const barrier = { id: 'ob-barrier', kind: /** @type {const} */ ('barrier'), footprint: /** @type {[number, number][]} */ ([[0, 5], [2, 5], [2, 6], [0, 6]]), height: 1 };
    const withBarrier = buildRoadMeshes({ ...fixture, obstacles: [...fixture.obstacles, barrier] });
    expect(meshes(withBarrier.group).map((m) => m.name)).toContain('static-barrier');
    withBarrier.dispose();
  });

  it('draws the kerb at the collider height and tiles the pavement', () => {
    expect(LAYER_Y.pavement).toBe(KERB_HEIGHT_M);
    const road = buildRoadMeshes(fixture);
    const pavement = meshes(road.group).find((m) => m.name === 'static-pavement');
    expect(pavement?.geometry.getAttribute('uv')).toBeDefined();
    const kerb = meshes(road.group).find((m) => m.name === 'static-kerb');
    const pos = kerb?.geometry.getAttribute('position');
    if (!pos) throw new Error('no kerb');
    let top = -Infinity;
    for (let i = 0; i < pos.count; i += 1) top = Math.max(top, pos.getY(i));
    expect(top).toBeCloseTo(KERB_HEIGHT_M + 0.002, 6);
    for (const m of meshes(road.group)) {
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(true);
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

  it('stands signal heads at QCVN 41 heights with 300 mm lenses', () => {
    expect(LENS_M).toBe(0.3);
    expect(LOWEST_LAMP_Y_M.side).toBeGreaterThanOrEqual(1.7);
    expect(LOWEST_LAMP_Y_M.side).toBeLessThanOrEqual(5.8);
    expect(LOWEST_LAMP_Y_M.cantilever).toBeGreaterThanOrEqual(5.2);
    expect(LOWEST_LAMP_Y_M.cantilever).toBeLessThanOrEqual(7.8);
    const lights = buildTrafficLights(fixture);
    const green = meshes(lights.group).find((m) => m.name.endsWith('-green'));
    expect(green?.position.y).toBeCloseTo(LOWEST_LAMP_Y_M.side, 9);
    const id = fixture.signals[0].id;
    const arm = buildTrafficLights(fixture, { cantilever: new Set([id]) });
    const hung = meshes(arm.group).find((m) => m.name === `lamp-${id}-green`);
    expect(hung?.position.y).toBeCloseTo(LOWEST_LAMP_Y_M.cantilever, 9);
    expect(headCentreY('cantilever')).toBeGreaterThan(headCentreY('side'));
    lights.dispose();
    arm.dispose();
    expect(SIGN_BOTTOM_M).toBe(2);
  });

  it('counts down the red and green phases in their colour and leaves yellow blank', () => {
    const signal = { ...fixture.signals[0], cycle: { green: 27, yellow: 3, red: 30, offset: 0 } };
    expect(countdown(signal, 0)).toEqual({ state: 'green', seconds: 27 });
    expect(countdown(signal, 26.2)).toEqual({ state: 'green', seconds: 1 });
    expect(countdown(signal, 28)).toBeNull();
    expect(countdown(signal, 30)).toEqual({ state: 'red', seconds: 30 });
    expect(digitCells(7)).toEqual([10, 7]);
    expect(digitCells(30)).toEqual([3, 0]);

    const lights = buildTrafficLights(fixture);
    const display = meshes(lights.group).find((m) => m.name === 'signal-countdowns');
    if (!display) throw new Error('no countdown mesh');
    const colors = display.geometry.getAttribute('color');
    const frame = all[0];
    lights.update(frame.trafficLights, frame.t);
    // Two digit quads of six vertices per signal, in map order.
    fixture.signals.forEach((sig, i) => {
      const state = frame.trafficLights[sig.id];
      const units = (i * 2 + 1) * 6;
      if (state === 'red') expect(colors.getX(units)).toBeGreaterThan(colors.getY(units));
      if (state === 'green') expect(colors.getY(units)).toBeGreaterThan(colors.getX(units));
    });
    lights.update(frame.trafficLights);
    for (let i = 0; i < colors.count; i += 1) expect(colors.getX(i) + colors.getY(i) + colors.getZ(i)).toBe(0);
    lights.dispose();
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
    // Vehicles are instanced per model; slot 0 of the taxi mesh holds the fixture's car.
    const mesh = /** @type {import('three').InstancedMesh | undefined} */ (actors.group.getObjectByName('kenney:taxi'));
    expect(mesh).toBeDefined();
    const p = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(/** @type {import('three').InstancedMesh} */ (mesh).instanceMatrix.array, 0));
    // Instance matrices are 32-bit floats.
    expect(p.x).toBeCloseTo(all[1].actors[1].pos.x, 4);
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

  it('thickens the clear-day fog to hide the shorter far plane of the low-cost path, and only that', () => {
    /**
     * Fog density after one update.
     * @param {number} farM Far plane.
     * @param {import('../contracts/telemetry.js').FrameEnv} env Environment.
     * @returns {number} Density.
     */
    const densityAt = (farM, env) => {
      const scene = new Scene();
      const environment = createEnvironment(scene, new MeshStandardMaterial(), { farM });
      environment.update(env, new Vector3(), 0);
      environment.dispose();
      return /** @type {import('three').FogExp2} */ (scene.fog).density;
    };
    const day = { clockMin: 720, weather: /** @type {const} */ ('clear') };
    const rain = { clockMin: 720, weather: /** @type {const} */ ('rain') };
    const night = { clockMin: 0, weather: /** @type {const} */ ('clear') };
    for (const farM of [FAR_M, LOW_FAR_M]) expect(Math.exp(-((densityAt(farM, day) * farM) ** 2))).toBeLessThan(0.02);
    for (const env of [day, rain, night]) expect(densityAt(FAR_M, env)).toBe(environmentLook(env).fogDensity);
    expect(densityAt(LOW_FAR_M, rain)).toBe(environmentLook(rain).fogDensity);
  });

  it('fogs out the 300 m far plane and drives night emissives', () => {
    const fog = environmentLook({ clockMin: 720, weather: 'clear' }).fogDensity;
    expect(FAR_M).toBe(300);
    expect(Math.exp(-((fog * FAR_M) ** 2))).toBeLessThan(0.02);
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    material.userData.nightEmissive = 0.5;
    const mesh = new Mesh(new BoxGeometry(), material);
    const glow = new Object3D();
    glow.userData.nightOnly = 0.3;
    scene.add(mesh, glow);
    const targets = nightTargets(scene);
    applyNight(targets, 1);
    expect(material.emissiveIntensity).toBe(0.5);
    expect(glow.visible).toBe(true);
    applyNight(targets, 0);
    expect(material.emissiveIntensity).toBe(0);
    expect(glow.visible).toBe(false);
  });

  it('places the chase camera behind and above the vehicle', () => {
    const t = chaseTarget({ x: 0, y: 0, z: 0, heading: 0 }, 'car');
    expect(t.eye[0]).toBeLessThan(0);
    expect(t.eye[1]).toBeGreaterThan(1);
    expect(t.look[0]).toBeGreaterThan(0);
  });
});
