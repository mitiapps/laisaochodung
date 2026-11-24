/**
 * The player vehicle on Rapier's ray-cast vehicle controller. One generic body for both rigs; the
 * rig modules map the input to per-wheel commands. Per step the sim calls `prepare` (gearbox,
 * steering, wheel commands, drag, `updateVehicle`), then `world.step`, then `read`.
 */

import { DT } from '../contracts/units.js';
import { headingOf } from '../geometry/index.js';
import { GROUP, WHEEL_RAY_GROUPS, interactionGroups } from './collision-groups.js';
import { autoShiftRatio, driveForce, initialGear, shiftGear } from './gearbox.js';
import { stepFall } from './fall.js';
import { isotropicFrictionSlip, wheelSkids } from './skid.js';
import { fourWheelCommands } from './rigs/four-wheel.js';
import { configureTwoWheelBody, twoWheelCommands } from './rigs/two-wheel.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('@dimforge/rapier3d-compat').World} World */
/** @typedef {import('@dimforge/rapier3d-compat').RigidBody} RigidBody */
/** @typedef {import('@dimforge/rapier3d-compat').Collider} Collider */
/** @typedef {import('@dimforge/rapier3d-compat').DynamicRayCastVehicleController} VehicleController */
/** @typedef {import('./tuning.js').VehicleTuning} VehicleTuning */
/** @typedef {import('../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/telemetry.js').Gear} Gear */
/** @typedef {import('../contracts/telemetry.js').WheelState} WheelState */
/** @typedef {import('../contracts/telemetry.js').Pos3} Pos3 */

/** Contact force (N) above which the chassis reports a contact-force event. */
export const CONTACT_FORCE_THRESHOLD_N = 1000;

/** Air density in kg/m³ for the drag impulse. */
const AIR_DENSITY = 1.2;

/**
 * @typedef {object} VehicleReadout
 * @property {Pos3} pos Body origin.
 * @property {number} heading Heading θ.
 * @property {number} speed Signed forward speed.
 * @property {Pos3} velocity World velocity.
 * @property {number} yawRate dθ/dt, + left.
 * @property {Gear} gear Gear.
 * @property {number} rpm Engine speed.
 * @property {WheelState[]} wheels Wheels in telemetry order.
 * @property {boolean} frontSkid Any front wheel slides.
 * @property {boolean} fell The scripted fall triggered this step.
 */

/**
 * @typedef {object} PhysicsVehicle
 * @property {RigidBody} body Chassis body.
 * @property {Collider} collider Chassis collider.
 * @property {VehicleTuning} tuning Tuning.
 * @property {(pos: {x: number, z: number}, heading: number) => void} place Teleport to a pose at
 *   rest, steering centred; the gear is kept.
 * @property {(input: ControlInput) => void} prepare Apply input and update the wheels; call before
 *   `world.step`.
 * @property {() => VehicleReadout} read Readout after `world.step`; call once per step (it
 *   advances the wheel-spin estimate).
 * @property {() => {pos: {x: number, z: number}, heading: number, speed: number, velocity: Pos3}} pose
 *   Current pose and velocity without side effects.
 * @property {(speedMps: number) => void} setForwardSpeed Set the speed along the heading, for test
 *   benches.
 * @property {() => void} dispose Remove the body and controller from the world.
 */

/**
 * Unit quaternion of a heading (rotation about +Y by θ, which maps chassis +X to the heading).
 * @param {number} heading Heading θ.
 * @returns {{x: number, y: number, z: number, w: number}} Quaternion.
 */
