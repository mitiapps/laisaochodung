/**
 * Physics test bench: a flat world with one vehicle and a closed-loop driver. Used by the
 * calibration tests in this directory; it has no game logic and the sim does not use it.
 */

import { DT } from '../contracts/units.js';
import { neutralInput } from '../contracts/controls.js';
import { createVehicle } from './vehicle.js';
import { GROUP, interactionGroups } from './collision-groups.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('./tuning.js').VehicleTuning} VehicleTuning */
/** @typedef {import('../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('./vehicle.js').VehicleReadout} VehicleReadout */

/**
 * @typedef {object} Bench
 * @property {import('./vehicle.js').PhysicsVehicle} vehicle Vehicle.
 * @property {import('@dimforge/rapier3d-compat').World} world World, for tests that add colliders.
 * @property {(input: Partial<ControlInput>) => VehicleReadout} step One DT with the given input.
 * @property {(speedMps: number) => void} launch Set a forward speed along the current heading.
 * @property {() => void} dispose Free the world.
 */

/**
 * Flat bench world.
 * @param {Rapier} R Initialised Rapier.
 * @param {VehicleTuning} tuning Tuning.
 * @param {number} [surfaceGrip] Grip, default 1.
 * @returns {Bench} Bench.
 */
export function createBench(R, tuning, surfaceGrip = 1) {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  world.createCollider(
    R.ColliderDesc.cuboid(2000, 0.5, 2000)
      .setTranslation(0, -0.5, 0)
      .setCollisionGroups(interactionGroups(GROUP.GROUND, 0xffff)),
  );
  const vehicle = createVehicle(R, world, tuning, surfaceGrip, { x: 0, z: 0 }, 0);
  /** @type {Bench['step']} */
  const step = (partial) => {
    vehicle.prepare({ ...neutralInput(), ...partial });
    world.step();
    return vehicle.read();
  };
  for (let i = 0; i < 60; i += 1) step({});
  return {
    vehicle,
    world,
    step,
    launch(speedMps) {
      vehicle.setForwardSpeed(speedMps);
    },
    dispose() {
      vehicle.dispose();
      world.free();
    },
  };
}

/**
 * Closed-loop driver that holds a circle at a target speed: feed-forward wheel angle `atan(L/R)`
 * plus proportional corrections on radial and heading error, throttle on speed error.
 * @param {Bench} bench Bench.
 * @param {{cx: number, cz: number, radius: number, left: boolean, speedMps: number, seconds: number,
 *   settleS: number}} opts Circle, direction, speed and timing.
 * @returns {{maxRadialError: number, meanSpeed: number, skidSteps: number}} Stats after settling.
 */
export function driveCircle(bench, opts) {
  const { tuning } = bench.vehicle;
  const front = tuning.wheels.filter((w) => w.front);
  const rear = tuning.wheels.filter((w) => !w.front);
  const wheelbase = front[0].x - rear[0].x;
  const sign = opts.left ? 1 : -1;
  let maxRadialError = 0;
  let speedSum = 0;
  let samples = 0;
  let skidSteps = 0;
  let r = bench.vehicle.read();
  const total = Math.round(opts.seconds / DT);
  const settle = Math.round(opts.settleS / DT);
  for (let k = 0; k < total; k += 1) {
    const rx = r.pos.x - opts.cx;
    const rz = r.pos.z - opts.cz;
    const dist = Math.hypot(rx, rz);
    const radialError = dist - opts.radius;
    // Tangent of the circle in the driving direction.
    const tx = opts.left ? rz : -rz;
    const tz = opts.left ? -rx : rx;
    const want = Math.atan2(-tz, tx);
    let headingError = want - r.heading;
    headingError = Math.atan2(Math.sin(headingError), Math.cos(headingError));
    const angle = sign * Math.atan(wheelbase / opts.radius) + sign * 0.08 * radialError + 0.8 * headingError;
    const lock = tuning.steering.maxLockRad / (1 + Math.abs(r.speed) / tuning.steering.refSpeedMps);
    const steer = Math.max(-1, Math.min(1, -angle / lock));
    const throttle = Math.max(0, Math.min(1, 0.5 * (opts.speedMps - r.speed)));
    r = bench.step({ steer, throttle, gearCmd: null });
    if (k >= settle) {
      maxRadialError = Math.max(maxRadialError, Math.abs(radialError));
      speedSum += r.speed;
      samples += 1;
      if (r.wheels.some((w) => w.skid > 0)) skidSteps += 1;
    }
  }
  return { maxRadialError, meanSpeed: speedSum / Math.max(1, samples), skidSteps };
}

/**
 * Brakes from a launch speed until the vehicle stops, then holds the brake for `holdS`.
 * @param {Bench} bench Bench.
 * @param {number} speedMps Launch speed.
 * @param {Partial<ControlInput>} input Brake input held throughout.
 * @param {number} [holdS] Seconds to keep braking after the stop, default 2.
 * @returns {{distance: number, skidSteps: number, frontSkidSteps: number, fell: boolean,
 *   minSpeedAfterStop: number, backwardM: number}} Stop distance along the start heading, skid
 *   counts, fall flag, the lowest signed speed and the backward travel after the first stop.
 */
export function brakeToStop(bench, speedMps, input, holdS = 2) {
  bench.launch(speedMps);
  const start = bench.vehicle.read();
  const fx = Math.cos(start.heading);
  const fz = -Math.sin(start.heading);
  const along = (/** @type {VehicleReadout} */ r) => (r.pos.x - start.pos.x) * fx + (r.pos.z - start.pos.z) * fz;
  let skidSteps = 0;
  let frontSkidSteps = 0;
  let fell = false;
  /** @type {VehicleReadout} */
  let r;
  let steps = 0;
  do {
    r = bench.step(input);
    steps += 1;
    if (r.wheels.some((w) => w.skid > 0)) skidSteps += 1;
    if (r.frontSkid) frontSkidSteps += 1;
    if (r.fell) fell = true;
  } while (r.speed > 0.01 && steps < 3600);
  const distance = along(r);
  let minSpeedAfterStop = r.speed;
  let farthest = distance;
  let backwardM = 0;
  for (let k = 0; k < Math.round(holdS / DT); k += 1) {
    r = bench.step(input);
    minSpeedAfterStop = Math.min(minSpeedAfterStop, r.speed);
    farthest = Math.max(farthest, along(r));
    backwardM = Math.max(backwardM, farthest - along(r));
  }
  return { distance, skidSteps, frontSkidSteps, fell, minSpeedAfterStop, backwardM };
}
