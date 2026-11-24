import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstancedMesh, Matrix4, Quaternion, ShaderLib, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import map from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import trafficParams from '../generated/traffic-params.json' with { type: 'json' };
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../contracts/index.js';
import { FADE_S, createActorViews } from './actors.js';
import { blinkOn } from './math.js';
import { bakeFallenRider, bakePose, bakeRider, CHARACTER_HEIGHT_M } from './rider-bake.js';
import { BUS_SIZE, buildBus } from './vehicles/bus.js';
import { KENNEY_BODIES, PASSENGER_SHARE, RIDERS, resolveLook } from './vehicles/index.js';
import { kenneyParts } from './vehicles/kenney.js';
import { KEEP_PAINT, patchFragment, patchVertex, shadeTexel } from './vehicles/look-material.js';
import { MOTORBIKE_TYPES, buildMotorbike } from './vehicles/motorbike.js';
import { PAINT_ACCENT, PAINT_BODY, triangles, unitWheel } from './vehicles/procedural.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('three/addons/loaders/GLTFLoader.js').GLTF} GLTF */

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const base = /** @type {Frame} */ (/** @type {unknown} */ (frames[0]));

/** Fixture map sized for the stress test (120 agents plus the scripted actors). */
const fixture = /** @type {GameMap} */ (
  /** @type {unknown} */ ({ ...map, traffic: { maxAgents: 130 } })
);

/**
 * A shipped GLB as an ArrayBuffer without its external texture, which Node cannot decode; the
 * geometry, skins and clips are the shipped ones.
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

/** @type {Map<string, Promise<GLTF>>} */
const cache = new Map();
/** @type {Promise<unknown>[]} */
let pending = [];

/**
 * Loads a shipped GLB from disk (once per path).
 * @param {string} path Path relative to `public/`.
 * @returns {Promise<GLTF>} Model.
 */
function loadFile(path) {
  let p = cache.get(path);
  if (!p) {
    p = new GLTFLoader().parseAsync(glbWithoutTexture(path), '');
    cache.set(path, p);
  }
  pending.push(p);
  return p;
}

/** File loaders for the actor views; colour maps are blank textures under Node. */
const assets = { loadModel: loadFile, loadTexture: () => Promise.resolve(new Texture()) };

/**
 * Waits until every requested model is loaded and its handlers ran.
 * @returns {Promise<void>} Settled.
 */
