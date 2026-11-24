/**
 * Intelligent Driver Model (Treiber, Hennecke and Helbing 2000), the longitudinal controller of
 * every traffic agent:
 *
 * `dv/dt = a · [1 − (v/v0)^δ − (s_star / s)²]`, with `s_star = s0 + max(0, v·T + v·Δv / (2·√(a·b)))`.
 *
 * Pure arithmetic on numbers; the caller clamps the result at the agent's braking limit.
 */

/**
 * IDM acceleration.
 * @param {number} v Own speed, m/s, at least 0.
 * @param {number} v0 Desired speed, m/s, positive.
 * @param {number} gap Bumper-to-bumper gap to the leader, metres; Infinity on a free road.
 * @param {number} dv Approach rate `v − v_leader`, m/s.
 * @param {number} a Maximum acceleration, m/s².
 * @param {number} b Comfortable deceleration, m/s².
 * @param {number} timeGap Safe time gap T, s.
 * @param {number} s0 Jam distance, metres.
 * @param {number} delta Acceleration exponent δ.
 * @returns {number} Acceleration, m/s² (unclamped; very negative when the gap is tiny).
 */
export function idmAcceleration(v, v0, gap, dv, a, b, timeGap, s0, delta) {
  const free = 1 - Math.pow(v / v0, delta);
  if (gap === Infinity) return a * free;
  const sStar = s0 + Math.max(0, v * timeGap + (v * dv) / (2 * Math.sqrt(a * b)));
  const s = Math.max(gap, 1e-3);
  return a * (free - (sStar / s) * (sStar / s));
}

/**
 * Equilibrium gap of a homogeneous IDM queue at speed `v`: `(s0 + vT) / √(1 − (v/v0)^δ)`, which
 * is `s0 + vT` for `v` well below `v0`.
 * @param {number} v Speed, m/s.
 * @param {number} v0 Desired speed, m/s.
 * @param {number} timeGap Safe time gap T, s.
 * @param {number} s0 Jam distance, metres.
 * @param {number} delta Acceleration exponent δ.
 * @returns {number} Exact equilibrium gap, metres (Infinity at or above `v0`).
 */
export function idmEquilibriumGap(v, v0, timeGap, s0, delta) {
  const free = 1 - Math.pow(v / v0, delta);
  if (free <= 0) return Infinity;
  return (s0 + v * timeGap) / Math.sqrt(free);
}

/**
 * Ballistic update of one step with a stop at zero speed, so a braking agent never rolls back.
 * Writes `[ds, vNext]` into `out`.
 * @param {number} v Speed now.
 * @param {number} acc Acceleration for the step.
 * @param {number} dt Step.
 * @param {Float64Array | number[]} out Output pair.
 * @returns {void}
 */
export function integrate(v, acc, dt, out) {
  const vNext = v + acc * dt;
  if (vNext < 0) {
    out[0] = acc < 0 ? (v * v) / (-2 * acc) : 0;
    out[1] = 0;
    return;
  }
  out[0] = v * dt + 0.5 * acc * dt * dt;
  out[1] = vNext;
}
