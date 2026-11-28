/**
 * Drawable vehicles (player and NPC cars) and pedestrians. A view starts as a generated box or
 * primitive model sized to the footprint and upgrades to its GLB when the model loads, so a
 * missing or broken model never blocks drawing.
 *
 * Node layout: `root` (ground position, `rotation.y = heading`, +X forward) → `lean` (roll) →
 * `model` (turns the Kenney frame, front +Z and left +X, to +X forward) → `body` (the body, wheels
 * and rider, hidden in the cockpit view) and the lamps. `mount` adds objects to `lean` (the
 * cockpit), so they roll with a motorbike.
 */

import {
  AnimationMixer,
  Box3,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  SpotLight,
  Vector3,
  AdditiveBlending,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadModel, loadTexture } from './assets.js';
import { blinkOn, headingToYaw, leanAngle, leanToRoll, wheelOffsets } from './math.js';
import { SKINNED_PROPORTIONS, applyProportions, bakeRider, characterFit } from './rider-bake.js';
import { RIDERS } from './vehicles/index.js';
import { createLookMaterial, setSingleLook } from './vehicles/look-material.js';
import { buildMotorbike, MOTORBIKE_LENGTH_M } from './vehicles/motorbike.js';
import { PALETTE_TEXTURE, unitWheel } from './vehicles/procedural.js';
import { TRIPO_MODELS, tripoParts } from './vehicles/tripo.js';

/** @typedef {import('./vehicles/model-config.js').ModelConfig} ModelConfig */
/** @typedef {import('../contracts/telemetry.js').EgoState} EgoState */
/** @typedef {import('./interpolate.js').DrawPose} DrawPose */

/** Kenney frame to +X forward: rotating +Z by π/2 about +Y gives +X. */
export const MODEL_YAW = Math.PI / 2;
/** Helmet colour of the player's rider (a drawing choice). */
const EGO_HELMET = 0xf2f2f0;

/**
 * @typedef {object} VehicleOptions
 * @property {ModelConfig} config Model config.
 * @property {number} lengthM Footprint length.
 * @property {number} widthM Footprint width.
 * @property {boolean} lamps Draw working lamps and headlight beams (player only).
 */

/**
 * @typedef {object} LampState
 * @property {boolean} brake Brake lamps lit.
 * @property {boolean} left Left indicators lit.
 * @property {boolean} right Right indicators lit.
 * @property {'off' | 'low' | 'high'} head Headlight mode.
 * @property {number} night 0 by day … 1 by night, scales the beam glow.
 */

/**
 * Shared geometry and materials for generated parts; one set per view keeps disposal simple.
 */
class PartKit {
  constructor() {
    /** @type {{dispose: () => void}[]} */
    this.owned = [];
  }

  /**
   * @template {{dispose: () => void}} T
   * @param {T} resource Geometry or material.
   * @returns {T} Same resource, registered for disposal.
   */
  own(resource) {
    this.owned.push(resource);
    return resource;
  }

  /**
   * Box mesh in the Kenney frame.
   * @param {number} sx Width (local X).
   * @param {number} sy Height.
   * @param {number} sz Length (local Z).
   * @param {import('three').Material} material Material.
   * @param {[number, number, number]} at Centre.
   * @returns {Mesh} Mesh.
   */
  box(sx, sy, sz, material, at) {
    const m = new Mesh(this.own(new BoxGeometry(sx, sy, sz)), material);
    m.position.set(...at);
    return m;
  }

  dispose() {
    for (const r of this.owned) r.dispose();
    this.owned.length = 0;
  }
}

/**
 * A wheel pivot with a generated tyre whose axle is local X.
 * @param {PartKit} kit Part kit.
 * @param {number} radius Radius.
 * @param {number} width Tyre width.
 * @param {import('three').Material} material Tyre material.
 * @returns {Group} Pivot; spin is `rotation.x`, steer `rotation.y`.
 */