async function settle() {
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    await Promise.allSettled(batch);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Traffic pose.
 * @param {string} id Id.
 * @param {string} model Model key.
 * @param {number} x Position.
 * @param {Partial<ActorPose>} [over] Overrides.
 * @returns {ActorPose} Pose.
 */
function agent(id, model, x, over = {}) {
  const spec = /** @type {Record<string, {kind: 'car' | 'motorbike', lengthM: number, widthM: number}>} */ (trafficParams.models)[model];
  return {
    id,
    kind: spec.kind,
    pos: { x, z: 1.75 },
    heading: 0,
    speed: 5,
    active: true,
    model,
    variant: 0,
    lengthM: spec.lengthM,
    widthM: spec.widthM,
    lights: ACTOR_LIGHTS.off,
    state: 'moving',
    violations: NO_VIOLATIONS,
    ...over,
  };
}

/**
 * Frame with the given poses only.
 * @param {number} tick Tick.
 * @param {ActorPose[]} actors Poses.
 * @param {number} [t] Frame time.
 * @returns {Frame} Frame.
 */
const frameWith = (tick, actors, t = tick / 60) => ({ ...base, tick, t, events: [], actors });

/**
 * Visible instanced meshes of a view.
 * @param {import('three').Group} group Actor group.
 * @returns {InstancedMesh[]} Meshes.
 */
function drawn(group) {
  /** @type {InstancedMesh[]} */
  const out = [];
  group.traverse((o) => {
    if (o instanceof InstancedMesh && o.visible && o.count > 0) out.push(o);
  });
  return out;
}

/**
 * A named instanced mesh.
 * @param {import('three').Group} group Actor group.
 * @param {string} name Name.
 * @returns {InstancedMesh} Mesh.
 */
function setNamed(group, name) {
  const mesh = group.getObjectByName(name);
  if (!(mesh instanceof InstancedMesh)) throw new Error(`no instanced mesh ${name}`);
  return mesh;
}

/**
 * The 120-agent stress mix of `osm-pasteur`'s shares, with varied variants and some lamps on.
 * @returns {ActorPose[]} Poses.
 */
function stressPoses() {
  const shares = [
    ['motorbike', 90],
    ['car', 14],
    ['taxi', 7],
    ['bus', 3],
    ['truck', 6],
  ];
  /** @type {ActorPose[]} */
  const out = [];
  for (const [model, n] of shares) {
    for (let i = 0; i < Number(n); i += 1) {
      const k = out.length;
      out.push(agent(`npc-${k}`, String(model), k * 6, { variant: k % 3, lights: k % 4 === 0 ? ACTOR_LIGHTS.brake : ACTOR_LIGHTS.off }));
    }
  }
  return out;
}

beforeAll(async () => {
  // Load every model once, so each test sees loaded geometry.
  await Promise.all([...Object.values(KENNEY_BODIES).map((b) => loadFile(b.glb)), ...RIDERS.map(loadFile)]);
  pending = [];
});

afterEach(() => vi.restoreAllMocks());

describe('instanced traffic view', () => {
  it('draws 120 mixed agents with one draw call per model and part, within the call and triangle budgets', async () => {
    const errors = vi.spyOn(console, 'error');
    const view = createActorViews(fixture, assets);
    const poses = stressPoses();
    view.update(null, frameWith(1, poses), 1, true);
    await settle();
    view.update(null, frameWith(2, poses), 1, true);
    const meshes = drawn(view.group);
    const names = meshes.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(meshes.length).toBeLessThanOrEqual(40);
    // Every agent is drawn: one body (ridden bike, Kenney body or bus) per pose.
    const bodies = meshes.filter((m) => /^(bike|kenney|bus)(:|$)/.test(m.name)).reduce((n, m) => n + m.count, 0);
    expect(bodies).toBe(poses.length);
    // Kenney bodies are the loaded Car Kit meshes, not the box-car stand-in.
    expect(meshes.filter((m) => m.name.startsWith('kenney:')).every((m) => triangles(m.geometry) > 500)).toBe(true);
    const tris = meshes.reduce((n, m) => n + m.count * triangles(m.geometry), 0);
    expect(tris).toBeLessThanOrEqual(250_000);
    // Riders and passengers were baked and merged: a ridden bike is bike plus rider.
    const ridden = meshes.filter((m) => m.name.startsWith('bike:'));
    expect(ridden.length).toBeGreaterThan(0);
    expect(ridden.every((m) => triangles(m.geometry) > 1200)).toBe(true);
    expect(meshes.filter((m) => m.name.startsWith('pillion:')).map((m) => m.name).sort()).toEqual(MOTORBIKE_TYPES.map((t) => `pillion:${t}`).sort());
    expect(setNamed(view.group, 'lamp:brake').count).toBeGreaterThan(0);
    expect(errors).not.toHaveBeenCalled();
    view.dispose();
  });

  it('reuses instance slots as ids come and go and leaves nothing drawn', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = createActorViews(fixture, assets);
    const a = agent('npc-1', 'bus', 10);
    const b = agent('npc-2', 'bus', 40);
    const bus = () => setNamed(view.group, 'bus');
    const xAt = (/** @type {number} */ i) => new Vector3().setFromMatrixPosition(bus().instanceMatrix.array.length ? new Matrix4().fromArray(bus().instanceMatrix.array, i * 16) : new Matrix4()).x;
    view.update(null, frameWith(1, [a, b]), 1, true);
    expect(bus().count).toBe(2);
    view.update(null, frameWith(2, [{ ...b, pos: { x: 41, z: 1.75 } }]), 1, true);
    expect(bus().count).toBe(1);
    expect(xAt(0)).toBeCloseTo(41, 6);
    const c = agent('npc-3', 'bus', 70);
    view.update(null, frameWith(3, [{ ...b, pos: { x: 42, z: 1.75 } }, c]), 1, true);
    expect(bus().count).toBe(2);
    expect(xAt(1)).toBeCloseTo(70, 6);
    view.update(null, frameWith(4, []), 1, true);
    expect(drawn(view.group)).toEqual([]);
    view.update(null, frameWith(5, [a]), 1, true);
    view.reset();
    expect(drawn(view.group)).toEqual([]);
    view.dispose();
  });

  it('lights brake lamps from pose.lights.brake and blinks hazards on the frame time', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = createActorViews(fixture, assets);
    const brakes = () => setNamed(view.group, 'lamp:brake');
    view.update(null, frameWith(1, [agent('npc-1', 'bus', 10, { lights: ACTOR_LIGHTS.brake })]), 1, true);
    expect(brakes().count).toBe(2);
    view.update(null, frameWith(2, [agent('npc-1', 'bus', 10, { lights: ACTOR_LIGHTS.off })]), 1, true);
    expect(brakes().visible).toBe(false);
    const hazard = agent('npc-1', 'bus', 10, { lights: ACTOR_LIGHTS.hazard });
    const on = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].find((t) => blinkOn(t));
    const off = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].find((t) => !blinkOn(t));
    view.update(null, frameWith(3, [hazard], on), 1, true);
    expect(setNamed(view.group, 'lamp:indicator').count).toBe(4);
    view.update(null, frameWith(4, [hazard], off), 1, true);
    expect(setNamed(view.group, 'lamp:indicator').visible).toBe(false);
    view.dispose();
  });

  it('fades a new agent in over the fade time, but not the agents of the first frame', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = createActorViews(fixture, assets);
    const scale = () => {
      const s = new Vector3();
      new Matrix4().fromArray(setNamed(view.group, 'bus').instanceMatrix.array, 16).decompose(new Vector3(), new Quaternion(), s);
      return s.y;
    };
    view.update(null, frameWith(60, [agent('npc-1', 'bus', 10)], 1), 1, true);
    view.update(null, frameWith(61, [agent('npc-1', 'bus', 10), agent('npc-2', 'bus', 40)], 2), 1, true);
    expect(scale()).toBeLessThan(0.01);
    view.update(null, frameWith(62, [agent('npc-1', 'bus', 10), agent('npc-2', 'bus', 40)], 2 + FADE_S / 2), 1, true);
    expect(scale()).toBeCloseTo(0.5, 6);
    view.update(null, frameWith(63, [agent('npc-1', 'bus', 10), agent('npc-2', 'bus', 40)], 2 + FADE_S), 1, true);
    expect(scale()).toBeCloseTo(1, 6);
    view.dispose();
  });

  it('darkens and tilts a crashed car, lays a fallen motorbike and its rider down, and drops debris', async () => {
    const view = createActorViews(fixture, assets);
    const car = agent('npc-1', 'car', 10, { state: 'crashed', speed: 0 });
    const bike = agent('npc-2', 'motorbike', 30, { state: 'fallen', speed: 0 });
    view.update(null, frameWith(1, [car, bike]), 1, true);
    await settle();
    view.update(null, frameWith(2, [car, bike]), 1, true);
    const body = drawn(view.group).find((m) => m.name.startsWith('kenney:'));
    expect(body).toBeDefined();
    const lookA = /** @type {import('three').InstancedBufferAttribute} */ (body?.geometry.getAttribute('lookA'));
    expect(lookA.getW(0)).toBeLessThan(0.5);
    const q = new Quaternion();
    new Matrix4().fromArray(/** @type {InstancedMesh} */ (body).instanceMatrix.array, 0).decompose(new Vector3(), q, new Vector3());
    // Upright cars keep their up axis vertical; a wreck's is tilted.
    expect(new Vector3(0, 1, 0).applyQuaternion(q).y).toBeLessThan(0.9999);
    const type = MOTORBIKE_TYPES[0];
    expect(setNamed(view.group, `fallen:${type}`).count).toBe(1);
    expect(setNamed(view.group, 'rider:fallen').visible).toBe(true);
    const debris = drawn(view.group).filter((m) => m.name.startsWith('debris:'));
    expect(debris.reduce((n, m) => n + m.count, 0)).toBe(6);
    // A fallen bike lies on its side.
    new Matrix4().fromArray(setNamed(view.group, `fallen:${type}`).instanceMatrix.array, 0).decompose(new Vector3(), q, new Vector3());
    expect(Math.abs(new Vector3(0, 1, 0).applyQuaternion(q).y)).toBeLessThan(1e-6);
    view.dispose();
  });
});

