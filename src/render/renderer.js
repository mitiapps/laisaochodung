/**
 * `createRenderer` (signature in `src/contracts/modules.js`). Draws the map from map JSON and
 * every moving thing from frames only; it never imports Rapier or the scorer.
 *
 * `render` may run several times per tick, or skip ticks. Per-tick work (wheel spin, skid marks,
 * shake and fall effects) runs once for each new `frame.tick`; a tick that goes backwards means a
 * new run and clears the effects.
 */

import { ACESFilmicToneMapping, PCFSoftShadowMap, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { DT } from '../contracts/units.js';
import { buildActors } from './actors.js';
import { buildCockpit } from './cockpit.js';
import { releaseModels } from './assets.js';
import { createFallGhosts, createShake, createSkidMarks, shakeAmplitude, skidSegments } from './effects.js';
import { interpolateEgo, isDiscontinuity } from './interpolate.js';
import { leanAngle, wheelOffsets } from './math.js';
import { buildRoadMeshes } from './road-mesh.js';
import { buildRouteMarkers } from './route-markers.js';
import { FAR_M, LOW_FAR_M, createCameraRig, createEnvironment } from './scene.js';
import { buildScenery } from './scenery/index.js';
import { SCENERY_KIT } from './scenery/kit.js';
import { buildSigns } from './signs.js';
import { buildTrafficLights } from './traffic-lights.js';
import { createVehicleView, lampState } from './vehicle-view.js';
import { vehicleModel } from './vehicles/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/modules.js').Renderer} Renderer */

/**
 * @typedef {object} World
 * @property {Scene} scene Scene.
 * @property {ReturnType<typeof buildRoadMeshes>} road Road, kerbs and markings.
 * @property {ReturnType<typeof buildScenery>} scenery Buildings and street furniture.
 * @property {ReturnType<typeof buildSigns>} signs Signs.
 * @property {ReturnType<typeof buildTrafficLights>} lights Signal heads.
 * @property {ReturnType<typeof buildRouteMarkers>} markers Route markers.
 * @property {ReturnType<typeof buildActors>} actors Scripted actors and traffic.
 * @property {ReturnType<typeof createEnvironment>} environment Lights, fog and rain.
 * @property {ReturnType<typeof createVehicleView>} ego Player vehicle.
 * @property {ReturnType<typeof buildCockpit>} cockpit Dash and wheel, or handlebar, of the cockpit
 *   view; mounted on the ego and hidden until that view is chosen.
 * @property {ReturnType<typeof createSkidMarks>} skids Skid marks.
 * @property {ReturnType<typeof createFallGhosts>} ghosts Fall ghosts.
 * @property {() => void} dispose Frees everything built here.
 */

/**
 * Wall clock for effect animation only (never for simulation).
 * @returns {number} Seconds.
 */
const nowS = () => performance.now() / 1000;

/**
 * Whether a WebGL context runs on a software rasteriser, by its unmasked renderer name.
 * @param {Pick<WebGLRenderingContext, 'getExtension' | 'getParameter'>} ctx WebGL context.
 * @returns {boolean} Software.
 */
export function softwareRenderer(ctx) {
  const ext = ctx.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  return /swiftshader|llvmpipe|softpipe|software/iu.test(name);
}

/**
 * The render quality of this browser, read from a throwaway WebGL context before the real one
 * is made: antialiasing is a context attribute, so it must be chosen at creation. The probe
 * context is released at once. Without WebGL the answer is `high`, and the real renderer then
 * reports the failure.
 * @param {Document} doc Document to create the probe canvas in.
 * @returns {RenderQuality} Quality.
 */
export function detectRenderQuality(doc) {
  const probe = doc.createElement('canvas');
  const ctx = probe.getContext('webgl2') ?? probe.getContext('webgl');
  if (!ctx) return 'high';
  const quality = softwareRenderer(ctx) ? 'low' : 'high';
  ctx.getExtension('WEBGL_lose_context')?.loseContext();
  return quality;
}

/**
 * How much the renderer spends per frame. `low` serves software rasterisers (SwiftShader,
 * llvmpipe): no antialiasing, fewer drawing-buffer pixels, cheaper scenery materials and a
 * shorter view range.
 * @typedef {'high' | 'low'} RenderQuality
 */

/** Drawing-buffer pixels per CSS pixel on the low-cost path; CSS scales the canvas up. */
export const LOW_QUALITY_PIXEL_RATIO = 0.5;

/**
 * Drawing-buffer pixel ratio for a quality: the device ratio (at most 2) on hardware, a fixed
 * fraction of a CSS pixel on the low-cost path.
 * @param {RenderQuality} quality Quality.
 * @param {number | undefined} devicePixelRatio `window.devicePixelRatio`.
 * @returns {number} Pixel ratio.
 */
export function pixelRatioFor(quality, devicePixelRatio) {
  if (quality === 'low') return LOW_QUALITY_PIXEL_RATIO;
  return Math.min(devicePixelRatio || 1, 2);
}

/**
 * Camera far plane for a quality.
 * @param {RenderQuality} quality Quality.
 * @returns {number} Metres.
 */
export function farFor(quality) {
  return quality === 'low' ? LOW_FAR_M : FAR_M;
}

/**
 * The scene of one map and vehicle, built in draw order: road, scenery, signs, lights, route
 * markers, actors (instanced), environment, then the ego and its effects. Needs no WebGL context.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Player vehicle.
 * @param {{quality?: RenderQuality}} [options] Quality; `high` by default.
 * @returns {World} The scene and its parts.
 */
