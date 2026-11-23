/**
 * Pure pose maths for the renderer. No three.js import, so Node tests run it directly.
 *
 * Three.js conventions used here: a model whose front is +X turns to heading θ with
 * `rotation.y = θ`, because rotating +X by θ about +Y gives (cos θ, 0, −sin θ), the forward vector
 * of `src/contracts/units.js`. In the vehicle's local frame +Z is its right-hand side.
 */

import { angleDiff, headingVector, leftVector } from '../geometry/index.js';

/** Standard gravity in m/s², for the motorbike lean. */
export const GRAVITY_MPS2 = 9.81;

/** Largest lean drawn for a motorbike, in radians (40°). */
export const MAX_LEAN_RAD = (40 * Math.PI) / 180;

/**
 * Yaw (`rotation.y`) of an object whose front is local +X so that it faces heading θ.
 * @param {number} heading Heading θ.
 * @returns {number} Yaw in radians.
 */
export function headingToYaw(heading) {
  return heading;
}

/**
 * Yaw of a flat face (sign or signal head, front normal local +Z) that faces the traffic travelling
 * at `heading`: the face normal points against that travel, towards approaching drivers.
 * @param {number} heading Travel heading of the traffic the face is meant for.
 * @returns {number} Yaw in radians.
 */
export function facingYaw(heading) {
  return heading - Math.PI / 2;
}

/**
 * Motorbike lean angle `atan(v·ω/g)`, clamped to ±40°. Positive leans to the left, which is the
 * lean of a left turn (`yawRate > 0`) at forward speed.
 * @param {number} speed Signed forward speed in m/s.
 * @param {number} yawRate dθ/dt in rad/s, + turning left.
 * @returns {number} Lean in radians, + to the left.
 */
export function leanAngle(speed, yawRate) {
  const lean = Math.atan((speed * yawRate) / GRAVITY_MPS2);
  return Math.max(-MAX_LEAN_RAD, Math.min(MAX_LEAN_RAD, lean));
}

/**
 * Body roll (`rotation.x` of a +X-forward group) that draws a lean. Rolling about +X by a
 * negative angle moves the top towards local −Z, the left side.
 * @param {number} lean Lean in radians, + to the left.
 * @returns {number} Roll in radians.
 */
export function leanToRoll(lean) {
  return -lean;
}

/**
 * Linear interpolation.
 * @param {number} a From.
 * @param {number} b To.
 * @param {number} t Fraction 0..1.
 * @returns {number} Value.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Shortest-arc angle interpolation (the 2D slerp of a heading).
 * @param {number} a From angle.
 * @param {number} b To angle.
 * @param {number} t Fraction 0..1.
 * @returns {number} Angle, not wrapped.
 */
export function lerpAngle(a, b, t) {
  return a + angleDiff(a, b) * t;
}

/**
 * Wheel ground contact points relative to the body centre, as `[along, left]` metres, in the
 * frame order of `WheelState`: car FL, FR, RL, RR; motorbike front, rear.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class.
 * @param {number} lengthM Body length.
 * @param {number} widthM Body width.
 * @returns {[number, number][]} Offsets.
 */
export function wheelOffsets(legalClass, lengthM, widthM) {
  if (legalClass === 'car') {
    // Overhang and track inset are drawing values, not physics.
    const a = lengthM / 2 - Math.min(0.9, lengthM * 0.2);
    const b = widthM / 2 - Math.min(0.25, widthM * 0.14);
    return [
      [a, b],
      [a, -b],
      [-a, b],
      [-a, -b],
    ];
  }
  const a = lengthM / 2 - Math.min(0.3, lengthM * 0.16);
  return [
    [a, 0],
    [-a, 0],
  ];
}

/**
 * World ground point of a body-relative offset.
 * @param {{x: number, z: number}} pos Body centre.
 * @param {number} heading Heading θ.
 * @param {[number, number]} offset `[along, left]` in metres.
 * @returns {[number, number]} `[x, z]`.
 */
export function bodyToWorld(pos, heading, offset) {
  const [fx, fz] = headingVector(heading);
  const [lx, lz] = leftVector(heading);
  return [pos.x + fx * offset[0] + lx * offset[1], pos.z + fz * offset[0] + lz * offset[1]];
}

/**
 * Whether an indicator lamp is lit at run time `t`: 1.5 Hz, lit for the first half of each period.
 * Driven by frame time, so the blink is the same however often the frame is drawn.
 * @param {number} t Run time in seconds.
 * @returns {boolean} Lit.
 */
export function blinkOn(t) {
  const phase = (t * 1.5) % 1;
  return phase < 0.5;
}

/**
 * Daylight factor 1 by day, 0 by night, with one-hour linear twilights centred on 06:00 and 18:00
 * (a fixed drawing choice for southern Vietnam, not an astronomical model).
 * @param {number} clockMin Minute of day.
 * @returns {number} Factor 0..1.
 */
export function daylight(clockMin) {
  const m = ((clockMin % 1440) + 1440) % 1440;
  const ramp = (/** @type {number} */ centre, /** @type {number} */ x) =>
    Math.max(0, Math.min(1, (x - (centre - 30)) / 60));
  if (m < 12 * 60) return ramp(6 * 60, m);
  return 1 - ramp(18 * 60, m);
}

/**
 * Sun elevation for drawing, in radians: 0 at 06:00 and 18:00, highest (75°) at noon, below the
 * horizon at night.
 * @param {number} clockMin Minute of day.
 * @returns {number} Elevation in radians.
 */
export function sunElevation(clockMin) {
  const m = ((clockMin % 1440) + 1440) % 1440;
  return Math.sin(((m - 360) / 720) * Math.PI) * ((75 * Math.PI) / 180);
}
