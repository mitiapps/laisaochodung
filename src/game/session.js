/**
 * The game session: implements `GameApi` (src/contracts/hud.js) by tying input, sim, scorer,
 * renderer and HUD together behind a fixed-timestep loop. Every collaborator is injected, so the
 * session runs under Node tests with stubs; `src/game/browser.js` supplies the real ones.
 *
 * A run: `start` loads the map, the rules bundle and Rapier, creates the sim, the scorer and the
 * view, takes the first step and publishes `ready`, then `running`. Each fixed step samples the
 * input, steps the sim and folds the scorer over the same frame the renderer draws. HUD states go
 * out at 15 Hz, and at once when a breach opens or escalates. The run ends on a `finish` or
 * `timeout` event, on `runEnded: 'crash'` from the scorer, or on `quit()`; the report then comes
 * from `scorer.report(state, {quit})`. A `fall` needs nothing here: the sim resets itself.
 *
 * Controls: each run applies a control preset (`simple` unless the start options say `real`): the
 * sim assists and the input's brake mapping come from `resolveControlPreset`. The preset is fixed
 * for the run, `restart()` repeats it, and it never reaches the scorer or the report. On-screen
 * controls reach the run's input through `controls`.
 *
 * Traffic: the session runs the map's traffic block (`traffic: 'map'`) with a fresh 32-bit run seed
 * per run, unless a start option or, in dev builds, the `?traffic=off` / `?seed=<n>` hash query says
 * otherwise. Notices the scorer raises reach the HUD beside the breach toasts.
 *
 * In dev builds every map is checked with `assertMap` and every frame with `assertFrame`, and frames
 * are kept for a replay check: at the end `scoreRun` over the kept frames, folded from the kept
 * scorer state, must equal the live report. Without traffic the whole run is kept. With traffic,
 * tumbling checkpoints every `REPLAY_CHECKPOINT_S` bound the memory: each checkpoint keeps a
 * reference to the live scorer state (plain immutable JSON) and drops the frames before the
 * previous checkpoint, so at most two intervals of frames and two states are held.
 */

import { neutralInput } from '../contracts/controls.js';
import { DT } from '../contracts/units.js';
import { vehicleTuning as physicsVehicleTuning } from '../physics/vehicles/index.js';
import { resolveControlPreset } from './control-presets.js';
import { hudStateOf } from './hud-state.js';

/** @typedef {import('../contracts/hud.js').GameApi} GameApi */
/** @typedef {import('../contracts/hud.js').HudState} HudState */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/rule.js').RulesBundle} RulesBundle */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/score.js').Breach} Breach */
/** @typedef {import('../contracts/score.js').ScoreContext} ScoreContext */
/** @typedef {import('../contracts/score.js').ScoreReport} ScoreReport */
/** @typedef {import('../contracts/modules.js').Sim} Sim */
/** @typedef {import('../contracts/modules.js').Scorer} Scorer */
/** @typedef {import('../contracts/modules.js').Renderer} Renderer */
/** @typedef {import('../contracts/score.js').Notice} Notice */
/** @typedef {import('../contracts/traffic.js').TrafficParams} TrafficParams */
/** @typedef {import('./loop.js').Loop} Loop */
/** @typedef {import('./loop.js').LoopDeps} LoopDeps */
/** @typedef {import('./input.js').Input} Input */
/** @typedef {import('./input.js').InputOptions} InputOptions */
/** @typedef {import('../contracts/controls.js').ControlPreset} ControlPreset */

/** HUD publishing rate between breaches. */
export const HUD_HZ = 15;
/** Ids that may appear in a map file name (they come from the URL hash). */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Dev builds keep this many frame work times for `debugInfo().frameWorkMs`. */
const FRAME_TIME_SAMPLES = 600;
/** Dev builds keep this many sim step times for `debugInfo().simStepMs`. */
const SIM_STEP_SAMPLES = 600;
/** Interval of the replay checkpoints on maps with traffic, in seconds of run time. */
export const REPLAY_CHECKPOINT_S = 10;
/** The same interval in fixed steps. */
const CHECKPOINT_TICKS = Math.round(REPLAY_CHECKPOINT_S / DT);
/** Largest run seed: seeds are 32-bit unsigned integers. */
const MAX_SEED = 0xffffffff;

/**
 * Run options beyond the `GameApi` start options. Session-level only (tests and dev tools); the UI
 * passes none, and release builds never read the dev hash query.
 * @typedef {object} RunOptions
 * @property {'map' | 'off'} [traffic] `map` (default) runs the map's traffic block, `off` runs the
 *   scripted actors only.
 * @property {number} [seed] Fixed 32-bit unsigned run seed; a fresh random one by default.
 */

