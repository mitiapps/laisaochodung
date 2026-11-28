/**
 * Statutory default speed limit lookup (TT 38/2024 Điều 6), shared by the scorer and the traffic
 * lane graph so both resolve the same limit on a lane that no P.127 sign binds. The numbers live in
 * `data/legal/speed-defaults.yaml`; this file only picks the row.
 */

/** @typedef {import('./vehicle.js').LegalClass} LegalClass */

/**
 * The fields of a `SpeedDefault` row that pick and give a limit.
 * @typedef {object} SpeedDefaultKey
 * @property {LegalClass} legalClass Vehicle class.
 * @property {boolean} builtUp Inside an R.420 built-up area.
 * @property {boolean} multiLane Divided road, or one-way with two or more motor lanes.
 * @property {number} maxKmh Limit.
 */

/**
 * Whether a road takes the multi-lane column of the TT 38 tables: a divided road, or a one-way road
 * with two or more motor lanes.
 * @param {{divided: boolean, oneway: boolean, lanes: readonly unknown[]}} road Road.
 * @returns {boolean} Multi-lane.
 */
export function isMultiLaneRoad(road) {
  return road.divided || (road.oneway && road.lanes.length >= 2);
}

/**
 * The default-limit row for a class on a road of this kind.
 * @template {SpeedDefaultKey} T
 * @param {readonly T[]} rows Default rows.
 * @param {LegalClass} legalClass Vehicle class.
 * @param {boolean} builtUp Inside a built-up zone.
 * @param {boolean} multiLane Multi-lane road (`isMultiLaneRoad`).
 * @returns {T | null} Row, or null when none matches.
 */
export function findSpeedDefault(rows, legalClass, builtUp, multiLane) {
  return rows.find((s) => s.legalClass === legalClass && s.builtUp === builtUp && s.multiLane === multiLane) ?? null;
}