function generatedWheel(kit, radius, width, material) {
  const pivot = new Group();
  pivot.rotation.order = 'YXZ';
  const tyre = new Mesh(kit.own(new CylinderGeometry(radius, radius, width, 12)), material);
  tyre.rotation.z = Math.PI / 2;
  pivot.add(tyre);
  // A light hub stripe makes the spin visible.
  const hub = new Mesh(kit.own(new BoxGeometry(width * 1.05, radius * 1.4, radius * 0.25)), kit.own(new MeshStandardMaterial({ color: 0x9a9a9a })));
  pivot.add(hub);
  return pivot;
}

/**
 * Wheel pivot positions in the Kenney frame (x left, z forward), in `WheelState` order.
 * @param {'car' | 'motorbike'} kind Kind.
 * @param {number} lengthM Length.
 * @param {number} widthM Width.
 * @param {number} radius Wheel radius.
 * @returns {[number, number, number][]} Positions.
 */
export function wheelPivots(kind, lengthM, widthM, radius) {
  return wheelOffsets(kind === 'car' ? 'car' : 'motorbike', lengthM, widthM).map(([along, left]) => [
    left,
    radius,
    along,
  ]);
}

/**
 * Builds the box car fallback.
 * @param {PartKit} kit Part kit.
 * @param {ModelConfig} config Config.
 * @param {number} L Length.
 * @param {number} W Width.
 * @returns {{content: Group, wheels: Object3D[]}} Content and wheel pivots.
 */
function boxCar(kit, config, L, W) {
  const content = new Group();
  const paint = kit.own(new MeshStandardMaterial({ color: config.color, roughness: 0.45, metalness: 0.2 }));
  const glass = kit.own(new MeshStandardMaterial({ color: 0x1d2a35, roughness: 0.2, metalness: 0.4 }));
  const tyreMat = kit.own(new MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
  const r = config.wheelRadiusM;
  const lower = config.heightM * 0.5;
  content.add(kit.box(W, lower, L, paint, [0, r * 0.7 + lower / 2, 0]));
  content.add(kit.box(W * 0.86, config.heightM - lower - r * 0.7, L * 0.5, glass, [0, r * 0.7 + lower + (config.heightM - lower - r * 0.7) / 2, -L * 0.05]));
  const wheels = wheelPivots('car', L, W, r).map((p) => {
    const w = generatedWheel(kit, r, 0.22, tyreMat);
    w.position.set(p[0], p[1], p[2]);
    content.add(w);
    return w;
  });
  return { content, wheels };
}

/**
 * Builds the primitive scooter: floorboard, rear body, seat, front shield, column and handlebar.
 * @param {PartKit} kit Part kit.
 * @param {ModelConfig} config Config.
 * @param {number} L Length.
 * @param {number} W Width (handlebar span).
 * @returns {{content: Group, wheels: Object3D[]}} Content and wheel pivots.
 */
function primitiveScooter(kit, config, L, W) {
  const content = new Group();
  const paint = kit.own(new MeshStandardMaterial({ color: config.color, roughness: 0.4, metalness: 0.2 }));
  const dark = kit.own(new MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }));
  const chrome = kit.own(new MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.3, metalness: 0.8 }));
  const r = config.wheelRadiusM;
  const [front, rear] = wheelPivots('motorbike', L, W, r);
  content.add(kit.box(0.3, 0.1, L * 0.42, dark, [0, r + 0.05, (front[2] + rear[2]) / 2 + 0.02]));
  content.add(kit.box(0.34, 0.42, L * 0.36, paint, [0, r + 0.3, rear[2] + L * 0.12]));
  content.add(kit.box(0.28, 0.1, L * 0.33, dark, [0, r + 0.56, rear[2] + L * 0.14]));
  const shield = kit.box(0.38, 0.72, 0.12, paint, [0, r + 0.42, front[2] - 0.18]);
  shield.rotation.x = -0.25;
  content.add(shield);
  const column = new Mesh(kit.own(new CylinderGeometry(0.03, 0.03, config.heightM - r, 8)), chrome);
  column.position.set(0, r + (config.heightM - r) / 2, front[2] - 0.1);
  column.rotation.x = -0.3;
  content.add(column);
  content.add(kit.box(Math.min(W, 0.72), 0.04, 0.05, chrome, [0, config.heightM, front[2] - 0.26]));
  const tyreMat = kit.own(new MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
  const wheels = [front, rear].map((p) => {
    const w = generatedWheel(kit, r, 0.1, tyreMat);
    w.position.set(p[0], p[1], p[2]);
    content.add(w);
    return w;
  });
  return { content, wheels };
}

