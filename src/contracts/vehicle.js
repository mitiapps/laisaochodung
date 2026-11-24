/**
 * Vehicle catalog contract. The catalog lives in `data/vehicles/vehicles.json` as `VehicleInfo[]`.
 */

/** @typedef {'car' | 'motorbike' | 'moped'} LegalClass Legal vehicle class; `moped` is reserved, unused in the MVP. */
/** @typedef {'D6' | 'D7'} DecreeGroup ND 168 article that penalises the class: Điều 6 cars, Điều 7 motorbikes and mopeds. */
/**
 * @typedef {'manual' | 'auto'} Gearbox Catalog gearbox. `manual`: clutchless N, R, 1–5; `auto`: N
 *   and D. With the automatic-gearbox assist a `manual` car drives on the selector R, N and D, and
 *   its ratios shift by themselves.
 */

/**
 * Localised text. `en` is optional and empty in the MVP (Vietnamese UI only).
 * @typedef {object} LocalText
 * @property {string} vi Vietnamese text.
 * @property {string} [en] English text, optional.
 */

/**
 * @typedef {object} VehicleInfo
 * @property {string} id Stable id, e.g. `car-sedan`.
 * @property {LocalText} name Display name.
 * @property {LegalClass} legalClass Legal class used by rules and speed defaults.
 * @property {DecreeGroup} decreeGroup Penalty article for this vehicle.
 * @property {number} lengthM Body length in metres (footprint).
 * @property {number} widthM Body width in metres (footprint).
 * @property {Gearbox} gearbox Gearbox kind.
 */

/** @type {readonly LegalClass[]} */
export const LEGAL_CLASSES = Object.freeze(['car', 'motorbike', 'moped']);

/** @type {readonly DecreeGroup[]} */
export const DECREE_GROUPS = Object.freeze(['D6', 'D7']);

/** @type {readonly Gearbox[]} */
export const GEARBOXES = Object.freeze(['manual', 'auto']);

/**
 * Decree group of a legal class.
 * @param {LegalClass} legalClass Legal class.
 * @returns {DecreeGroup} `D6` for cars, `D7` for motorbikes and mopeds.
 */
export function decreeGroupOf(legalClass) {
  return legalClass === 'car' ? 'D6' : 'D7';
}
