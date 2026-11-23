/**
 * Motorbike rig A: two in-line ray wheels (front, rear) on a chassis whose world X and Z rotations
 * are locked, so it only yaws and cannot tip over. Rapier rotation locks are world-axis, so the rig
 * is valid on flat maps only (every MVP map is flat). The front wheel steers, the rear drives, and
 * the front and rear brakes are independent (`brakeFront`, `brakeRear`). The visual lean is the
 * renderer's job.
 */

/** @typedef {import('../tuning.js').VehicleTuning} VehicleTuning */
/** @typedef {import('../../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('./four-wheel.js').WheelCommand} WheelCommand */

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
 * @returns {WheelCommand[]} One command per wheel.
 */
export function twoWheelCommands(tuning, input, driveForceN, steerAngle) {
  const { brakes } = tuning;
  return tuning.wheels.map((w) => {
    let brake = w.front ? input.brakeFront * brakes.frontCap : input.brakeRear * brakes.rearCap;
    const engine = w.driven && brake === 0 ? driveForceN : 0;
    if (brake === 0 && engine === 0) brake = brakes.coastCap;
    return { engine, brake, steer: w.front ? steerAngle : 0, sideStiffness: tuning.sideFrictionStiffness };
  });
}
