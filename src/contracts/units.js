/**
 * Units, axes and time base shared by every module.
 *
 * - Lengths in metres, time in seconds, angles in radians.
 * - Speeds are m/s inside frames and maps (actor speeds); km/h only for display and for rule
 *   parameters and zone values (`valueKmh`).
 * - World axes: +X east, +Y up, +Z south. A 2D point `[x, z]` is the ground projection.
 * - OSM projection around the map origin (φ0, λ0): `x = R·Δλ·cos φ0`, `z = −R·Δφ`.
 * - Heading θ: forward = (cos θ, 0, −sin θ). θ = 0 faces east, θ = π/2 faces north; θ grows
 *   counter-clockwise seen from above. Left of a heading is (−sin θ, −cos θ) in (x, z).
 * - Traffic drives on the right.
 * - Fixed simulation step DT = 1/60 s; the frame of tick k has `t = k · DT`.
 */

/** Fixed simulation step in seconds. */
export const DT = 1 / 60;

/** Simulation ticks per second. */
export const TICK_HZ = 60;

/** Earth radius in metres used by the OSM projection. */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Minutes in a day, for clock wrap-around. */
export const MINUTES_PER_DAY = 1440;

/**
 * Converts km/h to m/s.
 * @param {number} kmh Speed in km/h.
 * @returns {number} Speed in m/s.
 */
export function kmhToMps(kmh) {
  return kmh / 3.6;
}

/**
 * Converts m/s to km/h.
 * @param {number} mps Speed in m/s.
 * @returns {number} Speed in km/h.
 */
export function mpsToKmh(mps) {
  return mps * 3.6;
}

/**
 * Frame time of a tick.
 * @param {number} tick Tick index, 0 for the first frame.
 * @returns {number} Time in seconds.
 */
export function tickTime(tick) {
  return tick * DT;
}
