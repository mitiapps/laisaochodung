/**
 * Scene environment: sun and sky light from `env.clockMin`, fog, a wet look and rain streaks in
 * rain, night emissives, and the camera rig: a smoothed chase camera behind and above the vehicle,
 * or a rigid cockpit camera at the driver's or rider's eyes.
 *
 * - Far plane 300 m. The day fog leaves about 1% of a surface's colour at that distance, so the
 *   cut never shows, and it lets distant scenery chunks be culled. The low-cost path of software
 *   rasterisers uses `LOW_FAR_M` with the fog thickened to match.
 * - Shadows: the sun casts, with its shadow camera following the camera focus; the renderer turns
 *   `shadowMap` on. Only the ego and traffic cast; scenery and road only receive.
 * - Night: materials with a numeric `userData.nightEmissive` get `emissiveIntensity = night × value`
 *   (lit windows, sign boards), and objects with a numeric `userData.nightOnly` show only from that
 *   night factor on (lamp glow sprites). The scene is scanned again whenever its child count
 *   changes, so builders added later are picked up.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { daylight, sunElevation } from './math.js';
import { headingVector } from '../geometry/index.js';

/** @typedef {import('three').Scene} Scene */
/** @typedef {import('three').MeshStandardMaterial} MeshStandardMaterial */
/** @typedef {import('../contracts/telemetry.js').FrameEnv} FrameEnv */

const DAY_SKY = new Color(0x9cc9ef);
const NIGHT_SKY = new Color(0x0b1020);
const RAIN_SKY = new Color(0x6d7680);
const RAIN_DROPS = 1500;
const RAIN_BOX_M = 40;
/** Camera far plane in metres. */
export const FAR_M = 300;
/**
 * Far plane on the low-cost path, in metres (design). A software rasteriser spends most of its
 * frame filling pixels; the scenery past this range is drawn at a few pixels per building but
 * still costs its triangles, and the measured frame rate on `osm-pasteur` rose with a shorter
 * range. The clear-day fog is thickened by `FAR_M / LOW_FAR_M` there so the cut stays as hidden as
 * at 300 m; rain and night fog are thicker than that already.
 */
export const LOW_FAR_M = 150;
/** Half side of the square the sun's shadow covers around the focus, in metres (design). */
export const SHADOW_HALF_M = 45;

/**
 * Pure: light and fog settings for an environment.
 * @param {FrameEnv} env Clock and weather.
 * @returns {{day: number, sunIntensity: number, hemiIntensity: number, fogDensity: number, night: number}} Settings.
 */
export function environmentLook(env) {
  const day = daylight(env.clockMin);
  const rain = env.weather === 'rain';
  return {
    day,
    sunIntensity: day * (rain ? 0.6 : 2.2),
    hemiIntensity: 0.18 + day * (rain ? 0.8 : 1.1),
    fogDensity: rain ? 0.018 : 0.007 + (1 - day) * 0.006,
    night: 1 - day,
  };
}

/**
 * @typedef {object} SceneEnvironment
 * @property {(env: FrameEnv, focus: Vector3, nowS: number) => number} update Apply the look; returns the night factor.
 * @property {() => void} dispose Free resources.
 */

/**
 * Adds lights, fog and rain to a scene.
 * @param {Scene} scene Scene.
 * @param {MeshStandardMaterial} asphalt Asphalt material, made glossy in rain.
 * @param {{farM?: number}} [options] Camera far plane the fog must hide; `FAR_M` by default.
 * @returns {SceneEnvironment} Environment.
 */
