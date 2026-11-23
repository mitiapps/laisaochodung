/**
 * Local tangent-plane projection for OSM maps: `x = R·Δλ·cos φ0`, `z = −R·Δφ` (metres, +X east,
 * +Z south; see `src/contracts/units.js`). The error is negligible over a few kilometres.
 */

import { EARTH_RADIUS_M } from '../../../src/contracts/units.js';

/** @typedef {[number, number]} Vec2 */

/**
 * @typedef {object} Bbox
 * @property {number} south Minimum latitude.
 * @property {number} west Minimum longitude.
 * @property {number} north Maximum latitude.
 * @property {number} east Maximum longitude.
 */

/**
 * @typedef {object} Projection
 * @property {{lat: number, lon: number}} origin Projection origin.
 * @property {(lat: number, lon: number) => Vec2} toXZ Geographic to local `[x, z]`.
 * @property {(x: number, z: number) => {lat: number, lon: number}} toLatLon Local to geographic.
 */

const DEG = Math.PI / 180;

/**
 * Validates a bbox and returns its centre.
 * @param {Bbox} bbox Bounding box.
 * @returns {{lat: number, lon: number}} Centre.
 */
export function bboxCentre(bbox) {
  const { south, west, north, east } = bbox ?? /** @type {Bbox} */ ({});
  for (const [k, v] of Object.entries({ south, west, north, east })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`bbox.${k} must be a number`);
  }
  if (!(south < north) || !(west < east)) throw new Error('bbox must have south < north and west < east');
  if (south < -90 || north > 90 || west < -180 || east > 180) throw new Error('bbox out of range');
  return { lat: (south + north) / 2, lon: (west + east) / 2 };
}

/**
 * Projection around an origin.
 * @param {{lat: number, lon: number}} origin Origin.
 * @returns {Projection} Projection.
 */
export function createProjection(origin) {
  const cos0 = Math.cos(origin.lat * DEG);
  return {
    origin: { lat: origin.lat, lon: origin.lon },
    toXZ: (lat, lon) => [EARTH_RADIUS_M * (lon - origin.lon) * DEG * cos0, EARTH_RADIUS_M * (origin.lat - lat) * DEG],
    toLatLon: (x, z) => ({
      lat: origin.lat - z / (EARTH_RADIUS_M * DEG),
      lon: origin.lon + x / (EARTH_RADIUS_M * DEG * cos0),
    }),
  };
}