/**
 * Builds the procedural motorbike of a config with its rider, scaled to the footprint length.
 * The palette texture and the rider load asynchronously; until then the bike draws untextured
 * and riderless, and a failed load leaves it so (with a console error). When the type has a Tripo
 * body (`TRIPO_MODELS`), that body replaces the procedural one once it loads; its wheels are baked
 * in, so the generated tyres hide (their pivots stay for `update`) and the rider bakes after it,
 * onto its seat.
 * @param {PartKit} kit Part kit.
 * @param {ModelConfig} config Config with `procedural` set.
 * @param {number} L Length.
 * @param {() => boolean} isDisposed Whether the view was disposed meanwhile.
 * @returns {{content: Group, wheels: Object3D[]}} Content and wheel pivots.
 */
function proceduralBike(kit, config, L, isDisposed) {
  const type = /** @type {import('./vehicles/motorbike.js').MotorbikeType} */ (config.procedural);
  const bike = buildMotorbike(type);
  kit.own(bike.body);
  const material = kit.own(createLookMaterial());
  setSingleLook(material, config.color, EGO_HELMET, 1);
  const content = new Group();
  content.scale.setScalar(L / MOTORBIKE_LENGTH_M);
  const bodyMesh = new Mesh(bike.body, material);
  content.add(bodyMesh);
  const wheelGeometry = kit.own(unitWheel());
  /** @type {Mesh[]} */
  const tyres = [];
  const wheels = bike.wheels.map((w) => {
    const pivot = new Group();
    pivot.rotation.order = 'YXZ';
    pivot.position.set(0, w.radius, w.z);
    const tyre = new Mesh(wheelGeometry, material);
    tyre.scale.set(w.width, w.radius, w.radius);
    tyres.push(tyre);
    pivot.add(tyre);
    content.add(pivot);
    return pivot;
  });
  const spec = TRIPO_MODELS[type];
  /** @type {Promise<boolean>} */
  const textured = spec
    ? loadModel(spec.glb)
        .then((gltf) => {
          if (isDisposed()) return false;
          const parts = tripoParts(gltf, spec);
          bodyMesh.geometry = kit.own(parts.body);
          bodyMesh.material = kit.own(createLookMaterial({ map: parts.map, roughness: 0.9 }));
          for (const tyre of tyres) tyre.visible = false;
          return true;
        })
        .catch((err) => {
          console.error(`Model ${spec.glb}: ${err instanceof Error ? err.message : String(err)}; drawing the procedural ${type}.`);
          return false;
        })
    : Promise.resolve(false);
  loadTexture(PALETTE_TEXTURE)
    .then((texture) => {
      material.map = texture;
      material.needsUpdate = true;
    })
    .catch((err) => console.error(`Texture ${PALETTE_TEXTURE}: ${err instanceof Error ? err.message : String(err)}`));
  textured
    .then((tripo) => loadModel(RIDERS[0]).then((gltf) => ({ tripo, gltf })))
    .then(({ tripo, gltf }) => {
      if (isDisposed()) return;
      const seat = tripo ? (spec?.seat ?? bike.seat) : bike.seat;
      const rider = new Mesh(kit.own(bakeRider(gltf, 'drive', seat, bike.legPitch)), material);
      rider.castShadow = true;
      content.add(rider);
    })
    .catch((err) => console.error(`Rider ${RIDERS[0]}: ${err instanceof Error ? err.message : String(err)}; drawing the bike without a rider.`));
  return { content, wheels };
}

/**
 * Builds a low-poly pedestrian standing on the origin, facing +Z.
 * @param {PartKit} kit Part kit.
 * @param {ModelConfig} config Config.
 * @param {number} L Depth along the path.
 * @param {number} W Shoulder width.
 * @returns {{content: Group, legs: Object3D[]}} Content and leg pivots.
 */