describe('pedestrians', () => {
  it('animates the first scripted pedestrians as skinned figures standing on the ground, the rest as primitives', async () => {
    const ped = /** @type {GameMap['actors'][number]} */ (fixture.actors.find((a) => a.kind === 'pedestrian'));
    const crowd = Array.from({ length: 9 }, (_, i) => ({ ...ped, id: `ped-${i}` }));
    const view = createActorViews({ ...fixture, actors: crowd }, assets);
    await settle();
    const poses = crowd.map((a, i) => /** @type {ActorPose} */ ({ ...agent(a.id, 'car', i * 3), kind: 'pedestrian', model: 'pedestrian', speed: 1.2, lengthM: a.lengthM, widthM: a.widthM }));
    for (let tick = 1; tick <= 20; tick += 1) view.update(null, frameWith(tick, poses), 1, true);
    view.group.updateMatrixWorld(true);
    const roots = view.group.children.filter((c) => c.name.startsWith('pedestrian-'));
    expect(roots).toHaveLength(9);
    const skinned = roots.map((r) => {
      let found = false;
      r.traverse((o) => {
        if (/** @type {import('three').SkinnedMesh} */ (o).isSkinnedMesh) found = true;
      });
      return found;
    });
    expect(skinned).toEqual([true, true, true, true, true, true, true, true, false]);
    // The lower foot of a walking figure touches the ground.
    const feet = ['leg-left', 'leg-right'].map((name) => {
      const leg = /** @type {import('three').Object3D} */ (roots[0].getObjectByName(name));
      return leg.localToWorld(new Vector3(0, -leg.position.y, 0)).y;
    });
    expect(Math.min(...feet)).toBeCloseTo(0, 6);
    view.dispose();
  });
});

