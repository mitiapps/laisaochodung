/**
 * Indicator auto-cancel, a driving assist: switches the indicator off after a completed, signalled
 * junction turn, the way a self-cancelling stalk does. It never performs a scored duty, so it is
 * built to never cause a `turn-signal` breach:
 *
 * - It reads the junction under the ego with `locate`, the same call and arguments as the scorer,
 *   on the pre-step pose (the pose of the last frame), before the electrics run. The scorer judges
 *   the indicator on the first frame whose centre is outside the junction, so the earliest cancel
 *   comes after that frame.
 * - The pass arms only on junction entry with `left` or `right` on, so a lane change never cancels.
 *   `hazard`, `off` or a side change at any point ends the pass.
 * - The heading turned from entry to exit must be at least `turnMinDeg` toward the indicator side;
 *   a U-turn to the left counts for `left`. The turn is summed step by step, so a U-turn keeps its
 *   side instead of wrapping at 180°.
 * - The ego centre must stay outside every junction for `SIGNAL_CANCEL_DELAY_S`.
 * - Hold-off: if another junction lies ahead within `clearM` at that moment, the pass ends and the
 *   indicator stays on, since the next junction may need it from `signalFromM` before its entry.
 */

import { distanceToPolygon, junctionsNear, locate } from '../map-query/index.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Indicators} Indicators */

/** Time (s) the ego centre stays outside every junction before the cancel; paramBasis: design. */
export const SIGNAL_CANCEL_DELAY_S = 0.5;

/** Step (m) of the central difference that tells whether a junction's nearest point lies ahead. */
const AHEAD_PROBE_M = 0.05;

/**
 * Tracker state. `idle`: no pass. `inside`: the ego is in `junctionId`, entered with `side` on;
 * `turn` is the heading change since entry, + left. `outside`: the pass left `junctionId` as a
 * qualifying turn and has waited `outsideS`.
 * @typedef {{phase: 'idle'}
 *   | {phase: 'inside', junctionId: string, side: 'left' | 'right' | null, turn: number, lastHeading: number}
 *   | {phase: 'outside', junctionId: string, side: 'left' | 'right', outsideS: number}} SignalCancelState
 */

/**
 * @typedef {object} SignalCancelConfig
 * @property {number} turnMinDeg Smallest heading change, in degrees, that is a turn.
 * @property {number} clearM Hold-off distance: no other junction may lie ahead within it.
 */

/**
 * A tracker with no pass.
 * @returns {SignalCancelState} State.
 */
export function createSignalCancel() {
  return { phase: 'idle' };
}

/**
 * Signed smallest angle from `a` to `b`, in (−π, π]; + is left (counter-clockwise), as the
 * scorer's `angleDiff`.
 * @param {number} a From θ.
 * @param {number} b To θ.
 * @returns {number} Angle.
 */
function turnBetween(a, b) {
  const d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) return d - 2 * Math.PI;
  if (d <= -Math.PI) return d + 2 * Math.PI;
  return d;
}

/**
 * Whether another junction than `leftId` lies ahead within `clearM`: one whose polygon comes within
 * `clearM` of the ego centre and whose nearest point is in the forward half-plane. The nearest
 * point is ahead exactly when the distance shrinks as the centre moves forward, so a central
 * difference of `distanceToPolygon` along the heading decides it.
 * @param {GameMap} map Map.
 * @param {[number, number]} p Ego centre.
 * @param {number} heading Heading θ.
 * @param {string} leftId Junction just left.
 * @param {number} clearM Distance.
 * @returns {boolean} A junction lies ahead.
 */
function junctionAhead(map, p, heading, leftId, clearM) {
  const fx = Math.cos(heading);
  const fz = -Math.sin(heading);
  const h = AHEAD_PROBE_M;
  /** @type {[number, number]} */
  const fwd = [p[0] + fx * h, p[1] + fz * h];
  /** @type {[number, number]} */
  const back = [p[0] - fx * h, p[1] - fz * h];
  return junctionsNear(map, [p], clearM).some(
    (j) => j.id !== leftId && distanceToPolygon(fwd, j.polygon) < distanceToPolygon(back, j.polygon),
  );
}

/**
 * Whether a pass turned far enough toward its indicator side.
 * @param {'left' | 'right'} side Indicator.
 * @param {number} turn Heading change since entry, + left.
 * @param {number} minRad Threshold.
 * @returns {boolean} Qualifies.
 */
function turnedToward(side, turn, minRad) {
  return side === 'left' ? turn >= minRad : turn <= -minRad;
}

/**
 * One step of the tracker on the pre-step pose. The caller applies `cancel` before the electrics,
 * and only when the player sent no indicator command on the same step.
 * @param {SignalCancelState} state State.
 * @param {GameMap} map Map.
 * @param {{pos: {x: number, z: number}, heading: number}} prePose Ego pose before this step.
 * @param {Indicators} indicators Indicator state before this step.
 * @param {SignalCancelConfig} cfg Thresholds.
 * @param {number} dt Step length in seconds.
 * @returns {{state: SignalCancelState, cancel: boolean}} Next state, and whether to switch the
 *   indicator off now.
 */
export function stepSignalCancel(state, map, prePose, indicators, cfg, dt) {
  /** @type {[number, number]} */
  const p = [prePose.pos.x, prePose.pos.z];
  const { heading } = prePose;
  const junctionId = locate(map, p, heading).junctionId;
  const side = indicators === 'left' || indicators === 'right' ? indicators : null;

  if (junctionId !== null) {
    if (state.phase === 'inside' && state.junctionId === junctionId) {
      return {
        state: {
          ...state,
          side: state.side !== null && side === state.side ? side : null,
          turn: state.turn + turnBetween(state.lastHeading, heading),
          lastHeading: heading,
        },
        cancel: false,
      };
    }
    return { state: { phase: 'inside', junctionId, side, turn: 0, lastHeading: heading }, cancel: false };
  }

  if (state.phase === 'inside') {
    const turn = state.turn + turnBetween(state.lastHeading, heading);
    const minRad = (cfg.turnMinDeg * Math.PI) / 180;
    if (state.side !== null && side === state.side && turnedToward(state.side, turn, minRad)) {
      return { state: { phase: 'outside', junctionId: state.junctionId, side: state.side, outsideS: 0 }, cancel: false };
    }
    return { state: createSignalCancel(), cancel: false };
  }

  if (state.phase === 'outside') {
    if (side !== state.side) return { state: createSignalCancel(), cancel: false };
    const outsideS = state.outsideS + dt;
    if (outsideS < SIGNAL_CANCEL_DELAY_S - 1e-9) return { state: { ...state, outsideS }, cancel: false };
    const cancel = !junctionAhead(map, p, heading, state.junctionId, cfg.clearM);
    return { state: createSignalCancel(), cancel };
  }

  return { state, cancel: false };
}