function primitivePedestrian(kit, config, L, W) {
  const content = new Group();
  const h = config.heightM;
  const shirt = kit.own(new MeshStandardMaterial({ color: config.color, roughness: 0.8 }));
  const trousers = kit.own(new MeshStandardMaterial({ color: 0x33333d, roughness: 0.8 }));
  const skin = kit.own(new MeshStandardMaterial({ color: 0xd9a77c, roughness: 0.8 }));
  const legLen = h * 0.47;
  content.add(kit.box(W * 0.8, h * 0.33, Math.max(0.2, L * 0.5), shirt, [0, legLen + h * 0.165, 0]));
  const head = new Mesh(kit.own(new SphereGeometry(h * 0.075, 10, 8)), skin);
  head.position.set(0, legLen + h * 0.33 + h * 0.09, 0);
  content.add(head);
  const legs = [-1, 1].map((side) => {
    const pivot = new Group();
    pivot.position.set(side * W * 0.2, legLen, 0);
    pivot.add(kit.box(0.13, legLen, 0.14, trousers, [0, -legLen / 2, 0]));
    content.add(pivot);
    return pivot;
  });
  return { content, legs };
}

/**
 * Fits a loaded GLB scene to the footprint: per-axis scale to width (X) and length (Z), the
 * geometric mean for height, centred on X/Z and standing on y = 0.
 * @param {Object3D} scene Cloned scene in the Kenney frame.
 * @param {number} L Length.
 * @param {number} W Width.
 * @returns {Group} Fitted holder.
 */
export function fitToFootprint(scene, L, W) {
  const holder = new Group();
  holder.add(scene);
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  if (!(size.x > 0 && size.z > 0)) throw new Error('Model has an empty bounding box');
  const sx = W / size.x;
  const sz = L / size.z;
  const sy = Math.sqrt(sx * sz);
  holder.scale.set(sx, sy, sz);
  const centre = box.getCenter(new Vector3());
  scene.position.set(-centre.x, -box.min.y, -centre.z);
  return holder;
}

/**
 * Lets every mesh under a node cast shadows (lamp glows and beams excluded: basic materials).
 * @param {Object3D} node Node.
 */
function castShadows(node) {
  node.traverse((o) => {
    if (o instanceof Mesh && !(o.material instanceof MeshBasicMaterial)) o.castShadow = true;
  });
}

/**
 * @typedef {object} VehicleView
 * @property {Group} root Root to add to the scene.
 * @property {(pose: DrawPose, ego: {speed: number, yawRate: number, wheels: {steer: number}[]}, wheelAngles: number[], lamps: LampState | null) => void} update
 *   Pose the vehicle; `wheelAngles` are accumulated spin angles per wheel.
 * @property {() => Group} ghost A static copy of the current look (for the fall effect), with the
 *   body shown and mounted objects left out.
 * @property {(visible: boolean) => void} setBodyVisible Show or hide the body, wheels and rider;
 *   the lamps and headlight beams stay.
 * @property {(object: Object3D) => void} mount Add an object to the leaning frame (+X forward,
 *   +Y up, +Z right of the vehicle centre on the ground); `ghost` leaves it out.
 * @property {() => void} dispose Free owned resources.
 */

/**
 * Creates a vehicle view.
 * @param {VehicleOptions} options Options.
 * @returns {VehicleView} View.
 */
