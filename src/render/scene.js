/**
 * Scene environment: sun and sky light from `env.clockMin`, fog, a wet look and rain streaks in
 * rain, and the smoothed chase camera. No cockpit or rider view in the MVP.
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
    fogDensity: rain ? 0.018 : 0.004 + (1 - day) * 0.006,
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
 * @returns {SceneEnvironment} Environment.
 */
export function createEnvironment(scene, asphalt) {
  const hemi = new HemisphereLight(0xdfefff, 0x4a4535, 1);
  scene.add(hemi);
  const sun = new DirectionalLight(0xfff1d8, 2);
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

  return {
    update(env, focus, nowS) {
      const look = environmentLook(env);
      const isRain = env.weather === 'rain';
      sky.copy(NIGHT_SKY).lerp(isRain ? RAIN_SKY : DAY_SKY, look.day);
      fog.color.copy(sky);
      fog.density = look.fogDensity;
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
 * Pure: chase-camera eye and look-at points for a pose.
 * @param {{x: number, y: number, z: number, heading: number}} pose Target pose.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class (sets distance and height).
 * @returns {{eye: [number, number, number], look: [number, number, number]}} Points.
 */
export function chaseTarget(pose, legalClass) {
  const car = legalClass === 'car';
  const back = car ? 7.5 : 5;
  const up = car ? 3 : 2.2;
  const [fx, fz] = headingVector(pose.heading);
  return {
    eye: [pose.x - fx * back, pose.y + up, pose.z - fz * back],
    look: [pose.x + fx * 4, pose.y + (car ? 1 : 0.9), pose.z + fz * 4],
  };
}

/**
 * Smoothed chase camera.
 * @param {number} aspect Aspect ratio.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class.
 * @returns {{camera: PerspectiveCamera, follow: (pose: {x: number, y: number, z: number, heading: number}, dtS: number, snap: boolean, shake: [number, number, number]) => void}} Camera.
 */
export function createChaseCamera(aspect, legalClass) {
  const camera = new PerspectiveCamera(60, aspect, 0.1, 1500);
  const eye = new Vector3();
  const look = new Vector3();
  let primed = false;
  return {
    camera,
    follow(pose, dtS, snap, shake) {
      const t = chaseTarget(pose, legalClass);
      if (snap || !primed) {
        eye.set(...t.eye);
        look.set(...t.look);
        primed = true;
      } else {
        // Frame-rate independent exponential smoothing, time constant about 0.15 s.
        const k = 1 - Math.exp(-Math.max(0, dtS) / 0.15);
        eye.lerp(new Vector3(...t.eye), k);
        look.lerp(new Vector3(...t.look), Math.min(1, k * 2));
      }
      camera.position.set(eye.x + shake[0], eye.y + shake[1], eye.z + shake[2]);
      camera.lookAt(look);
    },
  };
}
