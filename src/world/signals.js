/**
 * Traffic-light cycles. See `SignalCycle` in `src/contracts/map.js` for the phase order and offset.
 */

/** @typedef {import('../contracts/map.js').Signal} Signal */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').LightState} LightState */

/**
 * State of one signal at time `t`. Phases are half-open: green on [0, green), yellow on
 * [green, green + yellow), red on [green + yellow, period).
 * @param {Signal} signal Signal with its cycle.
 * @param {number} t Run time in seconds.
 * @returns {LightState} Light state.
 */
export function signalState(signal, t) {
  const { green, yellow, red, offset } = signal.cycle;
  const period = green + yellow + red;
  if (!(period > 0) || green < 0 || yellow < 0 || red < 0) {
    throw new RangeError(`Signal ${signal.id} has an invalid cycle`);
  }
  const u = (((t + offset) % period) + period) % period;
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
