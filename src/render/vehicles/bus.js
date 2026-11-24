/**
 * Procedural 10.5 m city bus in the green and white livery of Ho Chi Minh City's buses (a design
 * choice, not a fleet's exact livery): green lower body with wheel arches, dark window band with
 * green pillars, white roof band, roof air-conditioning unit, two doors on the right side.
 * The Car Kit has no bus and no CC0 bus matches its style.
 *
 * Kenney frame (front +Z, left +X, up +Y), real metres, ground at y = 0. Colours come from the
 * shared palette (`procedural.js`); the bus takes no variant paint.
 */

import { boxPart, CELL, FIXED, merge, profilePart } from './procedural.js';

/** Nominal size of the procedural bus, metres. */
export const BUS_SIZE = Object.freeze({ lengthM: 10.5, widthM: 2.5, heightM: 3.3 });

/**
 * @typedef {object} BusModel
 * @property {import('three').BufferGeometry} body Body without wheels.
 * @property {import('./motorbike.js').WheelSpec[]} wheels Front then rear axle; each is drawn on
 *   both sides.
 * @property {{brake: [number, number, number][], left: [number, number, number][], right: [number, number, number][]}} lamps
 *   Lamp centres.
 */

/**
 * Builds the bus. Each call returns fresh geometry owned by the caller.
 * @returns {BusModel} Bus.
 */
export function buildBus() {
  const half = BUS_SIZE.lengthM / 2;
  const w = BUS_SIZE.widthM;
  const front = 3.6;
  const rear = -2.4;
  const arch = 0.65;
  /** @type {import('three').BufferGeometry[]} */
  const parts = [
    profilePart(
      [
        [-half, 0.35],
        [rear - arch, 0.35],
        [rear - arch, 1.08],
        [rear + arch, 1.08],
        [rear + arch, 0.35],
        [front - arch, 0.35],
        [front - arch, 1.08],
        [front + arch, 1.08],
        [front + arch, 0.35],
        [half, 0.35],
        [half, 1.25],
        [-half, 1.25],
      ],
      w,
      { cell: CELL.green, paint: FIXED, bevel: 0.05 },
    ),
    boxPart([w - 0.06, 1.1, BUS_SIZE.lengthM - 0.2], [0, 1.8, 0], CELL.nearBlack, FIXED),
    profilePart(
      [
        [-half, 2.35],
        [half, 2.35],
        [half - 0.05, 3.0],
        [-half + 0.05, 3.0],
      ],
      w,
      { cell: CELL.white, paint: FIXED, bevel: 0.08 },
    ),
    boxPart([1.6, 0.22, 3.2], [0, 3.18, -1.0], CELL.paleGrey, FIXED),
    // Windscreen, destination sign, bumpers, lamps.
    boxPart([w - 0.2, 1.25, 0.06], [0, 1.8, half + 0.01], CELL.darkSlate, FIXED),
    boxPart([1.6, 0.26, 0.06], [0, 2.68, half + 0.03], CELL.black, FIXED),
    boxPart([1.2, 0.18, 0.04], [0, 2.68, half + 0.06], CELL.orange, FIXED),
    boxPart([w, 0.28, 0.14], [0, 0.48, half + 0.03], CELL.darkSlate, FIXED),
    boxPart([w, 0.28, 0.14], [0, 0.48, -half - 0.03], CELL.darkSlate, FIXED),
    boxPart([w - 0.4, 0.9, 0.06], [0, 1.85, -half - 0.01], CELL.darkSlate, FIXED),
    boxPart([0.3, 0.14, 0.04], [0.9, 0.78, half + 0.02], CELL.white, FIXED),
    boxPart([0.3, 0.14, 0.04], [-0.9, 0.78, half + 0.02], CELL.white, FIXED),
    boxPart([0.22, 0.3, 0.04], [1.0, 0.95, -half - 0.02], CELL.red, FIXED),
    boxPart([0.22, 0.3, 0.04], [-1.0, 0.95, -half - 0.02], CELL.red, FIXED),
    // Doors on the right (kerb) side.
    boxPart([0.04, 2.1, 1.1], [-w / 2 - 0.01, 1.42, half - 1.3], CELL.darkSlate, FIXED),
    boxPart([0.04, 2.1, 1.1], [-w / 2 - 0.01, 1.42, -0.6], CELL.darkSlate, FIXED),
  ];
  // Window pillars.
  for (let z = -half + 1.2; z < half - 1.0; z += 1.45) parts.push(boxPart([w + 0.01, 1.1, 0.14], [0, 1.8, z], CELL.green, FIXED));
  return {
    body: merge(parts),
    wheels: [
      { z: front, radius: 0.5, width: 0.3 },
      { z: rear, radius: 0.5, width: 0.42 },
    ],
    lamps: {
      brake: [
        [1.0, 1.25, -half - 0.04],
        [-1.0, 1.25, -half - 0.04],
      ],
      left: [
        [1.12, 0.78, half + 0.04],
        [1.0, 1.55, -half - 0.04],
      ],
      right: [
        [-1.12, 0.78, half + 0.04],
        [-1.0, 1.55, -half - 0.04],
      ],
    },
  };
}
