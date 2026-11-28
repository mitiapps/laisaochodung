/**
 * Traffic-light cycles. See `SignalCycle` in `src/contracts/map.js` for the phase order and offset.
 */

/** @typedef {import('../contracts/map.js').Signal} Signal */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').LightState} LightState */

/**
 * Pedestrian head state: `walk` (steady green figure), `flashing` (flashing green figure, finish
 * crossing) or `stop` (red figure).
 * @typedef {'walk' | 'flashing' | 'stop'} PedestrianLightState
 */

/**
 * Seconds at the end of the governing green during which the pedestrian figure flashes
 * (`paramBasis: design`; QCVN 41:2024 6.5.1 asks for a flashing green before the red but sets no
 * length).
 */
export const PEDESTRIAN_FLASH_S = 5;

/**
 * Position of `t` in the signal's cycle, in [0, period).
 * @param {Signal} signal Signal with its cycle.
 * @param {number} t Run time in seconds.
 * @returns {number} Cycle position in seconds.
 */
function cyclePosition(signal, t) {
  const { green, yellow, red, offset } = signal.cycle;
  const period = green + yellow + red;
  if (!(period > 0) || green < 0 || yellow < 0 || red < 0) {
    throw new RangeError(`Signal ${signal.id} has an invalid cycle`);
  }
  return (((t + offset) % period) + period) % period;
}

/**
 * State of one signal at time `t`. Phases are half-open: green on [0, green), yellow on
 * [green, green + yellow), red on [green + yellow, period).
 * @param {Signal} signal Signal with its cycle.
 * @param {number} t Run time in seconds.
 * @returns {LightState} Light state.
 */
export function signalState(signal, t) {
  const { green, yellow } = signal.cycle;
  const u = cyclePosition(signal, t);
  if (u < green) return 'green';
  if (u < green + yellow) return 'yellow';
  return 'red';
}

/**
 * States of every map signal, keyed by signal id (the frame's `trafficLights`).
 * @param {GameMap} map Map.
 * @param {number} t Run time in seconds.
 * @returns {Record<string, LightState>} States.
 */
export function trafficLightStates(map, t) {
  /** @type {Record<string, LightState>} */
  const out = {};
  for (const signal of map.signals) out[signal.id] = signalState(signal, t);
  return out;
}

/**
 * State of the pedestrian heads of a crosswalk at time `t`, timed by its `walkSignalId`: the
 * vehicle signal of the perpendicular axis, whose green is when the crossing traffic stands. Walk
 * while that signal is green, flashing for the last `PEDESTRIAN_FLASH_S` of its green (all of a
 * shorter green), stop through its yellow and red. Half-open like `signalState`.
 * @param {Signal} walkSignal The crosswalk's `walkSignalId` signal.
 * @param {number} t Run time in seconds.
 * @returns {PedestrianLightState} Pedestrian head state.
 */
export function pedestrianSignalState(walkSignal, t) {
  const { green } = walkSignal.cycle;
  const u = cyclePosition(walkSignal, t);
  if (u >= green) return 'stop';
  return u < green - PEDESTRIAN_FLASH_S ? 'walk' : 'flashing';
}