describe('paint mask', () => {
  it('paints only the body cells of a Car Kit model, so glass, tyres and lamps keep their colour', async () => {
    const gltf = await loadFile(KENNEY_BODIES.sedan.glb);
    const parts = kenneyParts(gltf, KENNEY_BODIES.sedan.paint);
    const uv = parts.body.getAttribute('uv');
    const paint = parts.body.getAttribute('paint');
    let painted = 0;
    let fixed = 0;
    for (let t = 0; t < uv.count; t += 3) {
      const col = Math.floor(((uv.getX(t) + uv.getX(t + 1) + uv.getX(t + 2)) / 3) * 8);
      const row = Math.floor(((uv.getY(t) + uv.getY(t + 1) + uv.getY(t + 2)) / 3) * 4);
      const p = paint.getX(t);
      if (col === 6 && row === 1) {
        expect(p).toBe(PAINT_BODY);
        painted += 1;
      } else {
        // Glass and tyre cells are among these: dark greys in row 2, lamps in row 3.
        expect(p).toBe(0);
        fixed += 1;
      }
    }
    expect(painted).toBeGreaterThan(50);
    expect(fixed).toBeGreaterThan(50);
    expect(parts.wheel && [...parts.wheel.getAttribute('paint').array].every((x) => x === 0)).toBe(true);
    expect(parts.pivots).toHaveLength(4);
  });

  it('keeps fixed texels under a non-white variant and repaints painted ones', () => {
    const glass = /** @type {[number, number, number]} */ ([0.05, 0.06, 0.08]);
    const red = /** @type {[number, number, number]} */ ([0.6, 0.08, 0.08]);
    const blue = /** @type {[number, number, number, number]} */ ([0.02, 0.1, 0.6, 1]);
    expect(shadeTexel(glass, 0, blue, [1, 1, 1])).toEqual(glass);
    const repainted = shadeTexel(red, PAINT_BODY, blue, [1, 1, 1]);
    expect(repainted[2]).toBeGreaterThan(repainted[0]);
    const keep = shadeTexel(red, PAINT_BODY, [KEEP_PAINT, KEEP_PAINT, KEEP_PAINT, 1], [1, 1, 1]);
    expect(keep).toEqual(red);
    const helmet = shadeTexel([1, 1, 1], PAINT_ACCENT, blue, [0.8, 0, 0]);
    expect(helmet[0]).toBeGreaterThan(helmet[2]);
    const wreck = shadeTexel(glass, 0, [blue[0], blue[1], blue[2], 0.5], [1, 1, 1]);
    expect(wreck[0]).toBeCloseTo(glass[0] / 2, 9);
  });

  it('patches the standard shader with the paint step after the colour map', () => {
    const vertex = patchVertex(ShaderLib.standard.vertexShader);
    const fragment = patchFragment(ShaderLib.standard.fragmentShader);
    expect(vertex).toContain('attribute float paint;');
    expect(vertex).toContain('attribute vec4 lookA;');
    expect(fragment.indexOf('#include <map_fragment>')).toBeLessThan(fragment.indexOf('vLookA.rgb * lookValue'));
    expect(() => patchFragment('void main() {}')).toThrow(/Shader chunk/);
  });
});

