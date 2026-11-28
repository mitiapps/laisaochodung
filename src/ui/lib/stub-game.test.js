import { afterEach, describe, expect, it, vi } from 'vitest';
import hudStates from '../../../tests/fixtures/hud-states.json';
import { createStubGame } from './stub-game.js';

/** @type {import('./stub-game.js').StubStates} */
const states = /** @type {import('./stub-game.js').StubStates} */ (/** @type {unknown} */ (hudStates));

afterEach(() => vi.useRealTimers());

describe('stub GameApi', () => {
  it('replays the recorded states after start and stops on pause', async () => {
    vi.useFakeTimers();
    const game = createStubGame(states, { stepMs: 100 });
    /** @type {string[]} */
    const seen = [];
    const off = game.subscribe((s) => seen.push(s.runStatus));
    await game.start('fixture-minimal', 'car-sedan');
    vi.advanceTimersByTime(250);
    game.pause();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['ready', 'ready', 'running', 'running', 'paused']);
    off();
  });

  it('ends with endedBy quit when the player quits', async () => {
    vi.useFakeTimers();
    const game = createStubGame(states, { stepMs: 100 });
    /** @type {import('../../contracts/hud.js').HudState | null} */
    let last = null;
    game.subscribe((s) => {
      last = s;
    });
    await game.start('m', 'v');
    game.quit();
    expect(last?.runStatus).toBe('finished');
    expect(last?.report?.endedBy).toBe('quit');
    expect(game.calls).toEqual(['start:m:v', 'quit']);
  });

  it('records start options and control calls', async () => {
    vi.useFakeTimers();
    const game = createStubGame(states, { stepMs: 100 });
    await game.start('m', 'v', { controlPreset: 'real' });
    game.controls.hold('throttle', true);
    game.controls.press('signalLeft');
    game.controls.steer(-0.5);
    game.controls.steer(null);
    expect(game.calls).toEqual(['start:m:v:{"controlPreset":"real"}', 'hold:throttle:true', 'press:signalLeft', 'steer:-0.5', 'steer:null']);
  });

  it('replays a free run with no nav, never finishing until the player quits', async () => {
    vi.useFakeTimers();
    const game = createStubGame(states, { stepMs: 100 });
    /** @type {import('../../contracts/hud.js').HudState[]} */
    const seen = [];
    game.subscribe((s) => seen.push(s));
    await game.start('m', 'v', { controlPreset: 'simple', mode: 'free' });
    vi.advanceTimersByTime(10_000);
    const run = seen.slice(1);
    expect(run.map((s) => s.runStatus)).toEqual(['ready', 'running', 'running']);
    expect(run.every((s) => s.mode === 'free' && s.nav === null)).toBe(true);
    expect(run.map((s) => /** @type {{breachCount?: number}} */ (s).breachCount)).toEqual([0, 0, new Set(states.withToasts.toasts.map((b) => b.episodeId)).size]);
    game.pause();
    game.resume();
    vi.advanceTimersByTime(10_000);
    expect(seen.at(-1)?.runStatus).toBe('running');
    game.quit();
    expect(seen.at(-1)).toMatchObject({ runStatus: 'finished', mode: 'free', nav: null, report: { endedBy: 'quit' } });
    game.restart();
    expect(seen.at(-1)).toMatchObject({ runStatus: 'ready', mode: 'free' });
    await game.start('m', 'v');
    expect(seen.at(-1)?.mode).toBe('scored');
  });
});
