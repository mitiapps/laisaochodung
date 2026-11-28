/**
 * A `GameApi` that replays recorded `HudState`s, for the dev preview page and UI tests before the
 * real game is integrated. It is a dev tool: the production entry point never imports it.
 */

/** @typedef {import('../../contracts/hud.js').HudState} HudState */
/** @typedef {import('../../contracts/hud.js').GameApi} GameApi */

/**
 * @typedef {object} StubStates
 * @property {HudState} ready State right after start.
 * @property {HudState} running Driving, no breaches.
 * @property {HudState} withToasts Driving with breaches.
 * @property {HudState} paused Paused.
 * @property {HudState} finished Finished with a report.
 */

/**
 * Creates the replaying stub.
 * @param {StubStates} states Recorded states (e.g. `tests/fixtures/hud-states.json`).
 * @param {{stepMs?: number}} [options] Delay between replayed states.
 * @returns {GameApi & {calls: string[]}} Stub API; `calls` logs every call for tests. `start` is
 *   logged as `start:<map>:<vehicle>`, followed by `:<options JSON>` when options are given. Only
 *   `mode` changes the replay: a free run emits the recorded states with `mode: 'free'`, no `nav`
 *   and a `breachCount`, and finishes only on `quit`. `controls` calls are logged as `hold:<action>:<on>`,
 *   `press:<action>` and `steer:<value>` and change nothing.
 */
export function createStubGame(states, { stepMs = 1500 } = {}) {
  /** @type {Set<(state: HudState) => void>} */
  const listeners = new Set();
  /** @type {ReturnType<typeof setTimeout>[]} */
  let timers = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {HudState} */
  let last = states.ready;
  /** @type {import('../../contracts/hud.js').RunMode} */
  let mode = 'scored';

  /**
   * A recorded state in the current run's mode. A free state also carries `breachCount`, the field
   * the session fills for the free mode's tally, counted from the recorded toasts.
   * @param {HudState} state Recorded state.
   * @returns {HudState} State.
   */
  const inMode = (state) =>
    mode === 'free'
      ? /** @type {HudState} */ ({ ...state, mode: 'free', nav: null, breachCount: new Set(state.toasts.map((b) => b.episodeId)).size })
      : { ...state, mode: 'scored' };
  /** @returns {HudState[]} What a run replays after `ready`. */
  const run = () => (mode === 'free' ? [states.running, states.withToasts] : [states.running, states.withToasts, states.finished]);

  /** @param {HudState} state State to emit. */
  const emit = (state) => {
    last = state;
    for (const fn of listeners) fn(state);
  };
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  /** @param {HudState[]} sequence States to emit one per step. */
  const play = (sequence) => {
    clearTimers();
    sequence.forEach((state, i) => timers.push(setTimeout(() => emit(inMode(state)), stepMs * (i + 1))));
  };
  /** @param {Partial<import('../../contracts/score.js').ScoreReport>} [overrides] Report fields. */
  const finish = (overrides) => {
    clearTimers();
    const report = states.finished.report ? { ...states.finished.report, ...overrides } : undefined;
    emit(inMode({ ...states.finished, report }));
  };

  return {
    calls,
    async start(mapId, vehicleId, options) {
      calls.push(options === undefined ? `start:${mapId}:${vehicleId}` : `start:${mapId}:${vehicleId}:${JSON.stringify(options)}`);
      mode = options?.mode === 'free' ? 'free' : 'scored';
      emit(inMode(states.ready));
      play(run());
    },
    pause() {
      calls.push('pause');
      if (last.runStatus !== 'running') return;
      clearTimers();
      emit({ ...last, runStatus: 'paused' });
    },
    resume() {
      calls.push('resume');
      if (last.runStatus !== 'paused') return;
      emit({ ...last, runStatus: 'running' });
      play(mode === 'free' ? [] : [states.finished]);
    },
    restart() {
      calls.push('restart');
      emit(inMode(states.ready));
      play(run());
    },
    quit() {
      calls.push('quit');
      if (last.runStatus === 'finished') return;
      finish(states.finished.report ? { endedBy: 'quit', finished: false } : undefined);
    },
    controls: {
      hold(action, on) {
        calls.push(`hold:${action}:${on}`);
      },
      press(action) {
        calls.push(`press:${action}`);
      },
      steer(value) {
        calls.push(`steer:${value}`);
      },
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(last);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
