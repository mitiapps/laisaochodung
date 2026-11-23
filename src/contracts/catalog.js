/**
 * Catalog files: the built map index and the asset credits.
 */

/**
 * One entry of `public/maps/index.json` (`MapIndexEntry[]`).
 * @typedef {object} MapIndexEntry
 * @property {string} id Map id; the map is `public/maps/<id>.json`.
 * @property {import('./vehicle.js').LocalText} name Display name.
 * @property {'tutorial' | 'osm'} kind Map kind.
 * @property {number} lengthM Route length in metres.
 * @property {string} [attribution] Attribution shown with OSM maps.
 */

/**
 * One entry of `data/credits/credits.json` (`Credit[]`).
 * @typedef {object} Credit
 * @property {string} file Asset path relative to `public/`.
 * @property {string} title Work title.
 * @property {string} author Author.
 * @property {string} sourceUrl Where the asset was obtained.
 * @property {string} licence Licence name, e.g. `CC BY 3.0`.
 * @property {string} licenceUrl Licence URL.
 * @property {string} [creditLine] Exact credit line to show.
 * @property {boolean} ownWork Drawn for this project (Apache-2.0).
 */

export {};