export function createVehicleView(options) {
  const { config, lengthM: L, widthM: W } = options;
  const kit = new PartKit();
  const root = new Group();
  root.name = `vehicle-${config.id}`;
  const lean = new Group();
  root.add(lean);
  const model = new Group();
  model.rotation.y = MODEL_YAW;
  lean.add(model);
  const body = new Group();
  body.userData.egoBody = true;
  model.add(body);

  const kind = config.kind === 'car' ? 'car' : 'motorbike';
  let disposed = false;
  const built =
    kind === 'car'
      ? boxCar(kit, config, L, W)
      : config.procedural
        ? proceduralBike(kit, config, L, () => disposed)
        : primitiveScooter(kit, config, L, W);
  let content = built.content;
  /** @type {Object3D[]} */
  let wheels = built.wheels;
  body.add(content);

  // Lamp lenses hide with the body (from the driver's seat they would float over the bonnet); the
  // headlight spot and beam stay, so the road stays lit in the cockpit view.
  const lenses = new Group();
  lenses.userData.egoBody = true;
  model.add(lenses);
  const lampKit = options.lamps ? buildLamps(kit, model, lenses, kind, L, W, config.heightM) : null;
  castShadows(root);

  if (config.glb) {
    loadModel(config.glb)
      .then((gltf) => {
        if (disposed) return;
        const scene = gltf.scene.clone(true);
        const holder = fitToFootprint(scene, L, W);
        /** @type {Object3D[]} */
        const found = [];
        for (const name of config.wheelNodes) {
          const node = scene.getObjectByName(name);
          if (!node) {
            found.length = 0;
            break;
          }
          node.rotation.order = 'YXZ';
          found.push(node);
        }
        body.remove(content);
        content = holder;
        body.add(content);
        castShadows(content);
        if (found.length === built.wheels.length) {
          wheels = found;
        } else {
          // Keep the generated wheels when the GLB lacks named wheel nodes.
          for (const w of built.wheels) content.parent?.add(w);
          wheels = built.wheels;
        }
      })
      .catch((err) => {
        console.error(`Model ${config.glb}: ${err instanceof Error ? err.message : String(err)}; drawing the generated ${kind}.`);
      });
  }

  return {
    root,
    update(pose, ego, wheelAngles, lamps) {
      root.position.set(pose.x, pose.y, pose.z);
      root.rotation.y = headingToYaw(pose.heading);
      lean.rotation.x = kind === 'motorbike' ? leanToRoll(leanAngle(ego.speed, ego.yawRate)) : 0;
      for (let i = 0; i < wheels.length; i += 1) {
        const w = wheels[i];
        w.rotation.x = wheelAngles[i] ?? 0;
        w.rotation.y = ego.wheels[i]?.steer ?? 0;
      }
      if (lampKit && lamps) lampKit.update(lamps);
    },
    ghost() {
      const copy = /** @type {Group} */ (root.clone(true));
      copy.traverse((o) => {
        if (o instanceof SpotLight || o.userData.mounted) o.visible = false;
        if (o.userData.egoBody) o.visible = true;
      });
      return copy;
    },
    setBodyVisible(visible) {
      body.visible = visible;
      lenses.visible = visible;
    },
    mount(object) {
      object.userData.mounted = true;
      lean.add(object);
    },
    dispose() {
      disposed = true;
      lampKit?.dispose();
      kit.dispose();
    },
  };
}

/**
 * Head, brake and indicator lamps plus a headlight spot and beam, in the Kenney frame.
 * @param {PartKit} kit Part kit.
 * @param {Group} model Model group (Kenney frame), for the headlight spot and beam.
 * @param {Group} lenses Group in the same frame for the lamp lenses.
 * @param {'car' | 'motorbike'} kind Kind.
 * @param {number} L Length.
 * @param {number} W Width.
 * @param {number} H Height.
 * @returns {{update: (s: LampState) => void, dispose: () => void}} Lamp controller.
 */
