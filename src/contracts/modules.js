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
 * @property {import('./score.js').Notice[]} notices Notices raised this step; the state keeps every
 *   notice of the run so far, so a fold from a saved state still reports them.
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
 * @param {ScoreRunOptions} options Quit flag and an optional start state.
 * @returns {ScoreReport} Report.
 */

/**
 * @typedef {object} ScoreRunOptions
 * @property {boolean} quit The player quit after the last frame.
 * @property {unknown} [initialState] Scorer state to fold from instead of `scorer.initial`: the
 *   state saved at a checkpoint, so a windowed replay folds only the frames after it.
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
 * @typedef {object} SimOptions
 * @property {'map' | 'off'} [traffic] `map` runs the map's traffic block, `off` (the default) runs
 *   scripted actors only, exactly as a map without traffic.
 * @property {number} [runSeed] 32-bit unsigned run seed for the traffic.
 * @property {import('./traffic.js').TrafficParams} [params] Compiled traffic parameters; needed
 *   when `traffic` is `map`.
 * @property {import('./controls.js').ControlAssists} [assists] Driving assists; default all off.
 */

/**
 * @callback CreateSim
 * @param {unknown} rapier Initialised `@dimforge/rapier3d-compat` module.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {SimOptions} [options] Traffic and assist options.
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
