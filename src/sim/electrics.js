/**
 * Indicator, headlight and horn state machines. Commands are edges (one step), except `flash`,
 * which the input repeats every step it is held. Indicators cancel only through the auto-cancel
 * assist (`signal-cancel.js`), which the sim applies with `cancelIndicators` before a step.
 *
 * - `left` / `right`: toggles that side on, or off when it is already on; switches sides directly.
 * - `hazard`: toggles the hazard lights; turning them off restores `off`.
 * - `cycle`: off → low → high → off.
 * - `flash`: high beam this step, the selected state afterwards.
 */

/** @typedef {import('../contracts/telemetry.js').Indicators} Indicators */
/** @typedef {import('../contracts/telemetry.js').Lights} Lights */
/** @typedef {import('../contracts/controls.js').ControlInput} ControlInput */

/**
 * @typedef {object} ElectricsState
 * @property {Indicators} indicators Turn-signal state.
 * @property {Lights} selected Headlight switch position (without flashing).
 */

/** @type {readonly Lights[]} */
const LIGHT_CYCLE = Object.freeze(['off', 'low', 'high']);

/**
 * Initial state: everything off.
 * @returns {ElectricsState} State.
 */
export function createElectrics() {
  return { indicators: 'off', selected: 'off' };
}

/**
 * Applies one step of input.
 * @param {ElectricsState} state Current state.
 * @param {ControlInput} input Sanitised input.
 * @returns {{state: ElectricsState, indicators: Indicators, lights: Lights, horn: boolean}} Next
 *   state and the outputs of this step.
 */
export function stepElectrics(state, input) {
  let { indicators, selected } = state;
  const cmd = input.signalCmd;
  if (cmd !== null) indicators = indicators === cmd ? 'off' : cmd;
  if (input.lightsCmd === 'cycle') {
    selected = LIGHT_CYCLE[(LIGHT_CYCLE.indexOf(selected) + 1) % LIGHT_CYCLE.length];
  }
  const lights = input.lightsCmd === 'flash' ? 'high' : selected;
  return { state: { indicators, selected }, indicators, lights, horn: input.horn };
}

/**
 * Switches the indicator off, as the auto-cancel assist does; the headlights are kept.
 * @param {ElectricsState} state Current state.
 * @returns {ElectricsState} State with `indicators: 'off'`.
 */
export function cancelIndicators(state) {
  return { ...state, indicators: 'off' };
}