describe('procedural models and riders', () => {
  it('builds both motorbikes within 600 to 900 triangles with their two wheels', () => {
    const wheel = triangles(unitWheel());
    for (const type of MOTORBIKE_TYPES) {
      const bike = buildMotorbike(type);
      const total = triangles(bike.body) + wheel * bike.wheels.length;
      expect(total).toBeGreaterThanOrEqual(600);
      expect(total).toBeLessThanOrEqual(900);
      bike.body.computeBoundingBox();
      const box = /** @type {import('three').Box3} */ (bike.body.boundingBox);
      expect(box.max.z - box.min.z).toBeCloseTo(1.9, 1);
      expect(bike.wheels.map((w) => w.z)).toEqual([...bike.wheels.map((w) => w.z)].sort((p, q) => q - p));
    }
  });

  it('builds the bus at its nominal size', () => {
    const bus = buildBus();
    bus.body.computeBoundingBox();
    const box = /** @type {import('three').Box3} */ (bus.body.boundingBox);
    expect(box.max.z - box.min.z).toBeCloseTo(BUS_SIZE.lengthM, 0);
    expect(box.max.x - box.min.x).toBeLessThan(BUS_SIZE.widthM + 0.1);
  });

  it('bakes a seated rider with a helmet onto the seat, and a lying rider on the ground', async () => {
    const gltf = await loadFile(RIDERS[0]);
    const standing = bakePose(gltf, 'static', 0);
    standing.geometry.computeBoundingBox();
    const box = /** @type {import('three').Box3} */ (standing.geometry.boundingBox);
    expect(box.max.y - box.min.y).toBeCloseTo(CHARACTER_HEIGHT_M, 6);
    // Adult proportions: the head is well under a third of the height.
    expect(standing.head.max.y - standing.head.min.y).toBeLessThan(CHARACTER_HEIGHT_M / 3);
    const bike = buildMotorbike('scooter');
    const rider = bakeRider(gltf, 'drive', bike.seat, bike.legPitch);
    const paint = [...rider.getAttribute('paint').array];
    expect(paint).toContain(PAINT_ACCENT);
    rider.computeBoundingBox();
    const r = /** @type {import('three').Box3} */ (rider.boundingBox);
    expect(r.max.y).toBeGreaterThan(1.3);
    expect(r.max.y).toBeLessThan(1.8);
    const lying = bakeFallenRider(gltf);
    lying.computeBoundingBox();
    const l = /** @type {import('three').Box3} */ (lying.boundingBox);
    expect(l.min.y).toBeCloseTo(0, 6);
    expect(l.max.y).toBeLessThan(0.8);
  });

  it('resolves looks deterministically, with both bike types and about a fifth carrying a passenger', () => {
    const pose = { id: 'npc-7', kind: /** @type {const} */ ('motorbike'), model: 'motorbike', variant: 1 };
    expect(resolveLook(pose)).toEqual(resolveLook(pose));
    let passengers = 0;
    const types = new Set();
    for (let i = 0; i < 2000; i += 1) {
      const look = resolveLook({ ...pose, id: `npc-${i}`, variant: i % 3 });
      if (look.passenger) passengers += 1;
      types.add(look.body);
    }
    expect(passengers / 2000).toBeCloseTo(PASSENGER_SHARE, 1);
    expect([...types].sort()).toEqual([...MOTORBIKE_TYPES].sort());
    expect(resolveLook({ id: 'npc-1', kind: 'car', model: 'bus', variant: 0 }).family).toBe('bus');
    expect(resolveLook({ id: 'npc-1', kind: 'car', model: 'npc-sedan', variant: 0 })).toMatchObject({ body: 'taxi', paintA: null });
  });
});
