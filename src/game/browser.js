/**
 * Browser collaborators of the session: map and rules loaders, Rapier start-up and the WebGL view.
 * Everything that touches `fetch`, the DOM or WebGL lives here, so `session.js` stays testable.
 */

import { ID_PATTERN, checkRunOptions } from './session.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/rule.js').RulesBundle} RulesBundle */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('./session.js').View} View */
/** @typedef {import('./session.js').RunOptions} RunOptions */
/** @typedef {import('../contracts/traffic.js').TrafficParams} TrafficParams */

/**
 * Loads `maps/<id>.json` from the site root.
 * @param {string} mapId Map id.
 * @param {{fetchFn?: typeof fetch, baseUrl?: string}} [options] Fetch and base URL.
 * @returns {Promise<GameMap>} Parsed map; the sim validates it with `assertMap`.
 */
export async function loadMap(mapId, { fetchFn = fetch, baseUrl = import.meta.env.BASE_URL } = {}) {
  if (!ID_PATTERN.test(mapId)) throw new Error(`Invalid map id "${mapId}"`);
  const url = `${baseUrl}maps/${mapId}.json`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Map ${mapId}: HTTP ${res.status} for ${url}`);
  const json = /** @type {unknown} */ (await res.json());
  if (typeof json !== 'object' || json === null || /** @type {{id?: unknown}} */ (json).id !== mapId) {
    throw new Error(`Map ${mapId}: the file does not hold that map`);
  }
  return /** @type {GameMap} */ (json);
}

/** @type {Promise<RulesBundle> | null} */
let rulesPromise = null;

/**
 * Loads the rules bundle built by `npm run build:rules` (validated at build time), once.
 * @returns {Promise<RulesBundle>} Bundle.
 */
export function loadRules() {
  rulesPromise ??= import('../generated/rules.json').then(
    (m) => /** @type {RulesBundle} */ (/** @type {unknown} */ (m.default)),
    (err) => {
      rulesPromise = null;
      throw err;
    },
  );
  return rulesPromise;
}

/** @type {Promise<TrafficParams> | null} */
let trafficParamsPromise = null;

/**
 * Loads the traffic parameters built by `npm run build:traffic` (validated at build time), once.
 * @returns {Promise<TrafficParams>} Parameters.
 */
export function loadTrafficParams() {
  trafficParamsPromise ??= import('../generated/traffic-params.json').then(
    (m) => /** @type {TrafficParams} */ (/** @type {unknown} */ (m.default)),
    (err) => {
      trafficParamsPromise = null;
      throw err;
    },
  );
  return trafficParamsPromise;
}

/**
 * Reads the dev-only run options from the query of a hash such as
 * `#/play?map=osm-pasteur&vehicle=car-sedan&seed=42&traffic=off`. Only `traffic=off` and a
 * decimal `seed` are understood; any other value of those keys is an error, not a silent default.
 * @param {string} hash `location.hash`.
 * @returns {RunOptions} Options.
 */
export function parseDevRunQuery(hash) {
  const query = hash.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  /** @type {RunOptions} */
  const options = {};
  const traffic = params.get('traffic');
  if (traffic !== null) {
    if (traffic !== 'off' && traffic !== 'map') throw new RangeError(`Dev hash query: traffic must be off or map, got "${traffic}"`);
    options.traffic = traffic;
  }
  const seed = params.get('seed');
  if (seed !== null) {
    if (!/^\d{1,10}$/u.test(seed)) throw new RangeError(`Dev hash query: seed must be a decimal integer, got "${seed}"`);
    options.seed = Number(seed);
  }
  return checkRunOptions(options, 'Dev hash query');
}

/** @type {Promise<unknown> | null} */
let rapierPromise = null;

/**
 * Loads and initialises Rapier (its WASM is inlined in the compat build), once.
 * @returns {Promise<unknown>} Initialised module.
 */
export function loadRapier() {
  rapierPromise ??= import('@dimforge/rapier3d-compat').then(
    async (m) => {
      const RAPIER = m.default;
      await RAPIER.init();
      return RAPIER;
    },
    (err) => {
      rapierPromise = null;
      throw err;
    },
  );
  return rapierPromise;
}

/**
 * Creates a fresh canvas inside `host` with a renderer that follows the host's size. A new
 * canvas per run keeps WebGL state from leaking between maps; the old context is released.
 * @param {HTMLElement} host Element the canvas fills.
 * @param {import('../contracts/modules.js').CreateRenderer} createRenderer Renderer factory.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicle Vehicle.
 * @returns {View} View.
 */
export function createCanvasView(host, createRenderer, map, vehicle) {
  const canvas = document.createElement('canvas');
  canvas.className = 'block h-full w-full';
  canvas.dataset.testid = 'game-canvas';
  host.replaceChildren(canvas);
  /** @type {import('../contracts/modules.js').Renderer} */
  let renderer;
  try {
    renderer = createRenderer(canvas, map, vehicle);
  } catch (err) {
    canvas.remove();
    throw err;
  }
  const fit = () => renderer.resize(canvas.clientWidth || host.clientWidth || 1, canvas.clientHeight || host.clientHeight || 1);
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(canvas);
  return {
    renderer,
    dispose() {
      observer.disconnect();
      try {
        renderer.dispose();
      } finally {
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
      }
    },
  };
}
