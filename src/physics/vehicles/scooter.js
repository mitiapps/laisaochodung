/**
 * Tuning of `scooter`: a 125 cc automatic scooter with its rider, 180 kg, on rig A (two in-line
 * ray wheels, roll and pitch locked). With pitch locked there is no load transfer, so the front
 * locks at the same lever whatever the rear does: a full front lever above the grip limit locks
 * it (and falls above 30 km/h); front at 0.6 plus full rear stops without a skid. See
 * `docs/physics.md`.
 */

/** @type {import('../tuning.js').VehicleTuning} */
export const scooter = {
  id: 'scooter',
  rig: 'two-wheel',
  massKg: 180,
  chassis: { halfLength: 0.9, halfHeight: 0.5, halfWidth: 0.3, offsetY: 0.3 },
  spawnHeight: 0.5,
  wheels: [
    { x: 0.65, z: 0, front: true, driven: false },
    { x: -0.65, z: 0, front: false, driven: true },
  ],
  wheelRadius: 0.25,
  suspension: { restLength: 0.25, maxTravel: 0.15, stiffness: 60, compression: 4, relaxation: 5, maxForce: 100000 },
  frictionSlip: 0.38,
  sideFrictionStiffness: 1,
  brakes: { frontCap: 17, rearCap: 10, handbrakeCap: 0, handbrakeSideStiffness: 1, coastCap: 0.15 },
  steering: { maxLockRad: 0.5, refSpeedMps: 6, rateRadPerS: 2 },
  dragCdA: 0.6,
  gearbox: { kind: 'auto', maxForceN: 900, topSpeedMps: 26, idleRpm: 1500, redlineRpm: 8500 },
  fall: { minSpeedKmh: 30, holdS: 0.3 },
};
