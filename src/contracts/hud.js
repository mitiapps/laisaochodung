/**
 * HUD state and the game API the Svelte UI calls. The UI depends on nothing else.
 */

/**
 * @typedef {object} HudState
 * @property {number} speedKmh Ego speed in km/h (magnitude).
 * @property {number | null} speedLimitKmh Limit in force, from `ScoreContext`.
 * @property {import('./telemetry.js').Gear} gear Selected gear.
 * @property {number} rpm Engine speed.
 * @property {import('./telemetry.js').Indicators} indicators Turn signals.
 * @property {import('./telemetry.js').Lights} lights Headlights.
 * @property {boolean} horn Horn sounding.
 * @property {boolean} skid Any wheel skidding.
 * @property {number} score Running score out of 10.
 * @property {number} headingRad Ego heading θ from `frame.ego.heading`; the nav arrow points at
 *   `nav.bearingRad − headingRad`.
 * @property {{distanceM: number, bearingRad: number}} nav Copied from `frame.route`; `bearingRad`
 *   is the world bearing.
 * @property {import('./score.js').Breach[]} toasts Breaches to show, newest last.
 * @property {'ready' | 'running' | 'paused' | 'finished'} runStatus Run status.
 * @property {import('./score.js').ScoreReport} [report] Present once finished.
 */

/**
 * The interface the UI calls; the integration layer in `src/game/` implements it.
 * @typedef {object} GameApi
 * @property {(mapId: string, vehicleId: string) => Promise<void>} start Load and start a run.
 * @property {() => void} pause Pause the run.
 * @property {() => void} resume Resume the run.
 * @property {() => void} restart Restart the same map and vehicle.
 * @property {() => void} quit End the run with `endedBy: 'quit'`.
 * @property {(fn: (state: HudState) => void) => () => void} subscribe Receive HUD states; returns
 *   an unsubscribe function.
 */

/** @type {readonly HudState['runStatus'][]} */
export const RUN_STATUSES = Object.freeze(['ready', 'running', 'paused', 'finished']);
