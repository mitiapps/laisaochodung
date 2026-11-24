/**
 * Actors drawn from frame poses: an instanced traffic view for every vehicle (traffic agents and
 * scripted cars alike) and one view per scripted pedestrian.
 *
 * Vehicles are drawn with one `InstancedMesh` per model and part, rebuilt from the frame's poses
 * every render: an id that leaves the frame simply is not written, and the next id takes its slot.
 * Each pose's look (model, colours, rider, passenger) comes from `resolveLook`. Parts:
 *
 * - Kenney Car Kit bodies (CC0) and their wheels, shared between bodies with the same wheel mesh;
 *   a generated box car stands in until a GLB loads, or for good when it fails;
 * - procedural motorbikes, each type merged with a baked Mini Characters rider (one mesh per type
 *   and rider), a pillion passenger, and their wheels;
 * - the procedural bus;
 * - brake and indicator lamps, emissive quads driven by `pose.lights` (indicators blink on the
 *   frame time);
 * - wrecks: a `crashed` car is darkened and tilted, a `fallen` motorbike lies on its side with
 *   its rider lying beside it, and Car Kit debris lies where the wreck happened.
 *
 * A new id fades in by scaling up from its ground point over `FADE_S` (no transparent pass). Paint
 * colours touch only the paint texels (`vehicles/look-material.js`).
 */

import {
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { DT } from '../contracts/units.js';
import { loadModel, loadTexture } from './assets.js';
import { interpolateActor } from './interpolate.js';
import { blinkOn, headingToYaw } from './math.js';
import { bakeFallenRider, bakeRider } from './rider-bake.js';
import { createPedestrianView, MODEL_YAW } from './vehicle-view.js';
import { BUS_SIZE, buildBus } from './vehicles/bus.js';
import { DEBRIS, KENNEY_BODIES, PASSENGER, RIDERS, WALKERS, actorModel, hashId, resolveLook } from './vehicles/index.js';
import { boxCarParts, kenneyParts } from './vehicles/kenney.js';
import { createLookMaterial, lookRgb } from './vehicles/look-material.js';
import { MOTORBIKE_LENGTH_M, MOTORBIKE_TYPES, buildMotorbike } from './vehicles/motorbike.js';
import { PALETTE_TEXTURE, merge, unitWheel } from './vehicles/procedural.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./interpolate.js').DrawPose} DrawPose */
/** @typedef {import('./vehicles/kenney.js').WheelPivot} WheelPivot */
/** @typedef {import('./vehicles/index.js').Look} Look */
/** @typedef {import('three/addons/loaders/GLTFLoader.js').GLTF} GLTF */

/** Stride length of the walk cycle in metres (a drawing choice). */
const STRIDE_M = 1.4;
/** Fade-in time of a new agent, seconds. */
export const FADE_S = 0.5;
/** Most scripted pedestrians drawn as skinned, animated figures; the rest stay primitive. */
export const MAX_SKINNED_PEDESTRIANS = 8;
/** Shade of a wrecked car (1 is unchanged). */
const WRECK_SHADE = 0.45;
/** Shade of a fallen motorbike. */
const FALLEN_SHADE = 0.8;
/** Debris pieces dropped by one wreck. */
const DEBRIS_PER_WRECK = 3;
/** Scale of Car Kit debris, matching the kit's cars fitted to real sizes. */
const DEBRIS_SCALE = 1.7;
/** Car Kit colour map, shared by every Kenney body, wheel and debris piece. */
const CAR_KIT_TEXTURE = 'models/car-kit/Textures/colormap.png';
/** Colour of lit brake lamps and indicators (sRGB). */
const BRAKE_LIT = 0xff2a1a;
const INDICATOR_LIT = 0xffa000;

/**
 * @typedef {object} ActorAssets
 * @property {(path: string) => Promise<GLTF>} loadModel GLB loader.
 * @property {(path: string) => Promise<import('three').Texture>} loadTexture Colour-map loader.
 */