function buildLamps(kit, model, lenses, kind, L, W, H) {
  const head = kit.own(new MeshBasicMaterial({ color: 0x777766 }));
  const brake = kit.own(new MeshBasicMaterial({ color: 0x551111 }));
  const indL = kit.own(new MeshBasicMaterial({ color: 0x664411 }));
  const indR = kit.own(new MeshBasicMaterial({ color: 0x664411 }));
  const y = kind === 'car' ? H * 0.45 : H * 0.72;
  const zf = L / 2 + 0.01;
  const zr = -L / 2 - 0.01;
  const xs = kind === 'car' ? [W / 2 - 0.25, -(W / 2 - 0.25)] : [0];
  for (const x of xs) {
    lenses.add(kit.box(0.28, 0.12, 0.04, head, [x, y, zf]));
    lenses.add(kit.box(0.28, 0.1, 0.04, brake, [x, y, zr]));
  }
  const xi = kind === 'car' ? W / 2 - 0.06 : 0.2;
  for (const z of [zf, zr]) {
    lenses.add(kit.box(0.1, 0.07, 0.04, indL, [xi, y + 0.1, z]));
    lenses.add(kit.box(0.1, 0.07, 0.04, indR, [-xi, y + 0.1, z]));
  }
  const spot = new SpotLight(0xfff4d6, 0, 40, 0.5, 0.5, 1.2);
  spot.position.set(0, y, zf);
  const target = new Object3D();
  target.position.set(0, 0, zf + 15);
  model.add(target);
  spot.target = target;
  model.add(spot);
  const beamMaterial = kit.own(
    new MeshBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }),
  );
  const beam = new Mesh(kit.own(new ConeGeometry(1, 1, 16, 1, true)), beamMaterial);
  beam.rotation.x = -Math.PI / 2; // apex towards the lamp, opening forwards (+Z)
  model.add(beam);

  return {
    update(s) {
      brake.color.setHex(s.brake ? 0xff2020 : 0x551111);
      indL.color.setHex(s.left ? 0xffa000 : 0x664411);
      indR.color.setHex(s.right ? 0xffa000 : 0x664411);
      head.color.setHex(s.head === 'off' ? 0x777766 : 0xfffbe8);
      const high = s.head === 'high';
      spot.visible = s.head !== 'off';
      spot.intensity = s.head === 'off' ? 0 : high ? 400 : 160;
      spot.distance = high ? 110 : 45;
      spot.angle = high ? 0.32 : 0.5;
      target.position.set(0, high ? 0.6 : 0, zf + (high ? 50 : 14));
      const reach = high ? 30 : 12;
      beam.visible = s.head !== 'off' && s.night > 0.05;
      const spread = reach * Math.tan(spot.angle) * 0.45;
      beam.scale.set(spread, reach, spread * 0.6);
      beam.position.set(0, y, zf + reach / 2);
      beamMaterial.opacity = 0.035 * s.night;
    },
    dispose() {
      spot.dispose();
    },
  };
}

/**
 * Lamp state of the player for a frame: brake from the brake inputs, indicators blinking at
 * 1.5 Hz from frame time, headlights from `ego.lights`.
 * @param {EgoState} ego Ego state.
 * @param {number} t Frame time in seconds.
 * @param {number} night Night factor 0..1.
 * @returns {LampState} Lamps.
 */
export function lampState(ego, t, night) {
  const blink = blinkOn(t);
  const ind = ego.indicators;
  return {
    brake: ego.input.brakeFront > 0.05 || ego.input.brakeRear > 0.05 || ego.input.handbrake,
    left: blink && (ind === 'left' || ind === 'hazard'),
    right: blink && (ind === 'right' || ind === 'hazard'),
    head: ego.lights,
    night,
  };
}

/**
 * @typedef {object} PedestrianView
 * @property {Group} root Root.
 * @property {(pose: DrawPose, walkPhase: number, t: number) => void} update Pose; `walkPhase`
 *   (radians, one cycle per two steps) drives the walk, `t` (frame time) the idle animation.
 * @property {() => void} dispose Free resources.
 */

/** Scratch vector for foot positions. */
const foot = new Vector3();

/**
 * Moves a skinned figure so its lower foot touches the ground. The legs have no knee, so a
 * stride lifts the hips; the clip's root motion was made for the short original legs.
 * @param {{figure: Object3D, holder: Group, legs: Object3D[], legLength: number}} skinned Figure.
 */
function standOnGround(skinned) {
  skinned.holder.position.y = 0;
  skinned.holder.updateMatrixWorld(true);
  const parent = /** @type {Object3D} */ (skinned.holder.parent);
  let lowest = Infinity;
  for (const leg of skinned.legs) {
    leg.localToWorld(foot.set(0, -skinned.legLength, 0));
    parent.worldToLocal(foot);
    lowest = Math.min(lowest, foot.y);
  }
  skinned.holder.position.y = -lowest;
}

