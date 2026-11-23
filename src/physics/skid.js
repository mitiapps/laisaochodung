/**
 * Skid detection. The ray-cast vehicle limits each wheel's impulse to a friction circle,
 * `hypot(0.5 · forward, side) ≤ suspensionForce · DT · frictionSlip`; a wheel that hits the
 * limit slides. Rapier does not expose its internal sliding flag to JS, so it is recomputed here.
 */

/** Fraction of the grip budget at which a wheel counts as sliding. */
export const SKID_BUDGET_FRACTION = 0.98;

/** Chassis lateral speed above which every grounded wheel counts as sliding, m/s. */
export const SKID_LATERAL_SPEED_MPS = 1.5;

/** Below this ground speed no skid is reported (budget and demand both vanish at rest), m/s. */
export const SKID_MIN_SPEED_MPS = 0.5;

/**
 * Whether one wheel slides this step.
 * @param {object} w Wheel readout.
 * @param {boolean} w.contact Wheel touches the ground.
 * @param {number} w.suspensionForce Suspension force in N.
 * @param {number} w.frictionSlip Current `frictionSlip`.
 * @param {number} w.forwardImpulse Forward impulse this step.
 * @param {number} w.sideImpulse Side impulse this step.
 * @param {number} dt Step in seconds.
 * @param {number} speedMps Chassis ground speed magnitude.
 * @param {number} lateralSpeedMps Chassis lateral speed magnitude.
 * @returns {boolean} Sliding.
 */
export function wheelSkids(w, dt, speedMps, lateralSpeedMps) {
  if (!w.contact || speedMps < SKID_MIN_SPEED_MPS) return false;
  if (lateralSpeedMps > SKID_LATERAL_SPEED_MPS) return true;
  const budget = w.suspensionForce * dt * w.frictionSlip;
  if (!(budget > 1e-6)) return false;
  return Math.hypot(0.5 * w.forwardImpulse, w.sideImpulse) >= SKID_BUDGET_FRACTION * budget;
}

/**
 * `frictionSlip` that turns Rapier's anisotropic friction ellipse into a circle.
 *
 * Rapier limits `hypot(0.5 · forward, side)` to `N · DT · frictionSlip`, so a wheel grips twice as
 * hard along its rolling direction as across it. Real tyres grip about the same both ways. Scaling
 * `frictionSlip` by `2 · hypot(0.5·F, S) / hypot(F, S)` from the previous step's impulses makes the
 * limit `hypot(F, S) ≤ N · DT · 2 · frictionSlip` whatever the mix: pure braking keeps
 * `frictionSlip`, pure cornering gets twice it.
 * @param {number} baseSlip Braking `frictionSlip` times the surface grip.
 * @param {number} forwardImpulse Previous step's forward impulse.
 * @param {number} sideImpulse Previous step's side impulse.
 * @returns {number} `frictionSlip` to use this step.
 */
export function isotropicFrictionSlip(baseSlip, forwardImpulse, sideImpulse) {
  const full = Math.hypot(forwardImpulse, sideImpulse);
  if (!(full > 1e-6)) return baseSlip * 2;
  return (baseSlip * 2 * Math.hypot(0.5 * forwardImpulse, sideImpulse)) / full;
}
