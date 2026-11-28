/**
 * Procedural motorbikes: a scooter (xe tay ga) and an underbone (xe số), the two shapes that make
 * up most of the traffic in Ho Chi Minh City. No CC0 motor scooter exists, so both are our own
 * meshes, built from extruded side-profile outlines (body, seat, leg shield, mudguards) plus a
 * few rods (fork, handlebar, exhaust). Wheels are separate (`unitWheel`) so they can spin. The
 * third type, a sport bike, has a Tripo body only; the underbone mesh is its procedural stand-in.
 *
 * Kenney frame: front +Z, left +X, up +Y, ground at y = 0, centred between the axles. Sizes are
 * real metres for a 1.9 m bike (Honda Vision and Wave class); instances scale them uniformly to
 * the pose length.
 */

import { boxPart, CELL, FIXED, merge, PAINT_BODY, profilePart, rodPart } from './procedural.js';

/** @typedef {'scooter' | 'underbone' | 'sportbike'} MotorbikeType */

/**
 * @typedef {object} WheelSpec
 * @property {number} z Axle position along the bike.
 * @property {number} radius Tyre radius.
 * @property {number} width Tyre width.
 */

/**
 * @typedef {object} MotorbikeModel
 * @property {MotorbikeType} type Type.
 * @property {import('three').BufferGeometry} body Body without wheels or rider.
 * @property {WheelSpec[]} wheels Front, rear.
 * @property {[number, number]} seat Rider hip point `[z, y]`.
 * @property {[number, number]} pillion Passenger hip point `[z, y]`.
 * @property {number} legPitch Rider leg angle from straight down (radians, forward), so the feet
 *   reach the floorboard or the footpegs.
 * @property {number} lengthM Nominal length.
 * @property {number} widthM Nominal width (handlebar span).
 * @property {number} heightM Nominal height without rider.
 * @property {{brake: [number, number, number][], left: [number, number, number][], right: [number, number, number][]}} lamps
 *   Lamp centres in the Kenney frame.
 */

/** Motorbike types in variant order (`TrafficParams.models.motorbike.variants` picks one each). */
export const MOTORBIKE_TYPES = Object.freeze(/** @type {MotorbikeType[]} */ (['scooter', 'underbone', 'sportbike']));

/** Nominal length of both procedural bikes, metres. */
export const MOTORBIKE_LENGTH_M = 1.9;

/**
 * Parts shared by both types: fork, handlebar with grips, mirrors and the tail lamp.
 * @param {number} frontZ Front axle.
 * @param {number} headZ Steering head position along the bike.
 * @param {number} barY Handlebar height.
 * @param {number} tailZ Tail lamp position.
 * @param {number} tailY Tail lamp height.
 * @param {number} wheelR Front wheel radius.
 * @returns {import('three').BufferGeometry[]} Parts.
 */
function commonParts(frontZ, headZ, barY, tailZ, tailY, wheelR) {
  return [
    rodPart([0.07, wheelR, frontZ], [0.06, barY - 0.12, headZ], 0.025, 6, CELL.grey, FIXED),
    rodPart([-0.07, wheelR, frontZ], [-0.06, barY - 0.12, headZ], 0.025, 6, CELL.grey, FIXED),
    rodPart([0.36, barY, headZ - 0.04], [-0.36, barY, headZ - 0.04], 0.018, 6, CELL.grey, FIXED),
    rodPart([0.37, barY, headZ - 0.04], [0.27, barY, headZ - 0.04], 0.03, 6, CELL.nearBlack, FIXED),
    rodPart([-0.37, barY, headZ - 0.04], [-0.27, barY, headZ - 0.04], 0.03, 6, CELL.nearBlack, FIXED),
    rodPart([0.22, barY, headZ - 0.04], [0.27, barY + 0.24, headZ - 0.08], 0.008, 4, CELL.grey, FIXED),
    rodPart([-0.22, barY, headZ - 0.04], [-0.27, barY + 0.24, headZ - 0.08], 0.008, 4, CELL.grey, FIXED),
    boxPart([0.08, 0.05, 0.02], [0.27, barY + 0.26, headZ - 0.08], CELL.nearBlack, FIXED),
    boxPart([0.08, 0.05, 0.02], [-0.27, barY + 0.26, headZ - 0.08], CELL.nearBlack, FIXED),
    boxPart([0.16, 0.06, 0.04], [0, tailY, tailZ], CELL.red, FIXED),
  ];
}

/**
 * Scooter: step-through floor, tall leg shield with the headlamp, large rear body over the
 * engine, small wheels.
 * @returns {MotorbikeModel} Model.
 */