/**
 * @typedef {import('../contracts/hud.js').StartOptions & RunOptions} SessionStartOptions
 */

/**
 * Checks run options from a caller or the dev hash query.
 * @param {RunOptions} options Options.
 * @param {string} source Where they came from, for the error message.
 * @returns {RunOptions} The same options.
 */
export function checkRunOptions(options, source) {
  if (options.traffic !== undefined && options.traffic !== 'map' && options.traffic !== 'off') {
    throw new RangeError(`${source}: traffic must be 'map' or 'off', got ${String(options.traffic)}`);
  }
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > MAX_SEED)) {
    throw new RangeError(`${source}: seed must be an integer in 0..${MAX_SEED}, got ${String(options.seed)}`);
  }
  return options;
}

/**
 * A fresh 32-bit unsigned run seed from the platform's cryptographic random source.
 * @returns {number} Seed.
 */
function randomSeed() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * Mean and 95th percentile of samples.
 * @param {readonly number[]} samples Samples.
 * @returns {{mean: number, p95: number} | null} Statistics, null without samples.
 */
function meanAndP95(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { mean: sum / sorted.length, p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] };
}

/**
 * A drawing surface for one run: a renderer plus whatever it lives on.
 * @typedef {object} View
 * @property {Renderer} renderer Renderer.
 * @property {() => void} dispose Frees the renderer and its surface.
 */

/**
 * @typedef {object} SessionDeps
 * @property {readonly VehicleInfo[]} vehicles Vehicle catalog.
 * @property {(mapId: string) => Promise<GameMap>} loadMap Loads a built map.
 * @property {() => Promise<RulesBundle>} loadRules Loads the rules bundle.
 * @property {() => Promise<unknown>} loadRapier Initialised Rapier module.
 * @property {() => Promise<TrafficParams>} [loadTrafficParams] Compiled traffic parameters. Traffic
 *   needs them: a session built without this loader runs every map with traffic off (headless
 *   harnesses that drive scripted actors only).
 * @property {() => RunOptions} [devRunOptions] Dev builds only: run options from the dev hash query
 *   (`?traffic=off`, `?seed=<n>`); start options win over them.
 * @property {import('../contracts/modules.js').CreateSim} createSim Sim factory.
 * @property {(vehicleId: string) => import('../physics/tuning.js').VehicleTuning} [vehicleTuning]
 *   Physics tuning of a catalog vehicle, for the preset's brake mapping; the sim's own lookup by
 *   default.
 * @property {import('../contracts/modules.js').CreateScorer} createScorer Scorer factory.
 * @property {(map: GameMap, vehicle: VehicleInfo) => View} createView View factory.
 * @property {(options: InputOptions) => Input} createInput Input factory.
 * @property {(deps: LoopDeps) => Loop} createLoop Loop factory.
 * @property {LoopDeps['requestFrame']} requestFrame Animation-frame scheduler.
 * @property {LoopDeps['cancelFrame']} cancelFrame Cancels a scheduled frame.
 * @property {() => number} now Clock in milliseconds.
 * @property {EventTarget} keyTarget Where key events arrive.
 * @property {{visibilityState: string} & EventTarget} [visibility] Pauses the run when hidden.
 * @property {boolean} [dev] Dev build checks and frame keeping.
 * @property {(frame: Frame) => void} [assertFrame] Frame check (dev).
 * @property {(map: GameMap) => void} [assertMap] Map check (dev).
 * @property {import('../contracts/modules.js').ScoreRun} [scoreRun] Replay fold (dev).
 * @property {(message: string, err?: unknown) => void} [logError] Error sink.
 */

/**
 * @typedef {object} ReplayCheck
 * @property {number} frames Frames replayed.
 * @property {boolean} equal `scoreRun` over the kept frames equals the live report.
 * @property {boolean} windowed The kept frames were folded from a checkpoint state.
 */

