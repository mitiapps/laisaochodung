/**
 * Navigation arrow geometry.
 */

/**
 * Clockwise CSS rotation of an arrow that points straight ahead at 0°. Bearings follow the heading
 * convention (counter-clockwise, 0 east, π/2 north), so turning left is a positive angle and a
 * negative CSS rotation.
 * @param {number} bearingRad Bearing to the target. World bearing when `headingRad` is given,
 *   otherwise already relative to the ego heading.
 * @param {number | null} [headingRad] Ego heading, or null when the bearing is relative.
 * @returns {number} Rotation in degrees, in (−180, 180].
 */
export function arrowRotationDeg(bearingRad, headingRad = null) {
  const relative = bearingRad - (typeof headingRad === 'number' ? headingRad : 0);
  let deg = (-relative * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  if (deg > 180) deg -= 360;
  return Object.is(deg, -0) ? 0 : deg;
}