function scooter() {
  const r = 0.27;
  const front = 0.64;
  const rear = -0.62;
  const parts = [
    // Rear body over the engine and rear wheel.
    profilePart(
      [
        [-0.18, 0.3],
        [-0.04, 0.66],
        [-0.42, 0.72],
        [-0.86, 0.76],
        [-0.95, 0.68],
        [-0.9, 0.6],
        [-0.62, 0.58],
        [-0.36, 0.5],
        [-0.3, 0.3],
      ],
      0.32,
      { cell: CELL.white, paint: PAINT_BODY, bevel: 0.04 },
    ),
    // Floorboard.
    profilePart(
      [
        [-0.3, 0.24],
        [0.36, 0.24],
        [0.36, 0.31],
        [-0.3, 0.31],
      ],
      0.34,
      { cell: CELL.nearBlack, paint: FIXED },
    ),
    // Engine and swingarm unit, left side.
    profilePart(
      [
        [-0.72, 0.18],
        [-0.3, 0.16],
        [-0.22, 0.3],
        [-0.38, 0.46],
        [-0.66, 0.4],
      ],
      0.16,
      { cell: CELL.darkSlate, paint: FIXED, x: 0.08 },
    ),
    // Leg shield and front apron with the headlamp.
    profilePart(
      [
        [0.3, 0.26],
        [0.48, 0.26],
        [0.6, 0.4],
        [0.66, 0.66],
        [0.6, 0.98],
        [0.48, 1.04],
        [0.38, 0.98],
        [0.34, 0.6],
      ],
      0.44,
      { cell: CELL.white, paint: PAINT_BODY, bevel: 0.05 },
    ),
    // Seat.
    profilePart(
      [
        [-0.06, 0.66],
        [-0.04, 0.74],
        [-0.3, 0.79],
        [-0.62, 0.82],
        [-0.84, 0.82],
        [-0.86, 0.75],
      ],
      0.3,
      { cell: CELL.nearBlack, paint: FIXED, bevel: 0.03 },
    ),
    // Front mudguard.
    profilePart(
      [
        [front - 0.24, 0.42],
        [front - 0.12, 0.53],
        [front + 0.1, 0.54],
        [front + 0.26, 0.42],
        [front + 0.22, 0.4],
        [front + 0.08, 0.49],
        [front - 0.1, 0.48],
        [front - 0.2, 0.39],
      ],
      0.14,
      { cell: CELL.white, paint: PAINT_BODY },
    ),
    // Handlebar cover.
    profilePart(
      [
        [0.36, 0.98],
        [0.42, 1.08],
        [0.62, 1.06],
        [0.66, 0.98],
        [0.56, 0.95],
      ],
      0.26,
      { cell: CELL.white, paint: PAINT_BODY, bevel: 0.02 },
    ),
    boxPart([0.2, 0.08, 0.04], [0, 0.9, 0.64], CELL.white, FIXED, -0.3),
    // Exhaust, right side.
    rodPart([-0.15, 0.22, -0.3], [-0.15, 0.36, -0.88], 0.045, 6, CELL.grey, FIXED),
    // Grab rail.
    rodPart([0.14, 0.82, -0.7], [-0.14, 0.82, -0.7], 0.015, 4, CELL.grey, FIXED),
    ...commonParts(front, 0.5, 1.03, -0.94, 0.68, r),
  ];
  return {
    type: 'scooter',
    body: merge(parts),
    wheels: [
      { z: front, radius: r, width: 0.11 },
      { z: rear, radius: r, width: 0.12 },
    ],
    seat: [-0.3, 0.8],
    pillion: [-0.66, 0.83],
    legPitch: 1.2,
    lengthM: MOTORBIKE_LENGTH_M,
    widthM: 0.74,
    heightM: 1.3,
    lamps: {
      brake: [[0, 0.68, -0.97]],
      left: [
        [0.2, 0.92, 0.6],
        [0.12, 0.66, -0.92],
      ],
      right: [
        [-0.2, 0.92, 0.6],
        [-0.12, 0.66, -0.92],
      ],
    },
  };
}

/**
 * Underbone: exposed backbone and engine below a long flat seat, small leg shield, larger
 * wheels, chain guard and exhaust on the right.
 * @returns {MotorbikeModel} Model.
 */
