/**
 * HUD state and the game API the Svelte UI calls. The UI depends on nothing else.
 */

/**
 * @typedef {object} HudState
 * @property {number} speedKmh Ego speed in km/h (magnitude).
 * @property {number | null} speedLimitKmh Limit in force, from `ScoreContext`.
 * @property {boolean} speedLimitVerified From `ScoreContext`; false when the limit is an unverified
 *   TT 38 default (the roundel then shows "chưa kiểm chứng").
 * @property {import('./telemetry.js').Gear} gear Selected gear.
 * @property {number} rpm Engine speed.
 * @property {import('./telemetry.js').Indicators} indicators Turn signals.
 * @property {import('./telemetry.js').Lights} lights Headlights.
 * @property {boolean} horn Horn sounding.
 * @property {boolean} skid Any wheel skidding.
 * @property {HudControls} controls Pedals, levers and steering applied this step, from
 *   `frame.ego.input`, so the HUD shows every analogue control the player holds.
 * @property {number} score Running score out of 10.
 * @property {number} headingRad Ego heading θ from `frame.ego.heading`; the nav arrow points at
 *   `nav.bearingRad − headingRad`.
 * @property {{distanceM: number, bearingRad: number}} nav Copied from `frame.route`; `bearingRad`
 *   is the world bearing.
 * @property {import('./score.js').Breach[]} toasts Breaches to show, newest last.
 * @property {import('./score.js').Notice[]} notices Contacts the player did not cause, newest last.
 * @property {import('./controls.js').ControlPreset} controlPreset Control preset the session applied.
 * @property {'ready' | 'running' | 'paused' | 'finished'} runStatus Run status.
 * @property {import('./score.js').ScoreReport} [report] Present once finished.
 */

/**
 * The analogue part of `ControlInput` as applied by the sim.
 * @typedef {object} HudControls
 * @property {number} throttle 0..1.
 * @property {number} brakeFront 0..1; the foot brake on a car, the front brake on a motorbike.
 * @property {number} brakeRear 0..1; the rear brake on a motorbike, 0 on a car.
 * @property {number} steer −1..1; −1 is full left, +1 full right.
 * @property {boolean} handbrake Car handbrake; false on a motorbike.
 */

/**
 * @typedef {object} StartOptions
 * @property {import('./controls.js').ControlPreset} [controlPreset] Control preset for the run; it is
 *   fixed until the next start.
 */

/**
 * Input from on-screen controls. It feeds the same held set and press path as the keyboard, so a
 * button and its key give the same `ControlInput`; `src/ui` never imports the input module.
 * @typedef {object} GameControls
 * @property {(action: import('./controls.js').ControlAction, on: boolean) => void} hold Press or
 *   release a `hold` action.
 * @property {(action: import('./controls.js').ControlAction) => void} press Fire a `press` action once.
 * @property {(value: number | null) => void} steer Analogue steering −1..1, or null to hand steering
 *   back to the held keys and buttons.
 */

/**
 * The interface the UI calls; the integration layer in `src/game/` implements it.
 * @typedef {object} GameApi
 * @property {(mapId: string, vehicleId: string, options?: StartOptions) => Promise<void>} start Load
 *   and start a run.
 * @property {GameControls} controls On-screen controls; the only path from UI buttons to the input.
 * @property {() => void} pause Pause the run.
 * @property {() => void} resume Resume the run.
 * @property {() => void} restart Restart the same map and vehicle.
 * @property {() => void} quit End the run with `endedBy: 'quit'`.
 * @property {(fn: (state: HudState) => void) => () => void} subscribe Receive HUD states; returns
 *   an unsubscribe function.
 */

/** @type {readonly HudState['runStatus'][]} */
export const RUN_STATUSES = Object.freeze(['ready', 'running', 'paused', 'finished']);
