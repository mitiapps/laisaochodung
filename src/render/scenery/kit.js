/**
 * The models the game passes to `buildScenery`, per prop kind. Kinds left out keep their
 * primitive shape on purpose, because the shipped model would misplace or mis-size them:
 *
 * - `lamp`: Kenney's light poles fitted to the 9 m lamp height come out 0.8 m thick;
 * - `power-pole`: Kenney's electricity pole is a two-post frame, 9.5 m wide at 8.5 m high, and the
 *   cables attach to the primitive's single-pole crossarm;
 * - `bin`: the dumpster fits the 1 m bin height at 1.4 × 1.8 m, far beyond the 0.6 m collider;
 * - `stall`: the parasol alone drops the cart that the collider covers;
 * - `awning`: the model stands on its attach line, while the awning has to hang from it.
 */

/** @type {import('./index.js').SceneryKit} */
export const SCENERY_KIT = Object.freeze({
  propModels: Object.freeze({
    tree: Object.freeze({ path: 'models/city-kit/suburban/tree-large.glb', yawOffset: 0 }),
  }),
});
