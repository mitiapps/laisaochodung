import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { assertFrame } from './contracts/assert-frame.js';
import { assertMap } from './contracts/assert-map.js';
import { createCameraControl } from './game/camera-control.js';
import { createLoop } from './game/loop.js';
import { createInput } from './game/input.js';
import { createSession } from './game/session.js';
import { createCanvasView, loadMap, loadRapier, loadRenderer, loadRules, loadTrafficParams, parseDevRunQuery } from './game/browser.js';
import { createSim } from './sim/index.js';
import { createScorer, scoreRun } from './scoring/index.js';
import { readCameraMode, writeCameraMode } from './ui/lib/camera-mode-store.js';
import { VEHICLES } from './ui/lib/catalog.js';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app mount point in index.html');

// The play screen moves this host into place; each run draws on a fresh canvas inside it.
const canvasHost = document.createElement('div');
canvasHost.className = 'h-full w-full';

/** @type {import('./contracts/modules.js').CreateRenderer | null} The renderer, once loaded for the first run. */
let createRenderer = null;

// The camera mode lives outside the session: the key, the HUD button and the home page change it,
// and each run's renderer gets it before the session draws the run's first frame.
const camera = createCameraControl({ store: { read: () => readCameraMode(), write: (mode) => writeCameraMode(mode) } });
/** Counts views, so only the latest view detaches the camera when it is disposed. */
let viewSerial = 0;

const game = createSession({
  vehicles: VEHICLES,
  loadMap: (mapId) => loadMap(mapId),
  loadRules,
  loadRapier,
  loadTrafficParams,
  // Dev builds only: `?traffic=`, `?seed=` and `?agentScale=` in the play hash; release builds ignore them.
  ...(import.meta.env.DEV ? { devRunOptions: () => parseDevRunQuery(location.hash) } : {}),
  createSim,
  createScorer,
  prepareView: async () => {
    createRenderer = await loadRenderer();
  },
  createView: (map, vehicle) => {
    if (!createRenderer) throw new Error('The renderer is not loaded; prepareView must finish first');
    const view = createCanvasView(canvasHost, createRenderer, map, vehicle);
    const serial = (viewSerial += 1);
    camera.attach(view.renderer);
    return {
      renderer: view.renderer,
      dispose() {
        if (serial === viewSerial) camera.attach(null);
        view.dispose();
      },
    };
  },
  createInput: (options) => createInput({ ...options, onCamera: () => camera.toggle() }),
  createLoop,
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
  keyTarget: window,
  visibility: document,
  dev: import.meta.env.DEV,
  assertFrame,
  assertMap,
  scoreRun,
});

if (import.meta.env.DEV) {
  // Dev builds only: lets a browser session read the replay check and frame times.
  /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).__laisaochodung = { debugInfo: () => game.debugInfo() };
}

const app = mount(App, { target, props: { game, canvas: canvasHost, camera } });

export default app;
