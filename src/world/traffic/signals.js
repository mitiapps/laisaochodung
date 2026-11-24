/**
 * Signal view for traffic agents: the light an approach lane faces and how long its yellow lasts.
 * The light state comes from the step input (`trafficLightStates`); the remaining yellow comes
 * from the same cycle, so both always agree for the same `t`.
 */

/** @typedef {import('../../contracts/map.js').Signal} Signal */
/** @typedef {import('../../contracts/telemetry.js').LightState} LightState */

/**
 * Seconds of yellow left at `t`, or 0 outside the yellow phase. Handles negative `t` (the pre-roll)
 * with the same double modulo as `signalState`.
 * @param {Signal} signal Signal.
 * @param {number} t Run time.
 * @returns {number} Seconds.
 */
export function yellowRemaining(signal, t) {
  const { green, yellow, red, offset } = signal.cycle;
  const period = green + yellow + red;
  const u = (((t + offset) % period) + period) % period;
  return u >= green && u < green + yellow ? green + yellow - u : 0;
}

/**
 * Outcome of the fixed stop rule at a signal.
 * - `go`: the agent may pass the stop line.
 * - `stop`: the agent stops at the stop line.
 * @typedef {'go' | 'stop'} SignalDecision
 */

/**
 * Whether the front reaches the stop line, at the current speed, `marginS` before the yellow ends.
 * @param {number} distM Distance from the front to the stop line.
 * @param {number} v Speed.
 * @param {number} yellowLeftS Yellow time left.
 * @param {number} marginS Margin (`TrafficParams.behaviour.yellowGoMarginS`).
 * @returns {boolean} Reaches it in time.
 */
export function reachesBeforeRed(distM, v, yellowLeftS, marginS) {
  return v > 0.1 && distM / v < yellowLeftS - marginS;
}

/**
 * Fixed stop rule (a deterministic yellow choice; a stochastic one can replace that branch):
 * - green: go;
 * - red: stop, unless even the braking limit cannot stop the agent before the line;
 * - yellow: stop when the deceleration needed is at most the personality's `b_stop`; otherwise go
 *   if the front reaches the line before the yellow ends; otherwise stop when the braking limit
 *   allows it.
 * @param {LightState} state Light state.
 * @param {number} distM Distance from the front to the stop line, at least 0.
 * @param {number} v Speed.
 * @param {number} yellowLeftS Yellow time left.
 * @param {number} bStop Deceleration up to which the agent stops on yellow.
 * @param {number} bMax Braking limit.
 * @param {number} marginS Yellow go margin (`TrafficParams.behaviour.yellowGoMarginS`).
 * @returns {SignalDecision} Decision.
 */
export function signalDecision(state, distM, v, yellowLeftS, bStop, bMax, marginS) {
  if (state === 'green') return 'go';
  const need = distM > 0.05 ? (v * v) / (2 * distM) : v > 0.05 ? Infinity : 0;
  if (state === 'red') return need <= bMax ? 'stop' : 'go';
  if (need <= bStop) return 'stop';
  if (reachesBeforeRed(distM, v, yellowLeftS, marginS)) return 'go';
  return need <= bMax ? 'stop' : 'go';
}

/**
 * Seconds of red left at `t`, or 0 outside the red phase (same wrap as `yellowRemaining`).
 * @param {Signal} signal Signal.
 * @param {number} t Run time.
 * @returns {number} Seconds.
 */
export function redRemaining(signal, t) {
  const { green, yellow, red, offset } = signal.cycle;
  const period = green + yellow + red;
  const u = (((t + offset) % period) + period) % period;
  return u >= green + yellow ? period - u : 0;
}

/**
 * Probability that a driver stops at the yellow onset: `1 / (1 + exp(k · (b_req − b_stop)))`,
 * with `b_req = v² / (2d)` the deceleration a stop needs, so the choice is bimodal around the
 * dilemma zone. A stop beyond the braking limit is never chosen.
 * @param {number} distM Distance from the front to the stop line.
 * @param {number} v Speed.
 * @param {number} bStop The driver's `b_stop`.
 * @param {number} bMax Braking limit.
 * @param {number} k Steepness, s²/m (`ViolationParams.yellowLogisticK`).
 * @returns {number} Probability in [0, 1].
 */
export function yellowStopProbability(distM, v, bStop, bMax, k) {
  const need = distM > 0.05 ? (v * v) / (2 * distM) : v > 0.05 ? Infinity : 0;
  if (need > bMax) return 0;
  return 1 / (1 + Math.exp(k * (need - bStop)));
}