/**
 * @typedef {object} DebugInfo
 * @property {HudState['runStatus'] | 'loading' | null} status Status of the current run.
 * @property {number} tick Tick of the latest frame, −1 before the first.
 * @property {{x: number, z: number, heading: number, speed: number} | null} ego Latest ego pose,
 *   for browser automation.
 * @property {Array<{id: string, kind: 'pedestrian' | 'car' | 'motorbike', x: number, z: number, speed: number, active: boolean}>} actors
 *   Latest actor poses (scripted, then traffic), so browser automation can yield to them.
 * @property {'map' | 'off' | null} traffic Whether traffic runs in the current run: `off` also on a
 *   map without a traffic block.
 * @property {number | null} runSeed Run seed of the current run.
 * @property {ControlPreset | null} controlPreset Control preset of the current run.
 * @property {number} agents Traffic agents in the latest frame.
 * @property {number} mirrored Traffic agents in the latest frame within `mirrorRadiusM` of the ego,
 *   capped at `maxMirrored`: the candidates the sim's mirror pool takes. Derived from the frame,
 *   since the sim does not report its pool.
 * @property {{mean: number, p95: number} | null} simStepMs Wall time of recent `sim.step` calls
 *   (physics, scripted actors and traffic together), rolling (dev builds).
 * @property {number} keptFrames Frames kept (dev builds).
 * @property {ReplayCheck | null} replayCheck Result of the last finished run (dev builds).
 * @property {number[]} frameWorkMs Step-and-render time of recent animation frames (dev builds).
 */

/**
 * @typedef {object} Run
 * @property {number} id Run sequence number.
 * @property {HudState['runStatus'] | 'loading'} status Status.
 * @property {GameMap | null} map Map.
 * @property {VehicleInfo} vehicle Vehicle.
 * @property {RulesBundle | null} bundle Rules.
 * @property {Sim | null} sim Sim.
 * @property {Scorer | null} scorer Scorer.
 * @property {unknown} scorerState Scorer state.
 * @property {ScoreContext | null} context Latest context.
 * @property {View | null} view View.
 * @property {Input | null} input Input.
 * @property {Loop | null} loop Loop.
 * @property {Frame | null} prev Previous frame.
 * @property {Frame | null} curr Latest frame.
 * @property {Breach[]} breaches Breaches so far.
 * @property {Notice[]} notices Notices so far, oldest first.
 * @property {'map' | 'off'} traffic Traffic actually running (`off` on a map without traffic).
 * @property {number} runSeed Run seed.
 * @property {ControlPreset} controlPreset Control preset applied.
 * @property {TrafficParams | null} trafficParams Traffic parameters while traffic runs.
 * @property {Frame[]} frames Kept frames (dev): every frame after the state `replayBase`.
 * @property {unknown} replayBase Scorer state the kept frames fold from (dev).
 * @property {{state: unknown, keepFrom: number} | null} checkpoint Newest checkpoint (dev, with
 *   traffic): the scorer state then and the index in `frames` of the first frame after it.
 * @property {boolean} endPending The last step ended the run.
 * @property {boolean} publishNow A breach is waiting to be published.
 * @property {number} lastHudMs Time of the last HUD publish.
 */

/**
 * Creates the session.
 * @param {SessionDeps} deps Dependencies.
 * @returns {GameApi & {debugInfo: () => DebugInfo}} Game API.
 */
