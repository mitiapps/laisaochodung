/**
 * Per-model drawing config. Models are authored the Kenney way: front towards local +Z, left
 * towards local +X, wheels as separate nodes. The view turns that frame to +X forward, so every
 * model (GLB, box or procedural) shares one wheel and lamp code path.
 */

/**
 * @typedef {object} ModelConfig
 * @property {string} id Config id: a vehicle id or an actor `model` key.
 * @property {'car' | 'motorbike' | 'pedestrian'} kind What to draw when no GLB is ready.
 * @property {string | null} glb GLB path relative to `public/`, or null for primitives only.
 * @property {string[]} wheelNodes GLB wheel node names in `WheelState` order (car FL, FR, RL, RR;
 *   motorbike front, rear); missing nodes get generated wheels.
 * @property {number} wheelRadiusM Wheel radius of the generated wheels and of NPC wheel spin.
 * @property {number} heightM Body height of the box fallback.
 * @property {number} color Body colour of the box or primitive fallback, and the paint of a
 *   procedural model.
 * @property {import('./motorbike.js').MotorbikeType} [procedural] Draw this procedural motorbike
 *   (with a rider) instead of a GLB or the primitive scooter.
 * @property {string} [tripo] `TRIPO_MODELS` key of a textured car body (wheels baked in) drawn in
 *   place of `glb`; `glb` stays the fallback when it fails to load.
 */

/** Kenney Car Kit wheel node names in car `WheelState` order. */
export const KENNEY_WHEELS = Object.freeze([
  'wheel-front-left',
  'wheel-front-right',
  'wheel-back-left',
  'wheel-back-right',
]);

/**
 * A Kenney Car Kit body (CC0). `paint` lists the cells of the kit's colour map (8 columns × 4
 * rows, as `[column, row]` from the top left) that hold the body paint; they were measured as the
 * largest saturated cell of each body mesh. Only those texels take a variant colour.
 * @typedef {object} KenneyBody
 * @property {string} glb GLB path relative to `public/`.
 * @property {readonly (readonly number[])[]} paint Paint cells.
 */

export {};
