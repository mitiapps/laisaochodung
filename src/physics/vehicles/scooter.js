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
  // `combinedRearPerGrip`, paramBasis: design: the simple preset's brake key adds rear
  // `1.0 × grip` to front `0.55 × grip`. Measured on a straight stop from 50 km/h: dry 14.5 m in
  // 2.1 s, grip 0.6 23.7 m in 3.5 s; no front or rear skid and no fall at either grip.
  brakes: { frontCap: 17, rearCap: 10, handbrakeCap: 0, handbrakeSideStiffness: 1, coastCap: 0.15, combinedRearPerGrip: 1.0 },
  steering: { maxLockRad: 0.5, refSpeedMps: 6, rateRadPerS: 2 },
  dragCdA: 0.6,
  gearbox: { kind: 'auto', maxForceN: 900, topSpeedMps: 26, idleRpm: 1500, redlineRpm: 8500 },
  fall: { minSpeedKmh: 30, holdS: 0.3 },
  // paramBasis: design. About 0.8 m/s² on 180 kg, fading to 0 at 0.8 m/s (about 3 km/h, a slow
  // duck-walk). Gated on the signed speed, so the push never cuts off below its own cap.
  // Measured on the flat bench from rest: 1.68 m back in 3 s, peak 0.76 m/s. Released, the feet
  // go down: `holdBrake` on both wheels stops it from the cap in 0.18 s and 0.07 m with no
  // skid, where the coast brake alone rolled it on for 7.5 s and about 2.9 m. `holdMaxBackMps`
  // leaves room over the cap for a push that overshoots it.
  pushBack: { forceN: 150, maxSpeedMps: 0.8, engageMaxForwardMps: 0.5, holdBrake: 6, holdMaxBackMps: 1.2 },
};