export function buildWorld(map, vehicleInfo, { quality = 'high' } = {}) {
  const scene = new Scene();
  const road = buildRoadMeshes(map);
  scene.add(road.group);
  const scenery = buildScenery(map, SCENERY_KIT, { lambert: quality === 'low' });
  scene.add(scenery.group);
  const signs = buildSigns(map);
  scene.add(signs.group);
  const lights = buildTrafficLights(map);
  scene.add(lights.group);
  const markers = buildRouteMarkers(map);
  scene.add(markers.group);
  const actors = buildActors(map);
  scene.add(actors.group);
  const environment = createEnvironment(scene, road.asphalt, { farM: farFor(quality) });

  const config = vehicleModel(vehicleInfo.id, vehicleInfo.legalClass);
  const ego = createVehicleView({ config, lengthM: vehicleInfo.lengthM, widthM: vehicleInfo.widthM, lamps: true });
  scene.add(ego.root);
  const cockpit = buildCockpit(vehicleInfo.legalClass, config.color, vehicleInfo.lengthM, vehicleInfo.widthM);
  cockpit.group.visible = false;
  ego.mount(cockpit.group);
  const skids = createSkidMarks(vehicleInfo.legalClass === 'car' ? 0.22 : 0.12);
  scene.add(skids.mesh);
  const ghosts = createFallGhosts();
  scene.add(ghosts.group);
  return {
    scene,
    road,
    scenery,
    signs,
    lights,
    markers,
    actors,
    environment,
    ego,
    cockpit,
    skids,
    ghosts,
    dispose() {
      cockpit.dispose();
      ego.dispose();
      actors.dispose();
      road.dispose();
      scenery.dispose();
      signs.dispose();
      lights.dispose();
      markers.dispose();
      skids.dispose();
      environment.dispose();
    },
  };
}

/**
 * Creates the Three.js renderer for one map and vehicle.
 * @param {HTMLCanvasElement} canvas Canvas.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Player vehicle.
 * @returns {Renderer} Renderer.
 */
export function createRenderer(canvas, map, vehicleInfo) {
  // A software rasteriser runs far below playable at full size (about 14 fps on tutorial 01 at
  // 1280 × 720 in SwiftShader), mostly for fill, so it takes the low-cost path. Multisampling
  // alone halves its frame rate, so the low path also draws without it.
  const quality = detectRenderQuality(canvas.ownerDocument);
  const gl = new WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' });
  gl.setPixelRatio(pixelRatioFor(quality, globalThis.devicePixelRatio));
  gl.outputColorSpace = SRGBColorSpace;
  gl.toneMapping = ACESFilmicToneMapping;
  // Shadows cost a software rasteriser about a third of its frame rate, enough to slow the sim
  // below real time, so only a hardware GPU draws them.
  gl.shadowMap.enabled = quality === 'high';
  gl.shadowMap.type = PCFSoftShadowMap;

  const world = buildWorld(map, vehicleInfo, { quality });
  const { scene, lights, markers, actors, environment, ego, cockpit, skids, ghosts } = world;
  const offsets = wheelOffsets(vehicleInfo.legalClass, vehicleInfo.lengthM, vehicleInfo.widthM);
  const shake = createShake();

  const rig = createCameraRig(canvas.clientWidth / Math.max(1, canvas.clientHeight) || 16 / 9, vehicleInfo.legalClass, farFor(quality));
  const motorbike = vehicleInfo.legalClass !== 'car';
  const focus = new Vector3();

  /** @type {number[]} */
  const wheelAngles = offsets.map(() => 0);
  /** @type {([number, number] | null)[]} */
  const lastSkid = offsets.map(() => null);
  let lastTick = -1;
  let lastDraw = nowS();
  let disposed = false;
  /** Draw calls of the last frame, the shadow pass included. */
  let drawCalls = 0;
  /** @type {{prev: Frame | null, frame: Frame, alpha: number} | null} The last frame drawn, for a redraw on a camera switch. */
  let last = null;

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

  /**
   * Draws a frame. A frame whose tick was drawn before only redraws: per-tick effects run once.
   * @param {Frame | null} prev Previous frame.
   * @param {Frame} frame Frame.
   * @param {number} alpha Blend 0..1.
   * @param {boolean} forceSnap Place the camera without smoothing.
   */
  function draw(prev, frame, alpha, forceSnap) {
    const now = nowS();
    const dtS = Math.min(0.25, Math.max(0, now - lastDraw));
    lastDraw = now;
    let snap = forceSnap;
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
    cockpit.update(frame.ego.wheels[0]?.steer ?? 0);
    actors.update(prev, frame, alpha, newTick);
    lights.update(frame.trafficLights, frame.t);
    markers.update(frame, now);
    ghosts.update(now);
    const lean = motorbike ? leanAngle(frame.ego.speed, frame.ego.yawRate) : 0;
    rig.follow(pose, lean, dtS, snap, shake.offset(now));
    gl.render(scene, rig.camera);
    drawCalls = gl.info.render.calls;
  }

  return {
    render(prev, frame, alpha) {
      if (disposed) throw new Error('Renderer used after dispose');
      last = { prev, frame, alpha };
      draw(prev, frame, alpha, false);
    },
    setCameraMode(mode) {
      if (disposed) return;
      if (mode !== 'chase' && mode !== 'cockpit') throw new RangeError(`Unknown camera mode "${String(mode)}"`);
      rig.setMode(mode);
      ego.setBodyVisible(mode === 'chase');
      cockpit.group.visible = mode === 'cockpit';
      if (last) draw(last.prev, last.frame, last.alpha, true);
    },
    drawCalls() {
      return drawCalls;
    },
    resize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      gl.setSize(w, h, false);
      rig.camera.aspect = w / h;
      rig.camera.updateProjectionMatrix();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      last = null;
      world.dispose();
      gl.dispose();
      releaseModels().catch((err) => console.error('Releasing models failed', err));
    },
  };
}
