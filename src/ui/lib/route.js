/**
 * Hash routing without a router library.
 */

/** @typedef {'home' | 'play' | 'disclaimer' | 'contact' | 'donate' | 'credits' | 'not-found'} RouteName */

/**
 * @typedef {object} Route
 * @property {RouteName} name Screen.
 * @property {string | null} mapId Map id (play only).
 * @property {string | null} vehicleId Vehicle id (play only).
 * @property {import('../../contracts/hud.js').RunMode} mode Run mode (play only): `free` only for
 *   `mode=free`; anything else, or no value, is `scored`.
 */

/** Path of each page route. */
export const PATHS = Object.freeze({
  home: '/',
  play: '/play',
  disclaimer: '/gioi-thieu',
  contact: '/lien-he',
  donate: '/ung-ho',
  credits: '/ghi-cong',
});

/** @type {Readonly<Record<string, RouteName>>} */
const BY_PATH = Object.freeze(
  Object.fromEntries(Object.entries(PATHS).map(([name, path]) => [path, /** @type {RouteName} */ (name)])),
);

/**
 * Parses `location.hash`.
 * @param {string} hash Hash including `#`, or empty.
 * @returns {Route} Route; an unknown path is `not-found`.
 */
export function parseHash(hash) {
  const raw = hash.replace(/^#/u, '') || '/';
  const [path, query = ''] = raw.split('?');
  const name = Object.hasOwn(BY_PATH, path) ? BY_PATH[path] : 'not-found';
  if (name !== 'play') return { name, mapId: null, vehicleId: null, mode: 'scored' };
  const params = new URLSearchParams(query);
  return {
    name,
    mapId: params.get('map') || null,
    vehicleId: params.get('vehicle') || null,
    mode: params.get('mode') === 'free' ? 'free' : 'scored',
  };
}

/**
 * Hash link to a page.
 * @param {Exclude<RouteName, 'play' | 'not-found'>} name Page.
 * @returns {string} E.g. `#/lien-he`.
 */
export function pageHref(name) {
  return `#${PATHS[name]}`;
}

/**
 * Hash link that starts a run. A scored run carries no `mode`, so its link is the plain one.
 * @param {string} mapId Map id.
 * @param {string} vehicleId Vehicle id.
 * @param {import('../../contracts/hud.js').RunMode} [mode] Run mode, default `scored`.
 * @returns {string} E.g. `#/play?map=a&vehicle=b`, or `#/play?map=a&vehicle=b&mode=free`.
 */
export function playHref(mapId, vehicleId, mode = 'scored') {
  const params = new URLSearchParams({ map: mapId, vehicle: vehicleId });
  if (mode === 'free') params.set('mode', 'free');
  return `#${PATHS.play}?${params}`;
}
