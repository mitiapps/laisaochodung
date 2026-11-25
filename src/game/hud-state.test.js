import { describe, expect, it } from 'vitest';
import frames from '../../tests/fixtures/frames-straight.json';
import { TOAST_MS } from '../ui/lib/toast-stack.js';
import { HUD_NOTICE_MAX, HUD_NOTICE_S, HUD_TOAST_WINDOW, hudStateOf } from './hud-state.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/score.js').Notice} Notice */

/**
 * A notice raised at run time `t`.
 * @param {number} t Time.
 * @returns {Notice} Notice.
 */
const notice = (t) => ({
  kind: 'npc-fault',
  tick: Math.round(t * 60),
  t,
  pos: { x: 0, z: 0 },
  otherKind: 'car',
  otherModel: 'car',
  violations: [],
  text: { vi: 'Xe khác va vào bạn từ phía sau. Trò chơi không ghi nhận lỗi của bạn, không trừ điểm.' },
});

/**
 * Frame of the fixture moved to run time `t`.
 * @param {number} t Time.
 * @returns {Frame} Frame.
 */
const frameAt = (t) => ({ .../** @type {Frame} */ (frames[0]), t });

const context = /** @type {import('../contracts/score.js').ScoreContext} */ (
  /** @type {unknown} */ ({ speedLimitKmh: 50, speedLimitVerified: false })
);

describe('hudStateOf', () => {
  it('copies the applied controls, speed, limit and nav from the frame', () => {
    const base = /** @type {Frame} */ (frames[10]);
    const input = { ...base.ego.input, throttle: 0.7, brakeFront: 0.2, brakeRear: 0.1, steer: -0.4, handbrake: true };
    const frame = { ...base, ego: { ...base.ego, input } };
    const state = hudStateOf({ frame, context, score: 9.5, breaches: [], controlPreset: 'simple', runStatus: 'running' });
    expect(state.controls).toEqual({ throttle: 0.7, brakeFront: 0.2, brakeRear: 0.1, steer: -0.4, handbrake: true });
    expect(state.speedKmh).toBeCloseTo(54);
    expect(state.speedLimitVerified).toBe(false);
    expect(state.nav).toEqual({ distanceM: frame.route.distanceM, bearingRad: frame.route.bearingRad });
    expect(state.report).toBeUndefined();
    expect(state.controlPreset).toBe('simple');
    expect(hudStateOf({ frame, context, score: 9.5, breaches: [], controlPreset: 'real', runStatus: 'running' }).controlPreset).toBe('real');
  });

  it('resends only the most recent breaches', () => {
    const frame = /** @type {Frame} */ (frames[0]);
    const breaches = Array.from({ length: HUD_TOAST_WINDOW + 3 }, (_, i) => /** @type {import('../contracts/score.js').Breach} */ (/** @type {unknown} */ ({ episodeId: `e${i}` })));
    const state = hudStateOf({ frame, context, score: 10, breaches, controlPreset: 'simple', runStatus: 'running' });
    expect(state.toasts.map((b) => b.episodeId)).toEqual(breaches.slice(-HUD_TOAST_WINDOW).map((b) => b.episodeId));
  });

  it('shows two notices raised within one second, newest last, and a later breach does not clear them', () => {
    const notices = [notice(2), notice(2.6)];
    const first = hudStateOf({ frame: frameAt(3), context, score: 10, breaches: [], notices, controlPreset: 'simple', runStatus: 'running' });
    expect(first.notices.map((n) => n.t)).toEqual([2, 2.6]);
    const breaches = Array.from({ length: HUD_TOAST_WINDOW + 2 }, (_, i) => /** @type {import('../contracts/score.js').Breach} */ (/** @type {unknown} */ ({ episodeId: `e${i}` })));
    const later = hudStateOf({ frame: frameAt(2 + HUD_NOTICE_S - 0.1), context, score: 9, breaches, notices, controlPreset: 'simple', runStatus: 'running' });
    expect(later.notices.map((n) => n.t)).toEqual([2, 2.6]);
    expect(later.toasts).toHaveLength(HUD_TOAST_WINDOW);
  });

  it('shows a notice for 4 s, shorter than the 6 s of a breach toast with its legal text', () => {
    expect(HUD_NOTICE_S).toBe(4);
    expect(TOAST_MS).toBe(6000);
  });

  it('drops a notice once its time is up and caps how many are sent', () => {
    // One notice at t = 1, four more in the last two seconds before its time is up.
    const end = 1 + HUD_NOTICE_S;
    const notices = [notice(1), notice(end - 2), notice(end - 1.8), notice(end - 1.6), notice(end - 1.4)];
    const state = hudStateOf({ frame: frameAt(end), context, score: 10, breaches: [], notices, controlPreset: 'simple', runStatus: 'running' });
    expect(state.notices.map((n) => n.t)).toEqual([end - 1.8, end - 1.6, end - 1.4]);
    expect(state.notices).toHaveLength(HUD_NOTICE_MAX);
    expect(hudStateOf({ frame: frameAt(20), context, score: 10, breaches: [], notices, controlPreset: 'simple', runStatus: 'running' }).notices).toEqual([]);
    expect(hudStateOf({ frame: frameAt(3), context, score: 10, breaches: [], controlPreset: 'simple', runStatus: 'running' }).notices).toEqual([]);
  });
});
