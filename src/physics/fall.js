/**
 * Scripted motorbike fall: a front-wheel skid that starts above `minSpeedKmh` and lasts longer
 * than `holdS`. The speed test applies at the start of the skid only, since a locked front wheel
 * keeps sliding while the bike slows down.
 */

import { mpsToKmh } from '../contracts/units.js';

/**
 * Advances the fall timer. `heldS` is −1 while no qualifying skid is running.
 * @param {number} heldS Seconds the qualifying skid has lasted, or −1.
 * @param {{minSpeedKmh: number, holdS: number} | null} spec Fall rule; null never falls.
 * @param {boolean} frontSkid Front wheel slides this step.
 * @param {number} speedMps Ground speed magnitude.
 * @param {number} dt Step in seconds.
 * @returns {{heldS: number, fell: boolean}} New timer and whether the bike falls now.
 */
export function stepFall(heldS, spec, frontSkid, speedMps, dt) {
  if (!spec || !frontSkid) return { heldS: -1, fell: false };
  if (heldS < 0) {
    return { heldS: mpsToKmh(speedMps) > spec.minSpeedKmh ? 0 : -1, fell: false };
  }
  const next = heldS + dt;
  if (next > spec.holdS + 1e-9) return { heldS: -1, fell: true };
  return { heldS: next, fell: false };
}