export function createSession(deps) {
  const dev = deps.dev === true;
  const logError = deps.logError ?? ((message, err) => console.error(message, err));
  const tuningOf = deps.vehicleTuning ?? physicsVehicleTuning;
  /** @type {Set<(state: HudState) => void>} */
  const listeners = new Set();
  /** @type {HudState | null} */
  let last = null;
  let seq = 0;
  /** @type {Run | null} */
  let run = null;
  /** @type {{mapId: string, vehicleId: string, options: SessionStartOptions} | null} */
  let lastStart = null;
  /** @type {ReplayCheck | null} */
  let replayCheck = null;
  /** @type {number[]} */
  const frameWorkMs = [];
  /** @type {number[]} */
  const simStepMs = [];

  /** @param {HudState} state State. */
  const emit = (state) => {
    last = state;
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (err) {
        logError('A HUD subscriber failed', err);
      }
    }
  };

  /**
   * @param {Run} r Run with a frame.
   * @param {HudState['runStatus']} runStatus Status.
   * @param {ScoreReport} [report] Report.
   */
  const publish = (r, runStatus, report) => {
    if (!r.curr || !r.context || !r.scorer) return;
    const score = report ? report.score : r.scorer.report(r.scorerState, { quit: false }).score;
    r.lastHudMs = deps.now();
    r.publishNow = false;
    emit(
      hudStateOf({ frame: r.curr, context: r.context, score, breaches: r.breaches, notices: r.notices, controlPreset: r.controlPreset, runStatus, report }),
    );
  };

  /**
   * Frees everything a run holds. Each part is freed even when another fails.
   * @param {Run} r Run.
   */
  const disposeRun = (r) => {
    const parts = [
      () => r.loop?.stop(),
      () => r.input?.dispose(),
      () => r.sim?.dispose(),
      () => r.view?.dispose(),
    ];
    for (const free of parts) {
      try {
        free();
      } catch (err) {
        logError('Failed to free part of a run', err);
      }
    }
    r.loop = null;
    r.input = null;
    r.sim = null;
    r.view = null;
  };

  const teardown = () => {
    if (run) disposeRun(run);
    run = null;
  };

  /**
   * Takes a replay checkpoint after the frame just scored: the frames before the previous
   * checkpoint go, and the previous checkpoint's state becomes the state they fold from.
   * @param {Run} r Run.
   */
  const checkpoint = (r) => {
    if (r.checkpoint) {
      r.frames = r.frames.slice(r.checkpoint.keepFrom);
      r.replayBase = r.checkpoint.state;
    }
    r.checkpoint = { state: r.scorerState, keepFrom: r.frames.length };
  };

  /**
   * One fixed step.
   * @param {Run} r Running run.
   * @returns {boolean} Whether the run goes on.
   */
  const stepRun = (r) => {
    const sim = /** @type {Sim} */ (r.sim);
    const scorer = /** @type {Scorer} */ (r.scorer);
    const input = r.input ? r.input.sample() : neutralInput();
    const t0 = dev ? deps.now() : 0;
    const frame = sim.step(input);
    if (dev) {
      simStepMs.push(deps.now() - t0);
      if (simStepMs.length > SIM_STEP_SAMPLES) simStepMs.shift();
      deps.assertFrame?.(frame);
      r.frames.push(frame);
    }
    const res = scorer.step(r.scorerState, frame);
    r.scorerState = res.state;
    r.context = res.context;
    r.prev = r.curr;
    r.curr = frame;
    if (res.breaches.length > 0) {
      r.breaches.push(...res.breaches);
      r.publishNow = true;
    }
    if (res.notices.length > 0) {
      r.notices.push(...res.notices);
      r.publishNow = true;
    }
    if (dev && r.traffic === 'map' && (frame.tick + 1) % CHECKPOINT_TICKS === 0) checkpoint(r);
    const ended = res.runEnded === 'crash' || frame.events.some((e) => e.type === 'finish' || e.type === 'timeout');
    if (ended) r.endPending = true;
    return !ended;
  };

  /**
   * Ends a run and publishes its report.
   * @param {Run} r Run.
   * @param {boolean} quit The player quit.
   */
  const finishRun = (r, quit) => {
    r.loop?.stop();
    r.input?.setDriving(false);
    r.input?.setEnabled(false);
    r.status = 'finished';
    const scorer = /** @type {Scorer} */ (r.scorer);
    const report = scorer.report(r.scorerState, { quit });
    if (dev && deps.scoreRun && r.map && r.bundle) {
      const windowed = r.replayBase !== scorer.initial;
      const replay = deps.scoreRun(r.bundle, r.map, r.vehicle, r.frames, windowed ? { quit, initialState: r.replayBase } : { quit });
      replayCheck = { frames: r.frames.length, equal: JSON.stringify(replay) === JSON.stringify(report), windowed };
      if (!replayCheck.equal) logError('Replay check failed: scoreRun over the kept frames differs from the live report', { replay, report });
    }
    // Physics is no longer needed; the view keeps the last frame under the result screen.
    try {
      r.sim?.dispose();
    } catch (err) {
      logError('Failed to free the sim', err);
    }
    r.sim = null;
    publish(r, 'finished', report);
  };

  /**
   * Stops a run after an unexpected error and shows the run as finished without a report.
   * @param {Run} r Run.
   * @param {unknown} err Error.
   */
  const failRun = (r, err) => {
    logError('The run stopped after an error', err);
    r.status = 'finished';
    disposeRun(r);
    endWithoutReport();
  };

  /**
   * Publishes a state as finished with no report (the UI says the result is missing).
   * @param {HudState | null} [base] State to finish; the last published one by default.
   */
  const endWithoutReport = (base = last) => {
    if (!base) return;
    const { report: _dropped, ...rest } = base;
    void _dropped;
    emit({ ...rest, runStatus: 'finished' });
  };

  /**
   * Loop step for one run.
   * @param {Run} r Run.
   * @returns {boolean} Continue.
   */
  const loopStep = (r) => {
    if (run !== r || r.status !== 'running') return false;
    try {
      return stepRun(r);
    } catch (err) {
      failRun(r, err);
      return false;
    }
  };

  /**
   * Loop render for one run.
   * @param {Run} r Run.
   * @param {number} alpha Interpolation.
   */
  const loopRender = (r, alpha) => {
    if (run !== r || !r.curr || !r.view) return;
    const t0 = dev ? deps.now() : 0;
    try {
      r.view.renderer.render(r.prev, r.curr, alpha);
      if (r.endPending) finishRun(r, false);
      else if (r.status === 'running' && (r.publishNow || deps.now() - r.lastHudMs >= 1000 / HUD_HZ)) publish(r, 'running');
    } catch (err) {
      failRun(r, err);
    }
    if (dev) {
      frameWorkMs.push(deps.now() - t0);
      if (frameWorkMs.length > FRAME_TIME_SAMPLES) frameWorkMs.shift();
    }
  };

  const api = {
    /**
     * Starts a run in the start options' control preset (`simple` by default; an unknown value
     * is `simple` too). The session-level `traffic` and `seed` options win over the dev hash query.
     * @param {string} mapId Map id.
     * @param {string} vehicleId Vehicle id.
     * @param {SessionStartOptions} [options] Start options.
     * @returns {Promise<void>} Resolves once running, or when a newer start or a quit supersedes it.
     */
    async start(mapId, vehicleId, options = {}) {
      teardown();
      seq += 1;
      const id = seq;
      last = null;
      if (typeof mapId !== 'string' || !ID_PATTERN.test(mapId)) throw new Error(`Invalid map id "${String(mapId)}"`);
      const vehicle = deps.vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) throw new Error(`Unknown vehicle "${String(vehicleId)}"`);
      checkRunOptions(options, 'Start option');
      const query = dev && deps.devRunOptions ? checkRunOptions(deps.devRunOptions(), 'Dev hash query') : {};
      const trafficOption = options.traffic ?? query.traffic ?? 'map';
      if ((options.traffic ?? query.traffic) === 'map' && !deps.loadTrafficParams) throw new Error('Traffic was asked for, but the session has no loadTrafficParams');
      const runSeed = options.seed ?? query.seed ?? randomSeed();
      const tuning = tuningOf(vehicle.id);
      lastStart = { mapId, vehicleId, options };
      /** @type {Run} */
      const r = {
        id,
        status: 'loading',
        map: null,
        vehicle,
        bundle: null,
        sim: null,
        scorer: null,
        scorerState: null,
        context: null,
        view: null,
        input: null,
        loop: null,
        prev: null,
        curr: null,
        breaches: [],
        notices: [],
        traffic: 'off',
        runSeed,
        controlPreset: 'simple',
        trafficParams: null,
        frames: [],
        replayBase: null,
        checkpoint: null,
        endPending: false,
        publishNow: false,
        lastHudMs: 0,
      };
      run = r;
      /** @type {[GameMap, RulesBundle, unknown, TrafficParams | null]} */
      let loaded;
      const wantsParams = trafficOption === 'map' && deps.loadTrafficParams !== undefined;
      try {
        loaded = await Promise.all([
          deps.loadMap(mapId),
          deps.loadRules(),
          deps.loadRapier(),
          wantsParams ? /** @type {() => Promise<TrafficParams>} */ (deps.loadTrafficParams)() : Promise.resolve(null),
        ]);
      } catch (err) {
        if (run !== r) return;
        run = null;
        throw err;
      }
      if (run !== r) return;
      const [map, bundle, rapier, params] = loaded;
      try {
        if (dev) deps.assertMap?.(map);
        r.map = map;
        r.bundle = bundle;
        if (params && map.traffic) {
          r.traffic = 'map';
          r.trafficParams = params;
        }
        const controls = resolveControlPreset(options.controlPreset, bundle, tuning);
        r.controlPreset = controls.preset;
        const traffic = params ? { traffic: /** @type {const} */ ('map'), runSeed, params } : { traffic: /** @type {const} */ ('off'), runSeed };
        r.sim = deps.createSim(rapier, map, vehicle, { ...traffic, assists: controls.simAssists });
        r.scorer = deps.createScorer(bundle, map, vehicle);
        r.scorerState = r.scorer.initial;
        r.replayBase = r.scorer.initial;
        r.view = deps.createView(map, vehicle);
        r.input = deps.createInput({
          legalClass: vehicle.legalClass,
          surfaceGrip: map.environment.surfaceGrip,
          target: deps.keyTarget,
          ...(deps.visibility ? { visibility: deps.visibility } : {}),
          combinedRearPerGrip: controls.inputOptions.combinedRearPerGrip,
          onPause: () => {
            if (run !== r) return;
            if (r.status === 'running') api.pause();
            else if (r.status === 'paused') api.resume();
          },
        });
        r.loop = deps.createLoop({
          step: () => loopStep(r),
          render: (alpha) => loopRender(r, alpha),
          requestFrame: deps.requestFrame,
          cancelFrame: deps.cancelFrame,
          now: deps.now,
        });
        // The first step happens before `ready`, so the HUD and the view start from a real frame.
        r.input.setEnabled(true);
        const goesOn = stepRun(r);
        r.view.renderer.render(null, /** @type {Frame} */ (r.curr), 1);
        r.status = 'ready';
        publish(r, 'ready');
        if (!goesOn) {
          finishRun(r, false);
          return;
        }
        r.status = 'running';
        r.input.setDriving(true);
        publish(r, 'running');
        r.loop.start();
      } catch (err) {
        disposeRun(r);
        if (run === r) run = null;
        throw err;
      }
    },

    pause() {
      const r = run;
      if (!r || r.status !== 'running') return;
      r.loop?.stop();
      r.input?.setDriving(false);
      r.status = 'paused';
      publish(r, 'paused');
    },

    resume() {
      const r = run;
      if (!r || r.status !== 'paused') return;
      r.status = 'running';
      r.input?.setDriving(true);
      publish(r, 'running');
      r.loop?.start();
    },

    restart() {
      if (!lastStart) return;
      const { mapId, vehicleId, options } = lastStart;
      const before = last;
      api.start(mapId, vehicleId, options).catch((err) => {
        logError('Failed to restart the run', err);
        endWithoutReport(before);
      });
    },

    quit() {
      const r = run;
      if (!r || r.status === 'finished') return;
      if (r.status === 'loading') {
        // Cancel the load; the pending start sees that it was superseded.
        disposeRun(r);
        run = null;
        return;
      }
      try {
        finishRun(r, true);
      } catch (err) {
        failRun(r, err);
      }
    },

    /**
     * On-screen controls, forwarded to the current run's input; ignored with no run.
     * @type {import('../contracts/hud.js').GameControls}
     */
    controls: {
      hold(action, on) {
        run?.input?.hold?.(action, on);
      },
      press(action) {
        run?.input?.press?.(action);
      },
      steer(value) {
        run?.input?.steer?.(value);
      },
    },

    /**
     * @param {(state: HudState) => void} fn Listener.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(fn) {
      listeners.add(fn);
      // A finished state belongs to a run the new subscriber did not watch; replaying it would
      // flash an old result screen before the next run starts.
      if (last && last.runStatus !== 'finished') fn(last);
      return () => {
        listeners.delete(fn);
      };
    },

    /** @returns {DebugInfo} Dev diagnostics. */
    debugInfo() {
      const curr = run?.curr ?? null;
      const scripted = run?.map ? run.map.actors.length : 0;
      const agents = curr && run?.traffic === 'map' ? curr.actors.slice(scripted) : [];
      const params = run?.trafficParams ?? null;
      const near = curr && params ? agents.filter((a) => Math.hypot(a.pos.x - curr.ego.pos.x, a.pos.z - curr.ego.pos.z) <= params.mirrorRadiusM).length : 0;
      return {
        status: run ? run.status : null,
        tick: curr ? curr.tick : -1,
        ego: curr ? { x: curr.ego.pos.x, z: curr.ego.pos.z, heading: curr.ego.heading, speed: curr.ego.speed } : null,
        actors: curr ? curr.actors.map((a) => ({ id: a.id, kind: a.kind, x: a.pos.x, z: a.pos.z, speed: a.speed, active: a.active })) : [],
        traffic: run && run.status !== 'loading' ? run.traffic : null,
        runSeed: run ? run.runSeed : null,
        controlPreset: run ? run.controlPreset : null,
        agents: agents.length,
        mirrored: params ? Math.min(params.maxMirrored, near) : 0,
        simStepMs: meanAndP95(simStepMs),
        keptFrames: run ? run.frames.length : 0,
        replayCheck,
        frameWorkMs: [...frameWorkMs],
      };
    },
  };

  if (deps.visibility) {
    const vis = deps.visibility;
    vis.addEventListener('visibilitychange', () => {
      if (vis.visibilityState === 'hidden') api.pause();
    });
  }

  return api;
}