export function createEnvironment(scene, asphalt, { farM = FAR_M } = {}) {
  // A shorter far plane needs at least the clear-day fog scaled up to hide it at that range;
  // thicker fog (rain, night) already hides it and stays as it is.
  const minFog = farM < FAR_M ? (environmentLook({ clockMin: 720, weather: 'clear' }).fogDensity * FAR_M) / farM : 0;
  const hemi = new HemisphereLight(0xdfefff, 0x4a4535, 1);
  scene.add(hemi);
  const sun = new DirectionalLight(0xfff1d8, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_HALF_M;
  sun.shadow.camera.right = SHADOW_HALF_M;
  sun.shadow.camera.top = SHADOW_HALF_M;
  sun.shadow.camera.bottom = -SHADOW_HALF_M;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 250;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);
  const fog = new FogExp2(DAY_SKY.getHex(), 0.004);
  scene.fog = fog;
  const sky = new Color();
  scene.background = sky;
  const dryColor = asphalt.color.clone();
  const dryRoughness = asphalt.roughness;

  const rainPositions = new Float32Array(RAIN_DROPS * 6);
  const seeds = new Float32Array(RAIN_DROPS * 3);
  // Fixed pseudo-random layout so the rain looks the same on every run.
  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = 0; i < seeds.length; i += 1) seeds[i] = rnd();
  const rainGeometry = new BufferGeometry();
  const rainAttr = new BufferAttribute(rainPositions, 3);
  rainGeometry.setAttribute('position', rainAttr);
  const rainMaterial = new LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.45 });
  const rain = new LineSegments(rainGeometry, rainMaterial);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  /** @type {NightTargets} */
  let night = { materials: [], objects: [] };
  let scannedChildren = -1;

  return {
    update(env, focus, nowS) {
      const look = environmentLook(env);
      if (scene.children.length !== scannedChildren) {
        night = nightTargets(scene);
        scannedChildren = scene.children.length;
      }
      applyNight(night, look.night);
      const isRain = env.weather === 'rain';
      sky.copy(NIGHT_SKY).lerp(isRain ? RAIN_SKY : DAY_SKY, look.day);
      fog.color.copy(sky);
      fog.density = Math.max(look.fogDensity, minFog);
      hemi.intensity = look.hemiIntensity;
      const elev = Math.max(0.05, sunElevation(env.clockMin));
      sun.intensity = look.sunIntensity;
      sun.position.set(focus.x + Math.cos(elev) * 60, Math.sin(elev) * 100, focus.z + 40);
      sun.target.position.copy(focus);
      asphalt.color.copy(dryColor).multiplyScalar(isRain ? 0.7 : 1);
      asphalt.roughness = isRain ? 0.35 : dryRoughness;

      rain.visible = isRain;
      if (isRain) {
        const fall = 18;
        for (let i = 0; i < RAIN_DROPS; i += 1) {
          const x = focus.x + (seeds[i * 3] - 0.5) * RAIN_BOX_M;
          const z = focus.z + (seeds[i * 3 + 1] - 0.5) * RAIN_BOX_M;
          const y = 20 - ((seeds[i * 3 + 2] * 20 + nowS * fall) % 20);
          rainPositions.set([x, y, z, x - 0.05, y + 0.6, z], i * 6);
        }
        rainAttr.needsUpdate = true;
      }
      return look.night;
    },
    dispose() {
      rainGeometry.dispose();
      rainMaterial.dispose();
      sun.dispose();
      hemi.dispose();
    },
  };
}

/**
 * @typedef {object} NightTargets
 * @property {{material: MeshStandardMaterial, scale: number}[]} materials Emissive materials.
 * @property {{object: import('three').Object3D, from: number}[]} objects Night-only objects.
 */

/**
 * Collects the night emissive materials and night-only objects of a scene.
 * @param {Scene} scene Scene.
 * @returns {NightTargets} Targets.
 */
export function nightTargets(scene) {
  /** @type {NightTargets} */
  const out = { materials: [], objects: [] };
  const seen = new Set();
  scene.traverse((o) => {
    if (typeof o.userData.nightOnly === 'number') out.objects.push({ object: o, from: o.userData.nightOnly });
    const mesh = /** @type {import('three').Mesh} */ (o);
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) {
      const scale = m.userData.nightEmissive;
      if (typeof scale !== 'number' || seen.has(m) || !('emissiveIntensity' in m)) continue;
      seen.add(m);
      out.materials.push({ material: /** @type {MeshStandardMaterial} */ (m), scale });
    }
  });
  return out;
}

