/**
 * Heading and footprint helpers. Heading θ: forward = (cos θ, −sin θ) in (x, z); left of θ is
 * (−sin θ, −cos θ). Points are `[x, z]` tuples.
 */

/** @typedef {[number, number]} Vec2 */

const TWO_PI = Math.PI * 2;

/**
 * Wraps an angle to (−π, π].
 * @param {number} a Angle in radians.
 * @returns {number} Wrapped angle.
 */
export function normalizeAngle(a) {
  let r = a % TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  else if (r > Math.PI) r -= TWO_PI;
  return r;
}

/**
 * Signed smallest difference `b − a`, in (−π, π]; positive means `b` is to the left of `a`.
 * @param {number} a From angle.
 * @param {number} b To angle.
 * @returns {number} Difference.
 */
export function angleDiff(a, b) {
  return normalizeAngle(b - a);
}

/**
 * Unit forward vector of a heading.
 * @param {number} heading Heading θ.
 * @returns {Vec2} `[cos θ, −sin θ]`.
 */
export function headingVector(heading) {
  return [Math.cos(heading), -Math.sin(heading)];
}

/**
 * Unit left vector of a heading.
 * @param {number} heading Heading θ.
 * @returns {Vec2} `[−sin θ, −cos θ]`.
 */
export function leftVector(heading) {
  return [-Math.sin(heading), -Math.cos(heading)];
}

/**
 * Heading of a direction vector.
 * @param {number} dx X component.
 * @param {number} dz Z component.
 * @returns {number} Heading θ in (−π, π].
 */
export function headingOf(dx, dz) {
  // `0 - dz` avoids −0, for which atan2 would return −π instead of π.
  return Math.atan2(0 - dz, dx);
}

/**
 * Body rectangle of a pose, corners in the order front-left, front-right, rear-right, rear-left.
 * @param {{x: number, z: number}} pos Centre.
 * @param {number} heading Heading θ.
 * @param {number} length Length along the heading.
 * @param {number} width Width across the heading.
 * @returns {[Vec2, Vec2, Vec2, Vec2]} Corners.
 */
export function footprint(pos, heading, length, width) {
  const [fx, fz] = headingVector(heading);
  const [lx, lz] = leftVector(heading);
  const hl = length / 2;
  const hw = width / 2;
  /**
   * @param {number} along Distance forward.
   * @param {number} left Distance left.
   * @returns {Vec2} Corner.
   */
  const corner = (along, left) => [pos.x + fx * along + lx * left, pos.z + fz * along + lz * left];
  return [corner(hl, hw), corner(hl, -hw), corner(-hl, -hw), corner(-hl, hw)];
}

/**
 * Euclidean distance between two points.
 * @param {Vec2} a Point.
 * @param {Vec2} b Point.
 * @returns {number} Distance.
 */
export function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