export function headingQuat(heading) {
  return { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
}

/**
 * Heading of a body rotation (projection of chassis +X onto the ground).
 * @param {{x: number, y: number, z: number, w: number}} q Quaternion.
 * @returns {number} Heading θ.
 */
export function quatHeading(q) {
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  return headingOf(fx, fz);
}

/**
 * Steering lock at a speed: halves at `refSpeedMps`.
 * @param {VehicleTuning} tuning Tuning.
 * @param {number} speedMps Speed magnitude.
 * @returns {number} Lock in radians.
 */
export function steeringLock(tuning, speedMps) {
  return tuning.steering.maxLockRad / (1 + Math.abs(speedMps) / tuning.steering.refSpeedMps);
}

/**
 * @typedef {object} VehicleOptions
 * @property {boolean} [autoGearbox] Manual gearbox: drive it through the R, N, D selector with
 *   automatic ratio changes. An automatic gearbox ignores it.
 */

/**
 * Builds the player vehicle in a world.
 * @param {Rapier} R Initialised Rapier module.
 * @param {World} world World.
 * @param {VehicleTuning} tuning Tuning.
 * @param {number} surfaceGrip Map grip multiplier (1 dry).
 * @param {{x: number, z: number}} pos Start position.
 * @param {number} heading Start heading.
 * @param {VehicleOptions} [options] Options; default the plain gearbox.
 * @returns {PhysicsVehicle} Vehicle.
 */
export function createVehicle(R, world, tuning, surfaceGrip, pos, heading, options = {}) {
  if (!(surfaceGrip > 0)) throw new RangeError(`surfaceGrip must be positive, got ${surfaceGrip}`);
  const gearbox = tuning.gearbox;
  const autoShift = gearbox.kind === 'manual' && options.autoGearbox === true;
  if (autoShift && !gearbox.autoShift) throw new Error(`Vehicle ${tuning.id} has no autoShift tuning`);
  const shiftMode = { autoShift };
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, tuning.spawnHeight, pos.z)
      .setRotation(headingQuat(heading))
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAngularDamping(0.5),
  );
  if (tuning.rig === 'two-wheel') configureTwoWheelBody(body);
  const { chassis } = tuning;
  const collider = world.createCollider(
    R.ColliderDesc.cuboid(chassis.halfLength, chassis.halfHeight, chassis.halfWidth)
      .setTranslation(0, chassis.offsetY, 0)
      .setMass(tuning.massKg)
      .setFriction(0.3)
      .setCollisionGroups(interactionGroups(GROUP.EGO, GROUP.GROUND | GROUP.KERB | GROUP.STATIC | GROUP.ACTOR))
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(CONTACT_FORCE_THRESHOLD_N),
    body,
  );
  const controller = world.createVehicleController(body);
  const baseSlip = tuning.frictionSlip * surfaceGrip;
  const s = tuning.suspension;
  tuning.wheels.forEach((w, i) => {
    controller.addWheel({ x: w.x, y: 0, z: w.z }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, s.restLength, tuning.wheelRadius);
    controller.setWheelSuspensionStiffness(i, s.stiffness);
    controller.setWheelSuspensionCompression(i, s.compression);
    controller.setWheelSuspensionRelaxation(i, s.relaxation);
    controller.setWheelMaxSuspensionTravel(i, s.maxTravel);
    controller.setWheelMaxSuspensionForce(i, s.maxForce);
    controller.setWheelFrictionSlip(i, baseSlip);
    controller.setWheelSideFrictionStiffness(i, tuning.sideFrictionStiffness);
  });
  const commands = tuning.rig === 'two-wheel' ? twoWheelCommands : fourWheelCommands;
  const drivenIdx = tuning.wheels.flatMap((w, i) => (w.driven ? [i] : []));

  let gear = initialGear(gearbox, shiftMode);
  // Auto-shift only: the ratio engaged behind the selector's D, and the time since it changed. It
  // is kept through N and R, so D re-engages at a ratio that suits the speed.
  let engaged = 1;
  let sinceShiftS = 0;
  let steerAngle = 0;
  let rpm = tuning.gearbox.idleRpm;
  let fallHeldS = -1;
  let fell = false;
  /** @type {number[]} */
  let prevRotation = tuning.wheels.map(() => 0);
  /** @type {number[]} */
  let spin = tuning.wheels.map(() => 0);
  /** @type {boolean[]} */
  let skids = tuning.wheels.map(() => false);
  let disposed = false;

  /** @returns {number} Signed forward speed from the chassis velocity. */
  const speedNow = () => {
    const v = body.linvel();
    const h = quatHeading(body.rotation());
    return v.x * Math.cos(h) - v.z * Math.sin(h);
  };

  /** @returns {number} Chassis lateral speed magnitude. */
  const lateralSpeed = () => {
    const v = body.linvel();
    const h = quatHeading(body.rotation());
    // Right of θ is (sin θ, cos θ) in (x, z).
    return Math.abs(v.x * Math.sin(h) + v.z * Math.cos(h));
  };

  return {
    body,
    collider,
    tuning,

    place(p, h) {
      body.setTranslation({ x: p.x, y: tuning.spawnHeight, z: p.z }, true);
      body.setRotation(headingQuat(h), true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      steerAngle = 0;
      engaged = 1;
      fallHeldS = -1;
      spin = spin.map(() => 0);
      skids = skids.map(() => false);
      tuning.wheels.forEach((_, i) => {
        controller.setWheelSteering(i, 0);
        controller.setWheelEngineForce(i, 0);
      });
    },

    prepare(input) {
      const speed = speedNow();
      gear = shiftGear(gearbox, gear, input.gearCmd, speed, shiftMode);

      // Steering: −input.steer because ControlInput +1 is right and the wheel angle + is left.
      const target = -input.steer * steeringLock(tuning, speed);
      const maxDelta = tuning.steering.rateRadPerS * DT;
      steerAngle += Math.max(-maxDelta, Math.min(maxDelta, target - steerAngle));

      const drivenSpin = drivenIdx.reduce((sum, i) => sum + spin[i], 0) / Math.max(1, drivenIdx.length);
      /** @type {Gear} */
      let driveGear = gear;
      if (autoShift && gearbox.kind === 'manual') {
        sinceShiftS += DT;
        if (gear === 'D') {
          const next = autoShiftRatio(gearbox, engaged, { throttle: input.throttle, speedMps: speed, wheelSpin: drivenSpin, sinceShiftS });
          if (next !== engaged) {
            engaged = next;
            sinceShiftS = 0;
          }
          driveGear = /** @type {Gear} */ (engaged);
        }
      }
      const drive = driveForce(gearbox, driveGear, input.throttle, speed, drivenSpin, tuning.wheelRadius);
      rpm = drive.rpm;
      commands(tuning, input, drive.forceN, steerAngle).forEach((c, i) => {
        controller.setWheelEngineForce(i, c.engine);
        controller.setWheelBrake(i, c.brake);
        controller.setWheelSteering(i, c.steer);
        controller.setWheelSideFrictionStiffness(i, c.sideStiffness);
      });

      // Aerodynamic drag as an impulse against the velocity.
      const v = body.linvel();
      const vh = Math.hypot(v.x, v.z);
      if (vh > 1e-3) {
        const j = 0.5 * AIR_DENSITY * tuning.dragCdA * vh * vh * DT;
        body.applyImpulse({ x: (-v.x / vh) * j, y: 0, z: (-v.z / vh) * j }, true);
      }

      tuning.wheels.forEach((_, i) => {
        const slip = isotropicFrictionSlip(
          baseSlip,
          controller.wheelForwardImpulse(i) ?? 0,
          controller.wheelSideImpulse(i) ?? 0,
        );
        controller.setWheelFrictionSlip(i, slip);
      });
      controller.updateVehicle(DT, undefined, WHEEL_RAY_GROUPS);

      const ground = Math.abs(speed);
      const lat = lateralSpeed();
      skids = tuning.wheels.map((_, i) =>
        wheelSkids(
          {
            contact: controller.wheelIsInContact(i),
            suspensionForce: controller.wheelSuspensionForce(i) ?? 0,
            frictionSlip: controller.wheelFrictionSlip(i) ?? 0,
            forwardImpulse: controller.wheelForwardImpulse(i) ?? 0,
            sideImpulse: controller.wheelSideImpulse(i) ?? 0,
          },
          DT,
          ground,
          lat,
        ),
      );
      const frontSkid = tuning.wheels.some((w, i) => w.front && skids[i]);
      const f = stepFall(fallHeldS, tuning.fall, frontSkid, ground, DT);
      fallHeldS = f.heldS;
      fell = f.fell;
    },

    setForwardSpeed(speedMps) {
      const h = quatHeading(body.rotation());
      body.setLinvel({ x: Math.cos(h) * speedMps, y: 0, z: -Math.sin(h) * speedMps }, true);
    },

    pose() {
      const t = body.translation();
      const v = body.linvel();
      return { pos: { x: t.x, z: t.z }, heading: quatHeading(body.rotation()), speed: speedNow(), velocity: { x: v.x, y: v.y, z: v.z } };
    },

    read() {
      const t = body.translation();
      const v = body.linvel();
      const rotation = tuning.wheels.map((_, i) => controller.wheelRotation(i) ?? 0);
      // Rapier's wheel rotation grows while rolling forward.
      spin = rotation.map((r, i) => (r - prevRotation[i]) / DT);
      prevRotation = rotation;
      /** @type {WheelState[]} */
      const wheels = tuning.wheels.map((_, i) => ({
        contact: controller.wheelIsInContact(i),
        skid: skids[i] ? 1 : 0,
        steer: controller.wheelSteering(i) ?? 0,
        spin: spin[i],
        compression: Math.max(0, tuning.suspension.restLength - (controller.wheelSuspensionLength(i) ?? tuning.suspension.restLength)),
      }));
      return {
        pos: { x: t.x, y: t.y, z: t.z },
        heading: quatHeading(body.rotation()),
        speed: speedNow(),
        velocity: { x: v.x, y: v.y, z: v.z },
        yawRate: body.angvel().y,
        gear,
        rpm,
        wheels,
        frontSkid: tuning.wheels.some((w, i) => w.front && skids[i]),
        fell,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      world.removeVehicleController(controller);
      world.removeRigidBody(body);
    },
  };
}