/**
 * Applies a night factor to the targets.
 * @param {NightTargets} targets Targets.
 * @param {number} night Night factor 0..1.
 */
export function applyNight(targets, night) {
  for (const { material, scale } of targets.materials) material.emissiveIntensity = night * scale;
  for (const { object, from } of targets.objects) object.visible = night >= from;
}

/**
 * @typedef {object} ChaseRig
 * @property {number} backM Eye distance behind the vehicle centre.
 * @property {number} upM Eye height above the vehicle's ground point.
 * @property {number} lookAheadM Look point ahead of the vehicle centre.
 * @property {number} lookUpM Look point height.
 */

/**
 * Chase camera per vehicle class (design). The camera sits high and pitched down, so the vehicle
 * fills the lower half of the screen and the road from a few metres ahead of its front shows above
 * it: the drawn sedan is 1.89 m tall (the Car Kit model fitted to the footprint), a rider's head
 * about 1.7 m. At 4.5 m and 3.6 m it looks over riders, cars and bus roofs behind, and passes under
 * cantilever signal heads (5.3 m and up) and the tutorial streets' lowest cable sag (about 4.7 m);
 * street trees stand 2.6 m from the kerb lane's centre with their crowns clear of it.
 * @type {Readonly<{car: ChaseRig, motorbike: ChaseRig}>}
 */
export const CHASE_RIG = Object.freeze({
  car: Object.freeze({ backM: 6.5, upM: 4.5, lookAheadM: 6.5, lookUpM: 0 }),
  motorbike: Object.freeze({ backM: 5.5, upM: 3.6, lookAheadM: 5, lookUpM: 0 }),
});

/**
 * @typedef {object} CockpitRig
 * @property {number} aheadM Eye position ahead of the vehicle centre (negative: behind it).
 * @property {number} leftM Eye offset to the left of the centreline.
 * @property {number} upM Eye height.
 * @property {number} lookAheadM Look point ahead of the vehicle centre.
 * @property {number} lookUpM Look point height.
 * @property {number} fovDeg Vertical field of view.
 * @property {number} rollPerLean Camera roll per radian of drawn lean (a rider's head leans less
 *   than the bike).
 */

/**
 * Cockpit camera per vehicle class (design): a left-hand-drive driver's eyes, and a rider's eyes
 * over the handlebar. The cockpit drawn under them (`cockpit.js`) fills the bottom fifth to quarter
 * of the screen and leaves the road visible from about two metres ahead of the front.
 * @type {Readonly<{car: CockpitRig, motorbike: CockpitRig}>}
 */
export const COCKPIT_RIG = Object.freeze({
  car: Object.freeze({ aheadM: -0.15, leftM: 0.36, upM: 1.2, lookAheadM: 30, lookUpM: 0.9, fovDeg: 60, rollPerLean: 0 }),
  motorbike: Object.freeze({ aheadM: -0.25, leftM: 0, upM: 1.55, lookAheadM: 12, lookUpM: 0, fovDeg: 70, rollPerLean: 0.5 }),
});

/** Vertical field of view of the chase camera, in degrees. */
export const CHASE_FOV_DEG = 60;

/**
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class.
 * @returns {'car' | 'motorbike'} Rig key.
 */
const rigKey = (legalClass) => (legalClass === 'car' ? 'car' : 'motorbike');

/**
 * Pure: chase-camera eye and look-at points for a pose.
 * @param {{x: number, y: number, z: number, heading: number}} pose Target pose.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class (sets distance and height).
 * @returns {{eye: [number, number, number], look: [number, number, number]}} Points.
 */
export function chaseTarget(pose, legalClass) {
  const rig = CHASE_RIG[rigKey(legalClass)];
  const [fx, fz] = headingVector(pose.heading);
  return {
    eye: [pose.x - fx * rig.backM, pose.y + rig.upM, pose.z - fz * rig.backM],
    look: [pose.x + fx * rig.lookAheadM, pose.y + rig.lookUpM, pose.z + fz * rig.lookAheadM],
  };
}

