/**
 * Factory signatures of the main modules. Implementations live in their owning directories;
 * this file only fixes the shapes they agree on.
 */

/** @typedef {import('./rule.js').RulesBundle} RulesBundle */
/** @typedef {import('./map.js').GameMap} GameMap */
/** @typedef {import('./vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('./telemetry.js').Frame} Frame */
/** @typedef {import('./score.js').Breach} Breach */
/** @typedef {import('./score.js').ScoreContext} ScoreContext */
/** @typedef {import('./score.js').ScoreReport} ScoreReport */

/**
 * Result of one scorer step.
 * @typedef {object} ScorerStep
 * @property {unknown} state Next scorer state (opaque, plain JSON).
 * @property {Breach[]} breaches Breaches opened or escalated this step.
 * @property {ScoreContext} context Context for the HUD.
 * @property {null | 'crash'} runEnded `crash` after a pedestrian hit at or above the contact speed.
 */

/**
 * Pure scorer folded per step by the game and over recorded frames by tests.
 * @typedef {object} Scorer
 * @property {unknown} initial Initial state.
 * @property {(state: unknown, frame: Frame) => ScorerStep} step Pure reducer.
 * @property {(state: unknown, options: {quit: boolean}) => ScoreReport} report Final report.
 */

/**
 * @callback CreateScorer
 * @param {RulesBundle} bundle Rules bundle.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @returns {Scorer} Scorer.
 */

/**
 * Folds `createScorer` over frames; must equal the live fold.
 * @callback ScoreRun
 * @param {RulesBundle} bundle Rules bundle.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {Frame[]} frames Frames in tick order.
 * @param {{quit: boolean}} options Whether the player quit after the last frame.
 * @returns {ScoreReport} Report.
 */

/**
 * Headless simulation: physics plus `src/world`, one `Frame` per fixed step.
 * @typedef {object} Sim
 * @property {(input: import('./controls.js').ControlInput) => Frame} step Advance one DT.
 * @property {() => void} reset Place the ego back at the last passed checkpoint, or the start, on
 *   the next step, which emits `reset`; run time and route progress are kept. A full restart of the
 *   run creates a new sim.
 * @property {() => void} dispose Free physics resources.
 */

/**
 * @callback CreateSim
 * @param {unknown} rapier Initialised `@dimforge/rapier3d-compat` module.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @returns {Sim} Simulation.
 */

/**
 * @typedef {object} Renderer
 * @property {(prev: Frame | null, frame: Frame, alpha: number) => void} render Draw, interpolating
 *   from `prev` to `frame` by `alpha` in 0..1.
 * @property {(width: number, height: number) => void} resize Resize the drawing buffer.
 * @property {() => void} dispose Free GPU resources.
 */

/**
 * @callback CreateRenderer
 * @param {HTMLCanvasElement} canvas Canvas.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @returns {Renderer} Renderer.
 */

export {};