/** @type {ActorAssets} */
const DEFAULT_ASSETS = { loadModel, loadTexture };

/**
 * @typedef {object} ActorViews
 * @property {Group} group Meshes.
 * @property {(prev: Frame | null, frame: Frame, alpha: number, newTick: boolean) => void} update Pose every actor.
 * @property {() => void} reset Forget accumulated wheel and walk phases, fades and wrecks.
 * @property {() => void} dispose Free resources.
 */

/**
 * One instanced mesh: a model part drawn once per instance written this frame.
 */
class InstancedSet {
  /**
   * @param {string} name Name (`model:part`).
   * @param {BufferGeometry} geometry Geometry (owned).
   * @param {import('three').Material} material Material (shared, not owned).
   * @param {number} capacity Most instances.
   * @param {boolean} look Carries the look attributes (`lookA`, `lookB`).
   */
  constructor(name, geometry, material, capacity, look) {
    this.capacity = capacity;
    this.look = look;
    this.n = 0;
    this.warned = false;
    this.lookA = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.lookB = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.lookA.setUsage(DynamicDrawUsage);
    this.lookB.setUsage(DynamicDrawUsage);
    this.mesh = new InstancedMesh(this.prepare(geometry), material, capacity);
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = look;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /**
   * Adds the look attributes to a geometry.
   * @param {BufferGeometry} geometry Geometry.
   * @returns {BufferGeometry} Same geometry.
   */
  prepare(geometry) {
    if (this.look) {
      geometry.setAttribute('lookA', this.lookA);
      geometry.setAttribute('lookB', this.lookB);
    }
    return geometry;
  }

  /**
   * Whether the geometry has anything to draw.
   * @returns {boolean} Drawable.
   */
  get drawable() {
    return (this.mesh.geometry.getAttribute('position')?.count ?? 0) > 0;
  }

  /**
   * Replaces the geometry (a model finished loading) and optionally the material.
   * @param {BufferGeometry} geometry New geometry (owned).
   * @param {import('three').Material} [material] New material.
   */
  setGeometry(geometry, material) {
    const old = this.mesh.geometry;
    this.mesh.geometry = this.prepare(geometry);
    old.dispose();
    if (material) this.mesh.material = material;
  }

  begin() {
    this.n = 0;
  }

  /**
   * Writes one instance.
   * @param {Matrix4} matrix World matrix.
   * @param {[number, number, number]} a Body paint (linear RGB or the keep sentinel).
   * @param {number} shade Shade.
   * @param {[number, number, number]} b Second paint.
   */
  push(matrix, a, shade, b) {
    if (this.n >= this.capacity) {
      if (!this.warned) console.error(`Actors: more than ${this.capacity} instances of ${this.mesh.name}; the rest are not drawn.`);
      this.warned = true;
      return;
    }
    const i = this.n;
    this.mesh.setMatrixAt(i, matrix);
    if (this.look) {
      this.lookA.setXYZW(i, a[0], a[1], a[2], shade);
      this.lookB.setXYZ(i, b[0], b[1], b[2]);
    }
    this.n += 1;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0 && this.drawable;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.look) {
        this.lookA.needsUpdate = true;
        this.lookB.needsUpdate = true;
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/**
 * Body of a Kenney model key: its fit box, wheel set and pivots, swapped from the box car when
 * the GLB loads.
 * @typedef {object} KenneyState
 * @property {InstancedSet} body Body set.
 * @property {import('three').Box3} box Model bounds in native units.
 * @property {string} wheelSet Wheel set name.
 * @property {WheelPivot[]} pivots Wheel pivots in native units.
 * @property {number} wheelRadius Native wheel radius (for spin).
 * @property {[number, number, number] | null} unitWheelScale Native unit-wheel scale (width,
 *   radius, radius) of the box car, or null for a GLB wheel mesh.
 */

/**
 * Per-id state kept between frames.
 * @typedef {object} AgentState
 * @property {Look} look Look.
 * @property {number} lookKey `variant` and model the look was resolved for.
 * @property {number} distance Distance travelled, metres (wheel spin).
 * @property {number} fadeFrom Frame time the fade-in started; -Infinity for no fade.
 * @property {number} sign ±1 from the id: side a wreck tilts or falls to.
 * @property {{x: number, z: number} | null} wreck Where it crashed or fell.
 * @property {number} walk Walk phase (pedestrians).
 */

/**
 * Builds the actor views of a map.
 * @param {GameMap} map Map.
 * @returns {ActorViews} Views.
 */
export function buildActors(map) {
  return createActorViews(map, DEFAULT_ASSETS);
}

/**
 * Builds the actor views of a map with the given asset loaders (tests pass file loaders).
 * @param {GameMap} map Map.
 * @param {ActorAssets} assets Loaders.
 * @returns {ActorViews} Views.
 */
export function createActorViews(map, assets) {
  const group = new Group();
  group.name = 'actors';
  const vehicles = new Group();
  vehicles.name = 'vehicles';
  group.add(vehicles);
  const capacity = Math.max(1, (map.traffic?.maxAgents ?? 0) + map.actors.length);
  let disposed = false;

  /**
   * Logs a failed load; the stand-in stays.
   * @param {string} what What failed.
   * @returns {(err: unknown) => void} Handler.
   */
  const failed = (what) => (err) => {
    console.error(`${what}: ${err instanceof Error ? err.message : String(err)}; keeping the stand-in.`);
  };

  const palette = createLookMaterial();
  const carKit = createLookMaterial();
  assets
    .loadTexture(PALETTE_TEXTURE)
    .then((t) => {
      palette.map = t;
      palette.needsUpdate = true;
    })
    .catch(failed(`Texture ${PALETTE_TEXTURE}`));
  assets
    .loadTexture(CAR_KIT_TEXTURE)
    .then((t) => {
      carKit.map = t;
      carKit.needsUpdate = true;
    })
    .catch(failed(`Texture ${CAR_KIT_TEXTURE}`));
  const brakeMaterial = new MeshBasicMaterial({ color: BRAKE_LIT, side: DoubleSide, toneMapped: false });
  const indicatorMaterial = new MeshBasicMaterial({ color: INDICATOR_LIT, side: DoubleSide, toneMapped: false });
  const lampQuad = new PlaneGeometry(1, 1);

  /** @type {Map<string, InstancedSet>} */
  const sets = new Map();
  /**
   * The set of a name, created on first use.
   * @param {string} name Name.
   * @param {() => BufferGeometry} geometry Initial geometry.
   * @param {import('three').Material} material Material.
   * @param {number} perAgent Instances per agent.
   * @param {boolean} [look] Look attributes (false for lamps).
   * @returns {InstancedSet} Set.
   */
  const set = (name, geometry, material, perAgent, look = true) => {
    let s = sets.get(name);
    if (!s) {
      s = new InstancedSet(name, geometry(), material, capacity * perAgent, look);
      sets.set(name, s);
      vehicles.add(s.mesh);
    }
    return s;
  };
  const unitWheels = () => set('wheel:unit', unitWheel, palette, 6);

  /** @type {Map<string, KenneyState>} */
  const kenney = new Map();
  /**
   * State of a Kenney body, created (and its GLB requested) on first use.
   * @param {string} key `KENNEY_BODIES` key.
   * @returns {KenneyState} State.
   */
  const kenneyState = (key) => {
    const known = kenney.get(key);
    if (known) return known;
    const spec = KENNEY_BODIES[key];
    const box = boxCarParts();
    const state = /** @type {KenneyState} */ ({
      body: set(`kenney:${key}`, () => box.body, palette, 1),
      box: box.box,
      wheelSet: 'wheel:unit',
      pivots: box.pivots,
      wheelRadius: box.wheelRadius,
      unitWheelScale: [box.wheelWidth, box.wheelRadius, box.wheelRadius],
    });
    kenney.set(key, state);
    assets
      .loadModel(spec.glb)
      .then((gltf) => {
        if (disposed) return;
        const parts = kenneyParts(gltf, spec.paint);
        state.body.setGeometry(parts.body, carKit);
        state.box = parts.box;
        if (parts.wheel) {
          const wheel = parts.wheel;
          const name = `wheel:${wheelFingerprint(wheel)}`;
          set(name, () => wheel, carKit, 4);
          if (sets.get(name)?.mesh.geometry !== wheel) wheel.dispose();
          state.wheelSet = name;
          state.pivots = parts.pivots;
          state.wheelRadius = Math.max(0.05, parts.pivots[0].y);
          state.unitWheelScale = null;
        } else {
          state.pivots = [];
        }
      })
      .catch(failed(`Model ${spec.glb}`));
    return state;
  };

  // Motorbikes, passengers, fallen bikes and the lying rider. Bike geometry is drawn at once;
  // riders join it when their character loads.
  const bikes = new Map(MOTORBIKE_TYPES.map((type) => [type, buildMotorbike(type)]));
  /**
   * Set of a ridden motorbike type and rider.
   * @param {import('./vehicles/motorbike.js').MotorbikeType} type Type.
   * @param {number} rider Rider index.
   * @returns {InstancedSet} Set.
   */
  const riddenSet = (type, rider) => {
    const name = `bike:${type}:${rider}`;
    const existing = sets.get(name);
    if (existing) return existing;
    const s = set(name, () => buildMotorbike(type).body, palette, 1);
    const bike = /** @type {import('./vehicles/motorbike.js').MotorbikeModel} */ (bikes.get(type));
    assets
      .loadModel(RIDERS[rider])
      .then((gltf) => {
        if (disposed) return;
        s.setGeometry(merge([buildMotorbike(type).body, bakeRider(gltf, 'drive', bike.seat, bike.legPitch)]));
      })
      .catch(failed(`Rider ${RIDERS[rider]}`));
    return s;
  };
  /**
   * Passenger set of a motorbike type (empty until the character loads).
   * @param {import('./vehicles/motorbike.js').MotorbikeType} type Type.
   * @returns {InstancedSet} Set.
   */
  const pillionSet = (type) => {
    const name = `pillion:${type}`;
    const existing = sets.get(name);
    if (existing) return existing;
    const s = set(name, () => new BufferGeometry(), palette, 1);
    const bike = /** @type {import('./vehicles/motorbike.js').MotorbikeModel} */ (bikes.get(type));
    assets
      .loadModel(PASSENGER)
      .then((gltf) => {
        if (disposed) return;
        s.setGeometry(bakeRider(gltf, 'sit', bike.pillion, bike.legPitch));
      })
      .catch(failed(`Passenger ${PASSENGER}`));
    return s;
  };
  /** @returns {InstancedSet} Lying rider set (empty until the character loads). */
  const lyingSet = () => {
    const existing = sets.get('rider:fallen');
    if (existing) return existing;
    const s = set('rider:fallen', () => new BufferGeometry(), palette, 1);
    assets
      .loadModel(RIDERS[0])
      .then((gltf) => {
        if (disposed) return;
        s.setGeometry(bakeFallenRider(gltf));
      })
      .catch(failed(`Rider ${RIDERS[0]}`));
    return s;
  };
  const bus = buildBus();
  const busSet = () => set('bus', () => buildBus().body, palette, 1);

  /** @type {{set: () => InstancedSet, box: import('three').Box3 | null}[]} */
  const debris = DEBRIS.map((path, i) => {
    const entry = {
      box: /** @type {import('three').Box3 | null} */ (null),
      set: () => {
        const name = `debris:${i}`;
        const existing = sets.get(name);
        if (existing) return existing;
        const s = set(name, () => new BufferGeometry(), carKit, 1);
        assets
          .loadModel(path)
          .then((gltf) => {
            if (disposed) return;
            const parts = kenneyParts(gltf, []);
            entry.box = parts.box;
            s.setGeometry(parts.body);
          })
          .catch(failed(`Debris ${path}`));
        return s;
      },
    };
    return entry;
  });

  const brakeLamps = () => set('lamp:brake', () => lampQuad.clone(), brakeMaterial, 2, false);
  const indicatorLamps = () => set('lamp:indicator', () => lampQuad.clone(), indicatorMaterial, 4, false);

  // Scripted pedestrians: one view each, the first few skinned.
  /** @type {Map<string, import('./vehicle-view.js').PedestrianView>} */
  const pedestrians = new Map();
  let walkers = 0;
  for (const actor of map.actors) {
    if (actor.kind !== 'pedestrian') continue;
    const character = walkers < MAX_SKINNED_PEDESTRIANS ? WALKERS[walkers % WALKERS.length] : null;
    walkers += 1;
    const view = createPedestrianView(actorModel(actor.model, 'pedestrian'), actor.lengthM, actor.widthM, {
      character,
      load: assets.loadModel,
    });
    group.add(view.root);
    pedestrians.set(actor.id, view);
  }

  /** @type {Map<string, AgentState>} */
  const agents = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  let fresh = true;

  // Scratch objects.
  const base = new Matrix4();
  const m = new Matrix4();
  const part = new Matrix4();
  const frameM = new Matrix4();
  const bodyM = new Matrix4();
  const c3 = new Vector3();
  const q = new Quaternion();
  const v = new Vector3();
  const s3 = new Vector3();
  const Y = new Vector3(0, 1, 0);
  const white = /** @type {[number, number, number]} */ ([1, 1, 1]);

  /**
   * State of a pose, created on its first frame.
   * @param {ActorPose} pose Pose.
   * @param {number} t Frame time.
   * @returns {AgentState} State.
   */
  const stateOf = (pose, t) => {
    const key = pose.variant * 7919 + hashId(pose.model);
    let st = agents.get(pose.id);
    if (!st) {
      st = {
        look: resolveLook(pose),
        lookKey: key,
        distance: 0,
        fadeFrom: fresh ? -Infinity : t,
        sign: hashId(pose.id) % 2 === 0 ? 1 : -1,
        wreck: null,
        walk: 0,
      };
      agents.set(pose.id, st);
    } else if (st.lookKey !== key) {
      st.look = resolveLook(pose);
      st.lookKey = key;
    }
    return st;
  };

  /**
   * Base matrix of a pose: ground position, heading, an optional roll and pitch, the Kenney
   * frame turn and the fade scale.
   * @param {DrawPose} draw Draw pose.
   * @param {number} roll Roll about the forward axis (positive lifts the left side).
   * @param {number} pitch Pitch (positive lifts the nose).
   * @param {number} lift Height above the ground.
   * @param {number} fade Scale 0..1.
   * @returns {Matrix4} `base`.
   */
  const baseMatrix = (draw, roll, pitch, lift, fade) => {
    base.makeRotationY(headingToYaw(draw.heading));
    if (roll !== 0 || pitch !== 0) base.multiply(m.makeRotationX(roll)).multiply(m.makeRotationZ(pitch));
    base.multiply(m.makeRotationY(MODEL_YAW));
    base.setPosition(draw.x, lift, draw.z);
    return base.multiply(m.makeScale(fade, fade, fade));
  };

  /**
   * Writes a lamp quad.
   * @param {InstancedSet} target Lamp set.
   * @param {Matrix4} frame Model frame in metres (Kenney axes).
   * @param {number} x Left.
   * @param {number} y Height.
   * @param {number} z Along.
   * @param {number} w Quad width.
   * @param {number} h Quad height.
   */
  const lamp = (target, frame, x, y, z, w, h) => {
    q.setFromAxisAngle(Y, z < 0 ? Math.PI : 0);
    part.compose(v.set(x, y, z), q, s3.set(w, h, 1));
    target.push(m.multiplyMatrices(frame, part), white, 1, white);
  };

  /**
   * Draws the lamps of a pose from metre positions in its model frame.
   * @param {ActorPose} pose Pose.
   * @param {Matrix4} frame Model frame in metres.
   * @param {{brake: number[][], left: number[][], right: number[][]}} at Lamp positions.
   * @param {number} size Lamp size factor.
   * @param {number} t Frame time.
   */
  const lamps = (pose, frame, at, size, t) => {
    const lit = pose.lights;
    if (lit.brake) for (const p of at.brake) lamp(brakeLamps(), frame, p[0], p[1], p[2], 0.28 * size, 0.13 * size);
    const blink = blinkOn(t);
    if (blink && lit.left) for (const p of at.left) lamp(indicatorLamps(), frame, p[0], p[1], p[2], 0.12 * size, 0.08 * size);
    if (blink && lit.right) for (const p of at.right) lamp(indicatorLamps(), frame, p[0], p[1], p[2], 0.12 * size, 0.08 * size);
  };

  /**
   * Car lamp positions in metres for a footprint and body height.
   * @param {number} L Length.
   * @param {number} W Width.
   * @param {number} H Body height.
   * @returns {{brake: number[][], left: number[][], right: number[][]}} Positions.
   */
  const carLamps = (L, W, H) => {
    const y = Math.min(1.0, H * 0.48);
    const xb = W / 2 - 0.22;
    const xi = W / 2 - 0.08;
    const zr = -L / 2 - 0.03;
    const zf = L / 2 + 0.03;
    return {
      brake: [
        [xb, y, zr],
        [-xb, y, zr],
      ],
      left: [
        [xi, y + 0.13, zr],
        [xi, Math.min(0.75, H * 0.38), zf],
      ],
      right: [
        [-xi, y + 0.13, zr],
        [-xi, Math.min(0.75, H * 0.38), zf],
      ],
    };
  };

  /**
   * Draws a Kenney car (or its box-car stand-in).
   * @param {ActorPose} pose Pose.
   * @param {AgentState} st State.
   * @param {DrawPose} draw Draw pose.
   * @param {number} fade Fade scale.
   * @param {number} t Frame time.
   */
  const drawCar = (pose, st, draw, fade, t) => {
    const k = kenneyState(st.look.body);
    const size = k.box.getSize(v);
    const sx = pose.widthM / size.x;
    const sz = pose.lengthM / size.z;
    const sy = Math.sqrt(sx * sz);
    const height = size.y * sy;
    const centre = k.box.getCenter(c3);
    const crashed = pose.state === 'crashed';
    const metres = frameM.copy(baseMatrix(draw, crashed ? 0.07 * st.sign : 0, crashed ? -0.03 : 0, 0, fade));
    const body = bodyM
      .copy(metres)
      .multiply(m.makeScale(sx, sy, sz))
      .multiply(m.makeTranslation(-centre.x, -k.box.min.y, -centre.z));
    const paint = lookRgb(st.look.paintA);
    const shade = crashed ? WRECK_SHADE : 1;
    k.body.push(body, paint, shade, white);
    const wheels = /** @type {InstancedSet} */ (sets.get(k.wheelSet) ?? unitWheels());
    const spin = crashed ? 0 : st.distance / (k.wheelRadius * sy);
    for (const p of k.pivots) {
      part.copy(body).multiply(m.makeTranslation(p.x, p.y, p.z));
      if (p.right) part.multiply(m.makeRotationY(Math.PI));
      part.multiply(m.makeRotationX(p.right ? -spin : spin));
      if (k.unitWheelScale) part.multiply(m.makeScale(...k.unitWheelScale));
      wheels.push(part, paint, shade, white);
    }
    if (!crashed) lamps(pose, metres, carLamps(pose.lengthM, pose.widthM, height), 1, t);
  };

  /**
   * Draws a motorbike with its rider, passenger and lamps, or lying on its side when fallen.
   * @param {ActorPose} pose Pose.
   * @param {AgentState} st State.
   * @param {DrawPose} draw Draw pose.
   * @param {number} fade Fade scale.
   * @param {number} t Frame time.
   */
  const drawBike = (pose, st, draw, fade, t) => {
    const type = /** @type {import('./vehicles/motorbike.js').MotorbikeType} */ (st.look.body);
    const bike = /** @type {import('./vehicles/motorbike.js').MotorbikeModel} */ (bikes.get(type));
    const k = pose.lengthM / MOTORBIKE_LENGTH_M;
    const fallen = pose.state === 'fallen';
    const paintA = lookRgb(st.look.paintA);
    const paintB = lookRgb(st.look.paintB);
    const scaled = bodyM.copy(baseMatrix(draw, fallen ? (Math.PI / 2) * st.sign : 0, 0, fallen ? 0.2 * k : 0, fade)).multiply(m.makeScale(k, k, k));
    const shade = fallen ? FALLEN_SHADE : 1;
    if (fallen) {
      set(`fallen:${type}`, () => buildMotorbike(type).body, palette, 1).push(scaled, paintA, shade, paintB);
      // The rider lies a body length ahead, turned by the id.
      const lying = baseMatrix(draw, 0, 0, 0, fade).multiply(m.makeTranslation(-0.6 * st.sign, 0, 1.3)).multiply(m.makeRotationY(0.8 * st.sign));
      lyingSet().push(lying, paintA, 1, paintB);
    } else {
      riddenSet(type, st.look.rider).push(scaled, paintA, 1, paintB);
      if (st.look.passenger) pillionSet(type).push(scaled, paintA, 1, paintB);
    }
    const wheels = unitWheels();
    for (const w of bike.wheels) {
      const spin = fallen ? 0 : st.distance / (w.radius * k);
      part.copy(scaled).multiply(m.makeTranslation(0, w.radius, w.z)).multiply(m.makeRotationX(spin)).multiply(m.makeScale(w.width, w.radius, w.radius));
      wheels.push(part, paintA, shade, paintB);
    }
    if (!fallen) lamps(pose, scaled, bike.lamps, 0.5, t);
  };

  /**
   * Draws the bus.
   * @param {ActorPose} pose Pose.
   * @param {AgentState} st State.
   * @param {DrawPose} draw Draw pose.
   * @param {number} fade Fade scale.
   * @param {number} t Frame time.
   */
  const drawBus = (pose, st, draw, fade, t) => {
    const crashed = pose.state === 'crashed';
    const fit = bodyM
      .copy(baseMatrix(draw, crashed ? 0.04 * st.sign : 0, 0, 0, fade))
      .multiply(m.makeScale(pose.widthM / BUS_SIZE.widthM, 1, pose.lengthM / BUS_SIZE.lengthM));
    const shade = crashed ? WRECK_SHADE : 1;
    const keep = lookRgb(null);
    busSet().push(fit, keep, shade, keep);
    const wheels = unitWheels();
    for (const w of bus.wheels) {
      const spin = crashed ? 0 : st.distance / w.radius;
      for (const side of [1, -1]) {
        const x = side * (BUS_SIZE.widthM / 2 - w.width / 2 - 0.04);
        part.copy(fit).multiply(m.makeTranslation(x, w.radius, w.z)).multiply(m.makeRotationX(spin)).multiply(m.makeScale(w.width, w.radius, w.radius));
        wheels.push(part, keep, shade, keep);
      }
    }
    if (!crashed) lamps(pose, fit, bus.lamps, 1, t);
  };

  /**
   * Draws the debris of a wreck around the point where it happened.
   * @param {string} id Wreck id.
   * @param {{x: number, z: number}} at Wreck point.
   */
  const drawDebris = (id, at) => {
    const seed = hashId(`${id}:debris`);
    for (let j = 0; j < DEBRIS_PER_WRECK; j += 1) {
      const d = debris[j % debris.length];
      const target = d.set();
      const h = Math.imul(seed + j * 0x9e3779b1, 0x85ebca6b) >>> 0;
      const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
      const r = 0.8 + ((h >>> 16) / 0x10000) * 1.6;
      const minY = d.box ? d.box.min.y : 0;
      q.setFromAxisAngle(Y, angle * 1.7);
      part.compose(v.set(at.x + Math.cos(angle) * r, -minY * DEBRIS_SCALE, at.z + Math.sin(angle) * r), q, s3.set(DEBRIS_SCALE, DEBRIS_SCALE, DEBRIS_SCALE));
      const keep = lookRgb(null);
      target.push(part, keep, 1, keep);
    }
  };

  return {
    group,
    update(prev, frame, alpha, newTick) {
      const t = frame.t;
      if (newTick) seen.clear();
      for (const s of sets.values()) s.begin();
      for (const pose of frame.actors) {
        const st = stateOf(pose, t);
        if (newTick) {
          seen.add(pose.id);
          st.distance += pose.speed * DT;
          if (pose.kind === 'pedestrian') st.walk += (pose.speed * DT * 2 * Math.PI) / STRIDE_M;
          if ((pose.state === 'crashed' || pose.state === 'fallen') && !st.wreck) st.wreck = { x: pose.pos.x, z: pose.pos.z };
          if (pose.state === 'moving') st.wreck = null;
        }
        const draw = interpolateActor(prev, frame, pose, alpha);
        if (pose.kind === 'pedestrian') {
          pedestrians.get(pose.id)?.update(draw, pose.speed > 0 ? st.walk : 0, t);
          continue;
        }
        const u = Math.min(1, Math.max(0, (t - st.fadeFrom) / FADE_S));
        const fade = Math.max(1e-3, u * u * (3 - 2 * u));
        if (st.look.family === 'bike') drawBike(pose, st, draw, fade, t);
        else if (st.look.family === 'bus') drawBus(pose, st, draw, fade, t);
        else drawCar(pose, st, draw, fade, t);
        if (st.wreck) drawDebris(pose.id, st.wreck);
      }
      for (const s of sets.values()) s.end();
      if (newTick) {
        for (const id of agents.keys()) if (!seen.has(id)) agents.delete(id);
        fresh = false;
      }
    },
    reset() {
      agents.clear();
      seen.clear();
      fresh = true;
      for (const s of sets.values()) {
        s.begin();
        s.end();
      }
    },
    dispose() {
      disposed = true;
      for (const s of sets.values()) s.dispose();
      sets.clear();
      for (const b of bikes.values()) b.body.dispose();
      bus.body.dispose();
      for (const view of pedestrians.values()) view.dispose();
      palette.dispose();
      carKit.dispose();
      brakeMaterial.dispose();
      indicatorMaterial.dispose();
      lampQuad.dispose();
    },
  };
}

/**
 * Identity of a wheel mesh, so Car Kit bodies with the same wheel share one wheel set.
 * @param {BufferGeometry} geometry Wheel geometry.
 * @returns {string} Fingerprint.
 */
export function wheelFingerprint(geometry) {
  const pos = geometry.getAttribute('position');
  let sum = 0;
  for (let i = 0; i < pos.count; i += 1) sum += pos.getX(i) * 1.3 + pos.getY(i) * 1.7 + pos.getZ(i) * 2.1;
  return `${pos.count}:${sum.toFixed(3)}`;
}
