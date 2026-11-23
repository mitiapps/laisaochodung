/**
 * In-game clock: starts at the map's `startClockMin` and advances in real time.
 */

import { MINUTES_PER_DAY } from '../contracts/units.js';

/**
 * Minute of day at run time `t`.
 * @param {import('../contracts/map.js').MapEnvironment} environment Map environment.
 * @param {number} t Run time in seconds.
 * @returns {number} Minute of day, 0 ≤ m < 1440.
 */
export function clockAt(environment, t) {
  const m = environment.startClockMin + t / 60;
  return ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
