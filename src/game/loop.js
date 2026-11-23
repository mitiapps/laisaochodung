/**
 * Fixed-timestep game loop. The stepper is pure arithmetic over frame deltas; the loop drives it
 * from an injected animation-frame scheduler and clock, so both run under Node tests.
 *
 * Per animation frame: the delta since the last frame is clamped to `maxFrameS`, added to the
 * accumulator, and whole steps of `dt` are taken from it, at most `maxSteps` per frame. When the
 * cap is hit, whole steps still owed are dropped (the game slows down instead of spiralling);
 * the fractional remainder stays. The frame is then drawn with `alpha = acc / dt`.
 */

import { DT } from '../contracts/units.js';

/** Longest frame delta taken into account, in seconds. */
export const MAX_FRAME_S = 0.25;
/** Most fixed steps per rendered frame. */
export const MAX_STEPS_PER_FRAME = 5;

/**
 * @typedef {object} Stepper
 * @property {(deltaS: number) => {steps: number, alpha: number}} advance Adds a frame delta and
 *   returns how many fixed steps to take and the interpolation factor after them.
 * @property {() => void} reset Empties the accumulator.
 */

/**
 * Creates the accumulator.
 * @param {{dt?: number, maxFrameS?: number, maxSteps?: number}} [options] Step and caps.
 * @returns {Stepper} Stepper.
 */
export function createStepper({ dt = DT, maxFrameS = MAX_FRAME_S, maxSteps = MAX_STEPS_PER_FRAME } = {}) {
  if (!(dt > 0) || !(maxFrameS > 0) || !(Number.isInteger(maxSteps) && maxSteps > 0)) {
    throw new RangeError('createStepper needs dt > 0, maxFrameS > 0 and a positive integer maxSteps');
  }
  // Tolerance so a delta built from k · dt in floating point yields k steps, not k − 1.
  const eps = dt * 1e-6;
  let acc = 0;
  return {
    advance(deltaS) {
      const d = Number.isFinite(deltaS) ? Math.min(Math.max(0, deltaS), maxFrameS) : 0;
      acc += d;
      let steps = 0;
      while (acc >= dt - eps && steps < maxSteps) {
        acc = Math.max(0, acc - dt);
        steps += 1;
      }
      if (acc >= dt - eps) acc %= dt;
      return { steps, alpha: Math.min(1, acc / dt) };
    },
    reset() {
      acc = 0;
    },
  };
}

/**
 * @typedef {object} LoopDeps
 * @property {() => boolean} step Takes one fixed step; returns false to stop the loop after it.
 * @property {(alpha: number) => void} render Draws the current state.
 * @property {(cb: (ts: number) => void) => number} requestFrame Animation-frame scheduler.
 * @property {(handle: number) => void} cancelFrame Cancels a scheduled frame.
 * @property {() => number} now Clock in milliseconds.
 * @property {Stepper} [stepper] Accumulator; a default one is created.
 */

/**
 * @typedef {object} Loop
 * @property {() => void} start Starts (or resumes) the loop; the first frame takes no step.
 * @property {() => void} stop Stops it; the accumulator is kept for the next start.
 * @property {() => boolean} isRunning Whether a frame is scheduled.
 */

/**
 * Creates the loop.
 * @param {LoopDeps} deps Dependencies.
 * @returns {Loop} Loop.
 */
export function createLoop({ step, render, requestFrame, cancelFrame, now, stepper = createStepper() }) {
  let running = false;
  /** @type {number | null} */
  let handle = null;
  /** @type {number | null} */
  let lastMs = null;

  const frame = () => {
    handle = null;
    if (!running) return;
    const t = now();
    const deltaS = lastMs === null ? 0 : (t - lastMs) / 1000;
    lastMs = t;
    const { steps, alpha } = stepper.advance(deltaS);
    for (let i = 0; i < steps && running; i += 1) {
      if (!step()) running = false;
    }
    render(alpha);
    if (running) handle = requestFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastMs = null;
      handle = requestFrame(frame);
    },
    stop() {
      running = false;
      if (handle !== null) cancelFrame(handle);
      handle = null;
    },
    isRunning: () => running,
  };
}
