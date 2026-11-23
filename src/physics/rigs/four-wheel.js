/**
 * Car rig: four ray wheels in the telemetry order front-left, front-right, rear-left, rear-right.
 * Front wheels steer, rear wheels drive. One brake pedal (`brakeFront`) feeds both axles through
 * the front and rear caps (70/30 in the sedan tuning). The handbrake locks the rear axle and
 * lowers its lateral grip so the car oversteers. A wheel that brakes never gets engine force,
 * since Rapier ignores the brake on a wheel with engine force.
 */

/** @typedef {import('../tuning.js').VehicleTuning} VehicleTuning */
/** @typedef {import('../../contracts/controls.js').ControlInput} ControlInput */

/**
 * @typedef {object} WheelCommand
 * @property {number} engine Engine force in N.
 * @property {number} brake Brake impulse cap per step.
 * @property {number} steer Steering angle in radians, + left.
 * @property {number} sideStiffness Lateral grip multiplier.
 */

/**
 * Per-wheel commands of the car.
 * @param {VehicleTuning} tuning Tuning.
 * @param {ControlInput} input Sanitised input.
 * @param {number} driveForceN Total drive force (signed) from the gearbox.
 * @param {number} steerAngle Road-wheel angle in radians, + left.
 * @returns {WheelCommand[]} One command per wheel.
 */
export function fourWheelCommands(tuning, input, driveForceN, steerAngle) {
  const { brakes } = tuning;
  const drivenCount = tuning.wheels.filter((w) => w.driven).length;
  return tuning.wheels.map((w) => {
    let brake = input.brakeFront * (w.front ? brakes.frontCap : brakes.rearCap);
    let sideStiffness = tuning.sideFrictionStiffness;
    if (!w.front && input.handbrake) {
      brake = Math.max(brake, brakes.handbrakeCap);
      sideStiffness = brakes.handbrakeSideStiffness;
    }
    const engine = w.driven && brake === 0 ? driveForceN / drivenCount : 0;
    if (brake === 0 && engine === 0) brake = brakes.coastCap;
    return { engine, brake, steer: w.front ? steerAngle : 0, sideStiffness };
  });
}