function underbone() {
  const r = 0.3;
  const front = 0.63;
  const rear = -0.6;
  const parts = [
    // Front cover over the backbone, with the leg shield.
    profilePart(
      [
        [0.06, 0.42],
        [0.3, 0.46],
        [0.5, 0.7],
        [0.54, 0.92],
        [0.42, 0.96],
        [0.3, 0.78],
        [0.12, 0.56],
      ],
      0.3,
      { cell: CELL.white, paint: PAINT_BODY, bevel: 0.04 },
    ),
    // Engine block.
    profilePart(
      [
        [-0.26, 0.2],
        [0.14, 0.18],
        [0.24, 0.32],
        [0.08, 0.46],
        [-0.22, 0.44],
      ],
      0.26,
      { cell: CELL.grey, paint: FIXED, bevel: 0.02 },
    ),
    // Side covers and tail under the seat.
    profilePart(
      [
        [-0.16, 0.48],
        [-0.08, 0.72],
        [-0.84, 0.8],
        [-0.96, 0.72],
        [-0.72, 0.62],
        [-0.36, 0.56],
      ],
      0.26,
      { cell: CELL.white, paint: PAINT_BODY, bevel: 0.03 },
    ),
    // Seat.
    profilePart(
      [
        [-0.06, 0.72],
        [-0.04, 0.8],
        [-0.5, 0.85],
        [-0.86, 0.84],
        [-0.88, 0.78],
        [-0.1, 0.7],
      ],
      0.26,
      { cell: CELL.nearBlack, paint: FIXED, bevel: 0.03 },
    ),
    // Front mudguard.
    profilePart(
      [
        [front - 0.26, 0.46],
        [front - 0.12, 0.58],
        [front + 0.1, 0.6],
        [front + 0.28, 0.46],
        [front + 0.24, 0.44],
        [front + 0.08, 0.55],
        [front - 0.1, 0.53],
        [front - 0.22, 0.43],
      ],
      0.12,
      { cell: CELL.white, paint: PAINT_BODY },
    ),
    // Rear fender under the tail.
    profilePart(
      [
        [rear - 0.36, 0.6],
        [rear + 0.1, 0.62],
        [rear + 0.1, 0.58],
        [rear - 0.3, 0.55],
      ],
      0.14,
      { cell: CELL.nearBlack, paint: FIXED },
    ),
    // Headlamp cowl.
    profilePart(
      [
        [0.4, 0.98],
        [0.46, 1.06],
        [0.62, 1.04],
        [0.66, 0.96],
        [0.54, 0.92],
      ],
      0.24,
      { cell: CELL.white, paint: PAINT_BODY, bevel: 0.02 },
    ),
    boxPart([0.16, 0.08, 0.04], [0, 1.0, 0.66], CELL.white, FIXED, -0.2),
    // Backbone tube and swingarm.
    rodPart([0, 0.92, 0.46], [0, 0.46, 0.1], 0.035, 6, CELL.darkSlate, FIXED),
    rodPart([0.07, 0.3, 0], [0.07, r, rear], 0.025, 6, CELL.darkSlate, FIXED),
    // Chain guard and exhaust, right side.
    boxPart([0.03, 0.08, 0.62], [-0.1, 0.32, -0.3], CELL.nearBlack, FIXED),
    rodPart([-0.15, 0.22, 0.12], [-0.17, 0.38, -0.86], 0.04, 6, CELL.grey, FIXED),
    ...commonParts(front, 0.52, 1.06, -0.98, 0.72, r),
  ];
  return {
    type: 'underbone',
    body: merge(parts),
    wheels: [
      { z: front, radius: r, width: 0.08 },
      { z: rear, radius: r, width: 0.09 },
    ],
    seat: [-0.28, 0.83],
    pillion: [-0.66, 0.85],
    legPitch: 0.85,
    lengthM: MOTORBIKE_LENGTH_M,
    widthM: 0.74,
    heightM: 1.32,
    lamps: {
      brake: [[0, 0.72, -1.0]],
      left: [
        [0.18, 0.98, 0.6],
        [0.12, 0.72, -0.96],
      ],
      right: [
        [-0.18, 0.98, 0.6],
        [-0.12, 0.72, -0.96],
      ],
    },
  };
}

/**
 * Builds a motorbike model. Each call returns fresh geometry owned by the caller.
 * @param {MotorbikeType} type Type.
 * @returns {MotorbikeModel} Model.
 */
export function buildMotorbike(type) {
  if (type === 'scooter') return scooter();
  if (type === 'underbone') return underbone();
  // No procedural sport bike: the underbone stands in until (or instead of) its Tripo body.
  if (type === 'sportbike') return { ...underbone(), type: 'sportbike' };
  throw new Error(`Unknown motorbike type ${String(type)}`);
}
