/**
 * Tuning of `car-sedan`: a 1.3 t compact sedan with a driver, rear-wheel drive.
 * `frictionSlip` 0.38 gives a friction-limited stop from 50 km/h of about 13 m (µ ≈ 0.75);
 * calibrated by `vehicles/vehicles.test.js` and `docs/physics.md`.
 */

/** @type {import('../tuning.js').VehicleTuning} */
export const carSedan = {
  id: 'car-sedan',
  rig: 'four-wheel',
  massKg: 1300,
  chassis: { halfLength: 2.25, halfHeight: 0.35, halfWidth: 0.9, offsetY: 0.1 },
  spawnHeight: 0.6,
  wheels: [
    { x: 1.35, z: -0.78, front: true, driven: false },
    { x: 1.35, z: 0.78, front: true, driven: false },
    { x: -1.35, z: -0.78, front: false, driven: true },
    { x: -1.35, z: 0.78, front: false, driven: true },
  ],
  wheelRadius: 0.31,
  suspension: { restLength: 0.3, maxTravel: 0.2, stiffness: 30, compression: 4, relaxation: 5, maxForce: 100000 },
  frictionSlip: 0.38,
  sideFrictionStiffness: 1,
  // One pedal split 70/30 front/rear: 300 N·s per step in total at full pedal.
  brakes: { frontCap: 105, rearCap: 45, handbrakeCap: 60, handbrakeSideStiffness: 0.3, coastCap: 1 },
  steering: { maxLockRad: 0.6, refSpeedMps: 15, rateRadPerS: 2.5 },
  dragCdA: 0.7,
  gearbox: {
    kind: 'manual',
    ratios: [3.5, 2.1, 1.4, 1.0, 0.8],
    reverseRatio: 3.4,
    finalDrive: 4.1,
    efficiency: 0.9,
    peakTorqueNm: 140,
    idleRpm: 800,
    redlineRpm: 6500,
    maxReverseShiftKmh: 2,
    // Auto-shift assist, paramBasis: design. `upRpm` sits on the scenario driver's manual shift
    // points (about 2,060–2,350 rpm). Measured: 0–60 km/h in 8.9 s (manual schedule 8.4 s), up-shifts
    // at 17.5, 28.8, 42.9 and 60.0 km/h; steady 30 km/h holds 3rd at about 1,450 rpm and
    // 50 km/h holds 4th at about 1,730 rpm, with no shift in 10 s. The lowest rpm right after an
    // up-shift is 2,100 × 2.1 / 3.5 = 1,260, above `downRpm`, so the box cannot hunt.
    autoShift: { upRpm: 2100, downRpm: 1100, minIntervalS: 0.8 },
  },
  fall: null,
};