/**
 * Pure: cockpit-camera eye and look-at points for a pose. Left of heading θ is (−sin θ, 0, −cos θ).
 * @param {{x: number, y: number, z: number, heading: number}} pose Vehicle pose.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class.
 * @returns {{eye: [number, number, number], look: [number, number, number]}} Points.
 */
export function cockpitTarget(pose, legalClass) {
  const rig = COCKPIT_RIG[rigKey(legalClass)];
  const [fx, fz] = headingVector(pose.heading);
  const lx = -Math.sin(pose.heading);
  const lz = -Math.cos(pose.heading);
  const ex = pose.x + fx * rig.aheadM + lx * rig.leftM;
  const ez = pose.z + fz * rig.aheadM + lz * rig.leftM;
  const ahead = rig.lookAheadM - rig.aheadM;
  return {
    eye: [ex, pose.y + rig.upM, ez],
    look: [ex + fx * ahead, pose.y + rig.lookUpM, ez + fz * ahead],
  };
}

/**
 * @typedef {object} CameraRig
 * @property {PerspectiveCamera} camera Camera.
 * @property {() => import('../contracts/controls.js').CameraMode} mode Current mode.
 * @property {(mode: import('../contracts/controls.js').CameraMode) => void} setMode Switch mode; the
 *   next `follow` snaps.
 * @property {(pose: {x: number, y: number, z: number, heading: number}, leanRad: number, dtS: number, snap: boolean, shake: [number, number, number]) => void} follow
 *   Place the camera for a pose; `leanRad` is the drawn lean (+ to the left).
 */

/**
 * The camera rig: a chase camera smoothed toward its target, or a rigid cockpit camera at the
 * eyes. Both take the collision shake.
 * @param {number} aspect Aspect ratio.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class.
 * @param {number} [farM] Far plane in metres; `FAR_M` by default.
 * @returns {CameraRig} Rig.
 */
export function createCameraRig(aspect, legalClass, farM = FAR_M) {
  const camera = new PerspectiveCamera(CHASE_FOV_DEG, aspect, 0.1, farM);
  const cockpit = COCKPIT_RIG[rigKey(legalClass)];
  const eye = new Vector3();
  const look = new Vector3();
  const target = new Vector3();
  /** @type {import('../contracts/controls.js').CameraMode} */
  let mode = 'chase';
  let primed = false;
  return {
    camera,
    mode: () => mode,
    setMode(next) {
      if (next !== 'chase' && next !== 'cockpit') throw new RangeError(`Unknown camera mode "${String(next)}"`);
      if (next === mode) return;
      mode = next;
      primed = false;
      camera.fov = mode === 'cockpit' ? cockpit.fovDeg : CHASE_FOV_DEG;
      camera.updateProjectionMatrix();
    },
    follow(pose, leanRad, dtS, snap, shake) {
      if (mode === 'cockpit') {
        const t = cockpitTarget(pose, legalClass);
        eye.set(...t.eye);
        look.set(...t.look);
        primed = false;
      } else {
        const t = chaseTarget(pose, legalClass);
        if (snap || !primed) {
          eye.set(...t.eye);
          look.set(...t.look);
          primed = true;
        } else {
          // Frame-rate independent exponential smoothing, time constant about 0.15 s.
          const k = 1 - Math.exp(-Math.max(0, dtS) / 0.15);
          eye.lerp(target.set(...t.eye), k);
          look.lerp(target.set(...t.look), Math.min(1, k * 2));
        }
      }
      camera.position.set(eye.x + shake[0], eye.y + shake[1], eye.z + shake[2]);
      camera.lookAt(look);
      if (mode === 'cockpit' && cockpit.rollPerLean !== 0) camera.rotateZ(leanRad * cockpit.rollPerLean);
    },
  };
}
