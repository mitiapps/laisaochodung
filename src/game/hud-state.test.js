import { describe, expect, it } from 'vitest';
import frames from '../../tests/fixtures/frames-straight.json';
import { HUD_TOAST_WINDOW, hudStateOf } from './hud-state.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */

const context = /** @type {import('../contracts/score.js').ScoreContext} */ (
  /** @type {unknown} */ ({ speedLimitKmh: 50, speedLimitVerified: false })
);

describe('hudStateOf', () => {
  it('copies the applied controls, speed, limit and nav from the frame', () => {
    const base = /** @type {Frame} */ (frames[10]);
    const input = { ...base.ego.input, throttle: 0.7, brakeFront: 0.2, brakeRear: 0.1, steer: -0.4, handbrake: true };
    const frame = { ...base, ego: { ...base.ego, input } };
    const state = hudStateOf({ frame, context, score: 9.5, breaches: [], runStatus: 'running' });
    expect(state.controls).toEqual({ throttle: 0.7, brakeFront: 0.2, brakeRear: 0.1, steer: -0.4, handbrake: true });
    expect(state.speedKmh).toBeCloseTo(54);
    expect(state.speedLimitVerified).toBe(false);
    expect(state.nav).toEqual({ distanceM: frame.route.distanceM, bearingRad: frame.route.bearingRad });
    expect(state.report).toBeUndefined();
  });

  it('resends only the most recent breaches', () => {
    const frame = /** @type {Frame} */ (frames[0]);
    const breaches = Array.from({ length: HUD_TOAST_WINDOW + 3 }, (_, i) => /** @type {import('../contracts/score.js').Breach} */ (/** @type {unknown} */ ({ episodeId: `e${i}` })));
    const state = hudStateOf({ frame, context, score: 10, breaches, runStatus: 'running' });
    expect(state.toasts.map((b) => b.episodeId)).toEqual(breaches.slice(-HUD_TOAST_WINDOW).map((b) => b.episodeId));
  });
});
