/**
 * Motorbike rig A: two in-line ray wheels (front, rear) on a chassis whose world X and Z rotations
 * are locked, so it only yaws and cannot tip over. Rapier rotation locks are world-axis, so the rig
 * is valid on flat maps only (every MVP map is flat). The front wheel steers, the rear drives, and
 * the front and rear brakes are independent (`brakeFront`, `brakeRear`). The visual lean is the
 * renderer's job.
 *
 * A stopped bike has no reverse gear: the rider pushes it backwards with the feet while
 * `pushBack` is held (`pushBackForce`). The push drives the rear wheel backwards and lifts the
 * coast brake from both wheels; the throttle or either brake cancels it at once. When the push
 * stops while the bike still rolls back slowly, the feet go down and hold it (`feetDownBrake`)
 * until it stands still. A bike rolling back with no push before it, such as one bounced back by
 * a contact, gets only the coast brake.
 */

/** @typedef {import('../tuning.js').VehicleTuning} VehicleTuning */
/** @typedef {import('../../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('./four-wheel.js').WheelCommand} WheelCommand */
/** @typedef {import('../tuning.js').PushBackSpec} PushBackSpec */

/** Highest throttle at which the push-back still acts (paramBasis: design; pedal noise). */
export const PUSH_BACK_MAX_THROTTLE = 0.02;

/**
 * The rider's push-back this step.
 * @param {PushBackSpec | null} spec Push-back tuning; null (a car) never pushes.
 * @param {ControlInput} input Sanitised input.
 * @param {number} speedMps Signed forward speed.
 * @returns {{acting: boolean, forceN: number}} Whether the push acts, and its force along +X
 *   (negative or zero; zero once the bike rolls back at the cap or faster).
 */
export function pushBackForce(spec, input, speedMps) {
  const acting =
    spec !== null &&
    input.pushBack &&
    input.throttle <= PUSH_BACK_MAX_THROTTLE &&
    input.brakeFront === 0 &&
    input.brakeRear === 0 &&
    speedMps <= spec.engageMaxForwardMps;
  if (!acting) return { acting: false, forceN: 0 };
  const fade = Math.max(0, Math.min(1, 1 - Math.max(0, -speedMps) / spec.maxSpeedMps));
  // `0 - x` keeps a faded-out force at +0 rather than −0.
  return { acting: true, forceN: 0 - spec.forceN * fade };
}

/**
 * Whether the feet stay ready to hold the bike after a push: set while the push acts, kept while
 * the bike rolls back with the throttle released, cleared once it stands still or rolls forward,
 * or on throttle.
 * @param {boolean} armed Previous value; false at spawn and after a placement.
 * @param {boolean} pushActing The push acts this step.
 * @param {ControlInput} input Sanitised input.
 * @param {number} speedMps Signed forward speed.
 * @returns {boolean} Armed this step.
 */
export function feetDownArmed(armed, pushActing, input, speedMps) {
  if (pushActing) return true;
  return armed && speedMps < 0 && input.throttle <= PUSH_BACK_MAX_THROTTLE;
}

/**
 * The rider's feet holding a slowly backing bike once the push stops: a released `pushBack` key
 * stops the bike at once instead of letting the coast brake roll it on for metres.
 * @param {PushBackSpec | null} spec Push-back tuning; null (a car) never holds.
 * @param {ControlInput} input Sanitised input.
 * @param {number} speedMps Signed forward speed.
 * @param {boolean} armed `feetDownArmed` this step: a push acted and the bike has not stopped
 *   since.
 * @returns {number} Brake for each wheel, 0 when the feet do not hold.
 */
export function feetDownBrake(spec, input, speedMps, armed) {
  if (spec === null || !armed || pushBackForce(spec, input, speedMps).acting) return 0;
  if (input.throttle > PUSH_BACK_MAX_THROTTLE) return 0;
  return speedMps < 0 && speedMps >= -spec.holdMaxBackMps ? spec.holdBrake : 0;
}

/**
 * Locks roll and pitch on the chassis.
 * @param {{setEnabledRotations: (x: boolean, y: boolean, z: boolean, wakeUp: boolean) => void}} body Chassis.
 * @returns {void}
 */
export function configureTwoWheelBody(body) {
  body.setEnabledRotations(false, true, false, true);
}

/**
 * Per-wheel commands of the motorbike.
 * @param {VehicleTuning} tuning Tuning.
 * @param {ControlInput} input Sanitised input.
 * @param {number} driveForceN Drive force from the gearbox.
 * @param {number} steerAngle Front wheel angle in radians, + left.
 * @param {number} [pushForceN] Push-back force from `pushBackForce`, negative while the rider
 *   pushes: it replaces the drive force and no wheel gets the coast brake. Default 0.
 * @param {number} [holdBrake] Brake from `feetDownBrake`; each wheel brakes at least this hard.
 *   Default 0.
 * @returns {WheelCommand[]} One command per wheel.
 */
export function twoWheelCommands(tuning, input, driveForceN, steerAngle, pushForceN = 0, holdBrake = 0) {
  const { brakes } = tuning;
  const pushing = pushForceN < 0;
  const drive = pushing ? pushForceN : driveForceN;
  return tuning.wheels.map((w) => {
    let brake = Math.max(holdBrake, w.front ? input.brakeFront * brakes.frontCap : input.brakeRear * brakes.rearCap);
    const engine = w.driven && brake === 0 ? drive : 0;
    if (brake === 0 && engine === 0 && !pushing) brake = brakes.coastCap;
    return { engine, brake, steer: w.front ? steerAngle : 0, sideStiffness: tuning.sideFrictionStiffness };
  });
}