/**
 * @typedef {object} PedestrianOptions
 * @property {string | null} [character] Mini Characters GLB to draw as a skinned, animated
 *   figure once loaded; null keeps the primitive figure.
 * @property {(path: string) => Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>} [load]
 *   Model loader (defaults to `loadModel`).
 */

/**
 * Creates a pedestrian view: a primitive figure, upgraded to a skinned Mini Character with walk
 * and idle clips when `character` loads.
 * @param {ModelConfig} config Config.
 * @param {number} lengthM Depth along the path.
 * @param {number} widthM Width.
 * @param {PedestrianOptions} [options] Options.
 * @returns {PedestrianView} View.
 */
export function createPedestrianView(config, lengthM, widthM, options = {}) {
  const kit = new PartKit();
  const root = new Group();
  root.name = `pedestrian-${config.id}`;
  const model = new Group();
  model.rotation.y = MODEL_YAW;
  root.add(model);
  const { content, legs } = primitivePedestrian(kit, config, lengthM, widthM);
  model.add(content);
  castShadows(content);
  /**
   * @type {{mixer: AnimationMixer, walk: import('three').AnimationAction, idle: import('three').AnimationAction,
   *   figure: Object3D, holder: Group, legs: Object3D[], legLength: number} | null}
   */
  let skinned = null;
  let disposed = false;
  if (options.character) {
    const path = options.character;
    (options.load ?? loadModel)(path)
      .then((gltf) => {
        if (disposed) return;
        const walkClip = gltf.animations.find((a) => a.name === 'walk');
        const idleClip = gltf.animations.find((a) => a.name === 'idle');
        if (!walkClip || !idleClip) throw new Error('character lacks the walk or idle clip');
        const fit = characterFit(gltf, SKINNED_PROPORTIONS);
        const figure = cloneSkinned(gltf.scene);
        applyProportions(figure);
        const legs = ['leg-left', 'leg-right'].map((name) => figure.getObjectByName(name));
        if (legs.some((l) => !l)) throw new Error('character lacks the leg joints');
        const legLength = /** @type {Object3D} */ (legs[0]).position.y;
        const holder = new Group();
        holder.scale.setScalar(fit.scale);
        holder.add(figure);
        const mixer = new AnimationMixer(figure);
        const walk = mixer.clipAction(walkClip);
        const idle = mixer.clipAction(idleClip);
        walk.play();
        idle.play();
        model.remove(content);
        model.add(holder);
        castShadows(holder);
        skinned = { mixer, walk, idle, figure, holder, legs: /** @type {Object3D[]} */ (legs), legLength };
      })
      .catch((err) => console.error(`Pedestrian ${path}: ${err instanceof Error ? err.message : String(err)}; drawing the primitive figure.`));
  }
  return {
    root,
    update(pose, walkPhase, t) {
      root.position.set(pose.x, 0, pose.z);
      root.rotation.y = headingToYaw(pose.heading);
      if (skinned) {
        const moving = walkPhase !== 0;
        const turn = walkPhase / (2 * Math.PI);
        skinned.walk.setEffectiveWeight(moving ? 1 : 0);
        skinned.idle.setEffectiveWeight(moving ? 0 : 1);
        skinned.walk.time = (turn - Math.floor(turn)) * skinned.walk.getClip().duration;
        const idleLen = skinned.idle.getClip().duration;
        skinned.idle.time = idleLen > 0 ? t % idleLen : 0;
        skinned.mixer.update(0);
        applyProportions(skinned.figure);
        standOnGround(skinned);
        return;
      }
      const swing = Math.sin(walkPhase) * 0.5;
      legs[0].rotation.x = swing;
      legs[1].rotation.x = -swing;
    },
    dispose() {
      disposed = true;
      if (skinned) {
        skinned.mixer.stopAllAction();
        skinned.mixer.uncacheRoot(skinned.figure);
      }
      kit.dispose();
    },
  };
}
