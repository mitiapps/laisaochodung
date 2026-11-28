/**
 * Vehicle tuning typedefs. One tuning file per catalog id lives in `vehicles/`; the values there
 * are calibrated by the tests next to them (see `docs/physics.md`).
 *
 * Chassis space: +X forward, +Y up, +Z right (Rapier's default forward axis is X). Body origin sits
 * at the wheel connection height.
 */

/**
 * @typedef {object} WheelSpec
 * @property {number} x Connection point along +X (forward) in metres.
 * @property {number} z Connection point along +Z (right) in metres.
 * @property {boolean} front Steering wheel; front brake circuit.
 * @property {boolean} driven Receives engine force.
 */

/**
 * @typedef {object} SuspensionSpec
 * @property {number} restLength Rest length in metres.
 * @property {number} maxTravel Maximum travel in metres.
 * @property {number} stiffness Spring stiffness (Rapier units, scaled by chassis mass).
 * @property {number} compression Damping while compressing.
 * @property {number} relaxation Damping while extending.
 * @property {number} maxForce Force cap in newtons.
 */

/**
 * @typedef {object} ManualGearboxSpec
 * @property {'manual'} kind Clutchless manual: N, R, 1–5.
 * @property {number[]} ratios Ratios of gears 1–5.
 * @property {number} reverseRatio Reverse ratio.
 * @property {number} finalDrive Final drive ratio.
 * @property {number} efficiency Driveline efficiency 0..1.
 * @property {number} peakTorqueNm Flat engine torque in N·m.
 * @property {number} idleRpm Idle speed.
 * @property {number} redlineRpm Rev limiter; no drive force above it.
 * @property {number} maxReverseShiftKmh Shifting into R is refused at or above this speed.
 * @property {AutoShiftSpec} autoShift Shift points of the auto-shift assist (selector R, N, D).
 */

/**
 * Auto-shift assist of a manual gearbox. `downRpm` stays well below the rpm right after an
 * up-shift, and `minIntervalS` spaces the shifts, so the box cannot hunt.
 * @typedef {object} AutoShiftSpec
 * @property {number} upRpm Shift up one gear at or above this engine speed with the throttle open.
 * @property {number} downRpm Shift down at or below this engine speed.
 * @property {number} minIntervalS Shortest time between two shifts.
 */

/**
 * @typedef {object} AutoGearboxSpec
 * @property {'auto'} kind CVT automatic: N and D.
 * @property {number} maxForceN Drive force at standstill, full throttle.
 * @property {number} topSpeedMps Speed at which the drive force reaches zero.
 * @property {number} idleRpm Idle speed.
 * @property {number} redlineRpm Highest engine speed.
 */

/** @typedef {ManualGearboxSpec | AutoGearboxSpec} GearboxSpec */

/**
 * @typedef {object} VehicleTuning
 * @property {string} id Catalog id.
 * @property {'four-wheel' | 'two-wheel'} rig Rig kind.
 * @property {number} massKg Total mass (vehicle plus driver).
 * @property {{halfLength: number, halfHeight: number, halfWidth: number, offsetY: number}} chassis
 *   Collider box half extents and its centre height relative to the body origin.
 * @property {number} spawnHeight Body origin height when placed on flat ground.
 * @property {WheelSpec[]} wheels Wheels in the telemetry order.
 * @property {number} wheelRadius Wheel radius in metres.
 * @property {SuspensionSpec} suspension Suspension, same for every wheel.
 * @property {number} frictionSlip Dry-asphalt `frictionSlip`, multiplied by the map surface grip.
 * @property {number} sideFrictionStiffness Lateral grip multiplier.
 * @property {{frontCap: number, rearCap: number, handbrakeCap: number, handbrakeSideStiffness: number,
 *   coastCap: number, combinedRearPerGrip?: number}} brakes Per-wheel brake impulse caps per step at
 *   full input. `coastCap` is the rolling and engine-drag brake applied while a wheel is neither
 *   braked nor driven. `combinedRearPerGrip` (motorbikes only): the rear brake the simple preset's
 *   one brake key adds, per unit of surface grip, next to the capped front.
 * @property {{maxLockRad: number, refSpeedMps: number, rateRadPerS: number}} steering Lock at
 *   standstill, the speed at which the lock halves, and the steering rate limit.
 * @property {number} dragCdA Drag coefficient times frontal area in m².
 * @property {GearboxSpec} gearbox Gearbox.
 * @property {{minSpeedKmh: number, holdS: number} | null} fall Scripted fall on a sustained front
 *   skid (motorbikes); null for cars.
 * @property {PushBackSpec | null} pushBack The rider pushing the bike backwards with the feet
 *   (`ControlInput.pushBack`, motorbikes); null for cars, which reverse through their R gear.
 */

/**
 * Push-back of a stopped motorbike by the rider's feet. It acts while `pushBack` is held with the
 * throttle at most `PUSH_BACK_MAX_THROTTLE`, both brakes released and a signed forward speed at
 * most `engageMaxForwardMps`. The force fades linearly from `forceN` at standstill (or rolling
 * forward) to 0 at `maxSpeedMps` backwards, as the CVT drive force fades to its top speed. Once
 * the push stops while the bike still rolls back no faster than `holdMaxBackMps`, with the throttle
 * released, the rider's feet go down: both wheels get `holdBrake` until the bike stands still.
 * @typedef {object} PushBackSpec
 * @property {number} forceN Backward force at standstill in newtons.
 * @property {number} maxSpeedMps Backward speed at which the force reaches zero.
 * @property {number} engageMaxForwardMps Highest signed forward speed at which the push acts.
 * @property {number} holdBrake Brake on each wheel while the feet hold a slowly backing bike.
 * @property {number} holdMaxBackMps Fastest backward roll the feet still hold.
 */

export {};
