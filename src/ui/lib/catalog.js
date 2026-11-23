/**
 * Loads and validates the catalog files the UI reads: the vehicle list, the built map index, the
 * asset credits and the legal sources of the rules bundle. Every file is checked at this boundary;
 * a malformed file is an error shown to the player, never silently replaced.
 */

import vehiclesJson from '../../../data/vehicles/vehicles.json';
import { isHttpsUrl } from '../../config/site.js';

/** @typedef {import('../../contracts/catalog.js').MapIndexEntry} MapIndexEntry */
/** @typedef {import('../../contracts/catalog.js').Credit} Credit */
/** @typedef {import('../../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../../contracts/rule.js').Source} Source */

/**
 * Loading state of the map index in the UI.
 * @typedef {{status: 'loading'} | {status: 'error', message: string}
 *   | {status: 'ready', entries: MapIndexEntry[]}} MapsState
 */

/**
 * @param {unknown} v Value.
 * @returns {v is Record<string, unknown>} Plain object.
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} v Value.
 * @returns {v is string} Non-empty string.
 */
function isText(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * @param {unknown} v Value.
 * @returns {boolean} `{vi: string}` text.
 */
function isLocalText(v) {
  return isObject(v) && isText(v.vi);
}

/**
 * Validates `public/maps/index.json`.
 * @param {unknown} json Parsed JSON.
 * @returns {MapIndexEntry[]} Entries.
 * @throws {Error} When the shape is wrong.
 */
export function parseMapIndex(json) {
  if (!Array.isArray(json)) throw new Error('map index must be an array');
  return json.map((entry, i) => {
    if (
      !isObject(entry) ||
      !isText(entry.id) ||
      !isLocalText(entry.name) ||
      (entry.kind !== 'tutorial' && entry.kind !== 'osm') ||
      typeof entry.lengthM !== 'number' ||
      !(entry.lengthM >= 0) ||
      (entry.attribution !== undefined && !isText(entry.attribution))
    ) {
      throw new Error(`map index entry ${i} is malformed`);
    }
    return /** @type {MapIndexEntry} */ (/** @type {unknown} */ (entry));
  });
}

/**
 * Validates `data/credits/credits.json`.
 * @param {unknown} json Parsed JSON.
 * @returns {Credit[]} Credits.
 * @throws {Error} When the shape is wrong.
 */
export function parseCredits(json) {
  if (!Array.isArray(json)) throw new Error('credits must be an array');
  return json.map((c, i) => {
    if (
      !isObject(c) ||
      !['file', 'title', 'author', 'sourceUrl', 'licence', 'licenceUrl'].every((k) => isText(c[k])) ||
      !isHttpsUrl(c.sourceUrl) ||
      !isHttpsUrl(c.licenceUrl) ||
      typeof c.ownWork !== 'boolean' ||
      (c.creditLine !== undefined && !isText(c.creditLine))
    ) {
      throw new Error(`credit ${i} is malformed`);
    }
    return /** @type {Credit} */ (/** @type {unknown} */ (c));
  });
}

/**
 * Validates the vehicle catalog.
 * @param {unknown} json Parsed JSON.
 * @returns {VehicleInfo[]} Vehicles.
 * @throws {Error} When the shape is wrong.
 */
export function parseVehicles(json) {
  if (!Array.isArray(json) || json.length === 0) throw new Error('vehicle catalog must be a non-empty array');
  return json.map((v, i) => {
    if (
      !isObject(v) ||
      !isText(v.id) ||
      !isLocalText(v.name) ||
      !['car', 'motorbike', 'moped'].includes(/** @type {string} */ (v.legalClass)) ||
      (v.gearbox !== 'manual' && v.gearbox !== 'auto')
    ) {
      throw new Error(`vehicle ${i} is malformed`);
    }
    return /** @type {VehicleInfo} */ (/** @type {unknown} */ (v));
  });
}

/** Vehicles from `data/vehicles/vehicles.json`, validated once at load. */
export const VEHICLES = Object.freeze(parseVehicles(vehiclesJson));

/**
 * Fetches and validates the built map index.
 * @param {typeof fetch} [fetchFn] Fetch implementation.
 * @param {string} [url] Index URL.
 * @returns {Promise<MapIndexEntry[]>} Entries.
 * @throws {Error} On a network, HTTP or shape error.
 */
export async function loadMapIndex(fetchFn = fetch, url = `${import.meta.env.BASE_URL}maps/index.json`) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`map index request failed: HTTP ${res.status}`);
  return parseMapIndex(await res.json());
}

// Optional build outputs of other modules: a glob yields no entry until the file exists, so the
// UI builds and shows an empty state before then instead of failing the build.
const creditFiles = import.meta.glob('/data/credits/credits.json', { eager: true, import: 'default' });
const rulesFiles = import.meta.glob('/src/generated/rules.json', { import: 'default' });

/**
 * Asset credits, or null when the credits file is not built yet.
 * @returns {Credit[] | null} Credits.
 * @throws {Error} When the file is malformed.
 */
export function loadCredits() {
  const files = Object.values(creditFiles);
  return files.length > 0 ? parseCredits(files[0]) : null;
}

/**
 * Legal sources listed on the disclaimer page, from a rules bundle.
 * @param {unknown} bundle Parsed rules bundle.
 * @returns {Source[]} Sources with the fields the page shows.
 * @throws {Error} When the sources are malformed.
 */
export function sourcesOf(bundle) {
  if (!isObject(bundle) || !Array.isArray(bundle.sources)) throw new Error('rules bundle has no sources');
  return bundle.sources.map((s, i) => {
    if (!isObject(s) || !isText(s.id) || !isText(s.title) || !isText(s.number) || !isHttpsUrl(s.url)) {
      throw new Error(`source ${i} is malformed`);
    }
    return /** @type {Source} */ (/** @type {unknown} */ (s));
  });
}

/**
 * Loads the legal sources from the built rules bundle.
 * @returns {Promise<Source[] | null>} Sources, or null when the bundle is not built yet.
 * @throws {Error} When the bundle is malformed.
 */
export async function loadSources() {
  const loaders = Object.values(rulesFiles);
  if (loaders.length === 0) return null;
  return sourcesOf(await loaders[0]());
}
