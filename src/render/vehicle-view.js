/**
 * Drawable vehicles (player and NPC cars) and pedestrians. A view starts as a generated box or
 * primitive model sized to the footprint and upgrades to its GLB when the model loads, so a
 * missing or broken model never blocks drawing.
 *
 * Node layout: `root` (ground position, `rotation.y = heading`, +X forward) → `lean` (roll) →
 * `model` (turns the Kenney frame, front +Z and left +X, to +X forward) → content.
 */

import {
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
import { loadModel } from './assets.js';
import { blinkOn, headingToYaw, leanAngle, leanToRoll, wheelOffsets } from './math.js';

/** @typedef {import('./vehicles/model-config.js').ModelConfig} ModelConfig */
/** @typedef {import('../contracts/telemetry.js').EgoState} EgoState */
/** @typedef {import('./interpolate.js').DrawPose} DrawPose */

/** Kenney frame to +X forward: rotating +Z by π/2 about +Y gives +X. */
const MODEL_YAW = Math.PI / 2;

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
 * @typedef {object} VehicleView
 * @property {Group} root Root to add to the scene.
 * @property {(pose: DrawPose, ego: {speed: number, yawRate: number, wheels: {steer: number}[]}, wheelAngles: number[], lamps: LampState | null) => void} update
 *   Pose the vehicle; `wheelAngles` are accumulated spin angles per wheel.
 * @property {() => Group} ghost A static copy of the current look (for the fall effect).
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

  const kind = config.kind === 'car' ? 'car' : 'motorbike';
  const built = kind === 'car' ? boxCar(kit, config, L, W) : primitiveScooter(kit, config, L, W);
  let content = built.content;
  /** @type {Object3D[]} */
  let wheels = built.wheels;
  model.add(content);

  const lampKit = options.lamps ? buildLamps(kit, model, kind, L, W, config.heightM) : null;
  let disposed = false;

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
        model.remove(content);
        content = holder;
        model.add(content);
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
        if (o instanceof SpotLight) o.visible = false;
      });
      return copy;
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
 * @param {Group} model Model group (Kenney frame).
 * @param {'car' | 'motorbike'} kind Kind.
 * @param {number} L Length.
 * @param {number} W Width.
 * @param {number} H Height.
 * @returns {{update: (s: LampState) => void, dispose: () => void}} Lamp controller.
 */
function buildLamps(kit, model, kind, L, W, H) {
  const head = kit.own(new MeshBasicMaterial({ color: 0x777766 }));
  const brake = kit.own(new MeshBasicMaterial({ color: 0x551111 }));
  const indL = kit.own(new MeshBasicMaterial({ color: 0x664411 }));
  const indR = kit.own(new MeshBasicMaterial({ color: 0x664411 }));
  const y = kind === 'car' ? H * 0.45 : H * 0.72;
  const zf = L / 2 + 0.01;
  const zr = -L / 2 - 0.01;
  const xs = kind === 'car' ? [W / 2 - 0.25, -(W / 2 - 0.25)] : [0];
  for (const x of xs) {
    model.add(kit.box(0.28, 0.12, 0.04, head, [x, y, zf]));
    model.add(kit.box(0.28, 0.1, 0.04, brake, [x, y, zr]));
  }
  const xi = kind === 'car' ? W / 2 - 0.06 : 0.2;
  for (const z of [zf, zr]) {
    model.add(kit.box(0.1, 0.07, 0.04, indL, [xi, y + 0.1, z]));
    model.add(kit.box(0.1, 0.07, 0.04, indR, [-xi, y + 0.1, z]));
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
 * @property {(pose: DrawPose, walkPhase: number) => void} update Pose; `walkPhase` swings legs.
 * @property {() => void} dispose Free resources.
 */

/**
 * Creates a pedestrian view.
 * @param {ModelConfig} config Config.
 * @param {number} lengthM Depth along the path.
 * @param {number} widthM Width.
 * @returns {PedestrianView} View.
 */
export function createPedestrianView(config, lengthM, widthM) {
  const kit = new PartKit();
  const root = new Group();
  root.name = `pedestrian-${config.id}`;
  const model = new Group();
  model.rotation.y = MODEL_YAW;
  root.add(model);
  const { content, legs } = primitivePedestrian(kit, config, lengthM, widthM);
  model.add(content);
  return {
    root,
    update(pose, walkPhase) {
      root.position.set(pose.x, 0, pose.z);
      root.rotation.y = headingToYaw(pose.heading);
      const swing = Math.sin(walkPhase) * 0.5;
      legs[0].rotation.x = swing;
      legs[1].rotation.x = -swing;
    },
    dispose() {
      kit.dispose();
    },
  };
}
