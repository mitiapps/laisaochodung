/**
 * `createRenderer` (signature in `src/contracts/modules.js`). Draws the map from map JSON and
 * every moving thing from frames only; it never imports Rapier or the scorer.
 *
 * `render` may run several times per tick, or skip ticks. Per-tick work (wheel spin, skid marks,
 * shake and fall effects) runs once for each new `frame.tick`; a tick that goes backwards means a
 * new run and clears the effects.
 */

import { ACESFilmicToneMapping, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { DT } from '../contracts/units.js';
import { buildActors } from './actors.js';
import { releaseModels } from './assets.js';
import { createFallGhosts, createShake, createSkidMarks, shakeAmplitude, skidSegments } from './effects.js';
import { interpolateEgo, isDiscontinuity } from './interpolate.js';
import { leanAngle, wheelOffsets } from './math.js';
import { buildRoadMeshes } from './road-mesh.js';
import { buildRouteMarkers } from './route-markers.js';
import { createChaseCamera, createEnvironment } from './scene.js';
import { buildSigns } from './signs.js';
import { buildTrafficLights } from './traffic-lights.js';
import { createVehicleView, lampState } from './vehicle-view.js';
import { vehicleModel } from './vehicles/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/modules.js').Renderer} Renderer */

/**
 * Wall clock for effect animation only (never for simulation).
 * @returns {number} Seconds.
 */
const nowS = () => performance.now() / 1000;

/**
 * Creates the Three.js renderer for one map and vehicle.
 * @param {HTMLCanvasElement} canvas Canvas.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Player vehicle.
 * @returns {Renderer} Renderer.
 */
export function createRenderer(canvas, map, vehicleInfo) {
  const gl = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  gl.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  gl.outputColorSpace = SRGBColorSpace;
  gl.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene();
  const road = buildRoadMeshes(map);
  scene.add(road.group);
  const signs = buildSigns(map);
  scene.add(signs.group);
  const lights = buildTrafficLights(map);
  scene.add(lights.group);
  const markers = buildRouteMarkers(map);
  scene.add(markers.group);
  const actors = buildActors(map);
  scene.add(actors.group);
  const environment = createEnvironment(scene, road.asphalt);

  const config = vehicleModel(vehicleInfo.id, vehicleInfo.legalClass);
  const ego = createVehicleView({ config, lengthM: vehicleInfo.lengthM, widthM: vehicleInfo.widthM, lamps: true });
  scene.add(ego.root);
  const offsets = wheelOffsets(vehicleInfo.legalClass, vehicleInfo.lengthM, vehicleInfo.widthM);
  const skids = createSkidMarks(vehicleInfo.legalClass === 'car' ? 0.22 : 0.12);
  scene.add(skids.mesh);
  const shake = createShake();
  const ghosts = createFallGhosts();
  scene.add(ghosts.group);

  const chase = createChaseCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight) || 16 / 9, vehicleInfo.legalClass);
  const focus = new Vector3();

  /** @type {number[]} */
  const wheelAngles = offsets.map(() => 0);
  /** @type {([number, number] | null)[]} */
  const lastSkid = offsets.map(() => null);
  let lastTick = -1;
  let lastDraw = nowS();
  let disposed = false;

  /**
   * Per-tick bookkeeping for a frame not seen before.
   * @param {Frame} frame New frame.
   * @param {number} now Wall time.
   */
  function onNewTick(frame, now) {
    const jump = isDiscontinuity(frame);
    for (let i = 0; i < wheelAngles.length; i += 1) wheelAngles[i] += (frame.ego.wheels[i]?.spin ?? 0) * DT;
    for (const seg of skidSegments(lastSkid, frame, offsets, jump)) skids.add(seg.from, seg.to);
    for (const e of frame.events) {
      if (e.type === 'collision') shake.kick(shakeAmplitude(e.relSpeed), now);
      if (e.type === 'fall') {
        // Copy the bike as last drawn and let the copy tip over where it fell.
        const copy = ego.ghost();
        ghosts.spawn(copy, now, leanAngle(frame.ego.speed, frame.ego.yawRate) >= 0);
      }
    }
  }

  return {
    render(prev, frame, alpha) {
      if (disposed) throw new Error('Renderer used after dispose');
      const now = nowS();
      const dtS = Math.min(0.25, Math.max(0, now - lastDraw));
      lastDraw = now;
      let snap = false;
      if (frame.tick < lastTick) {
        // A new run: clear everything carried between ticks.
        skids.clear();
        ghosts.clear();
        actors.reset();
        wheelAngles.fill(0);
        lastSkid.fill(null);
        snap = true;
      }
      const newTick = frame.tick !== lastTick;
      if (newTick) {
        onNewTick(frame, now);
        if (isDiscontinuity(frame)) snap = true;
      }
      lastTick = frame.tick;

      const pose = interpolateEgo(prev, frame, alpha);
      const spinAhead = frame.ego.wheels.map((w) => w.spin * DT * Math.max(0, Math.min(1, alpha)) - w.spin * DT);
      const angles = wheelAngles.map((a, i) => a + (spinAhead[i] ?? 0));
      focus.set(pose.x, pose.y, pose.z);
      const night = environment.update(frame.env, focus, now);
      ego.update(pose, frame.ego, angles, lampState(frame.ego, frame.t, night));
      actors.update(prev, frame, alpha, newTick);
      lights.update(frame.trafficLights);
      markers.update(frame, now);
      ghosts.update(now);
      chase.follow(pose, dtS, snap, shake.offset(now));
      gl.render(scene, chase.camera);
    },
    resize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      gl.setSize(w, h, false);
      chase.camera.aspect = w / h;
      chase.camera.updateProjectionMatrix();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ego.dispose();
      actors.dispose();
      road.dispose();
      signs.dispose();
      lights.dispose();
      markers.dispose();
      skids.dispose();
      environment.dispose();
      gl.dispose();
      releaseModels().catch((err) => console.error('Releasing models failed', err));
    },
  };
}
