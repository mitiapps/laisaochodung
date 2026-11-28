/**
 * Spoken tutorial lines: watches HUD states and asks a player to play the line of each run event
 * the map's cue set names (`src/config/voice-cues.js`). The event detection is a pure reducer over
 * `HudState`; the player and the mute store are injected, so tests run in Node with no DOM.
 *
 * Events: the start of a run (`ready` -> `running`, once per `start()` or `restart()`), the first
 * breach of each cued rule in a run, and a finish (`endedBy: 'finish'`; crash, timeout and quit stay
 * silent). While muted, events are still consumed, so unmuting never replays an old line.
 */

/** @typedef {import('../contracts/hud.js').HudState} HudState */
/** @typedef {import('../config/voice-cues.js').VoiceCueSet} VoiceCueSet */

/**
 * @typedef {object} VoiceCueMemo
 * @property {HudState['runStatus'] | null} status Run status of the last HUD state seen.
 * @property {string[]} played Rule ids whose line already played in this run.
 */

/** @type {Readonly<VoiceCueMemo>} */
export const EMPTY_VOICE_MEMO = Object.freeze({ status: null, played: [] });

/**
 * Folds one HUD state into the memo and returns the audio paths it triggers, in order.
 * @param {Readonly<VoiceCueMemo>} memo Memo.
 * @param {HudState} hud HUD state.
 * @param {Readonly<VoiceCueSet> | null} cues Cue set of the current map, or null for none.
 * @returns {{memo: VoiceCueMemo, paths: string[]}} Next memo and paths to play.
 */
export function stepVoiceCues(memo, hud, cues) {
  /** @type {string[]} */
  const paths = [];
  let played = hud.runStatus === 'ready' ? [] : memo.played;
  if (cues) {
    if (cues.start && memo.status === 'ready' && hud.runStatus === 'running') paths.push(cues.start);
    const rules = cues.rules ?? {};
    for (const breach of hud.toasts) {
      const path = rules[breach.ruleId];
      if (!path || played.includes(breach.ruleId)) continue;
      played = [...played, breach.ruleId];
      paths.push(path);
    }
    if (cues.finish && hud.runStatus === 'finished' && memo.status !== 'finished' && hud.report?.endedBy === 'finish') paths.push(cues.finish);
  }
  return { memo: { status: hud.runStatus, played }, paths };
}

/**
 * Plays audio files. The browser build wraps `HTMLAudioElement`.
 * @typedef {object} VoicePlayer
 * @property {(path: string) => void} play Play a file (path relative to `public/`), stopping the
 *   line already playing.
 * @property {() => void} stop Stop the line playing, if any.
 */

/**
 * Where the mute flag is kept between visits.
 * @typedef {object} VoiceMuteStore
 * @property {() => boolean} read Stored flag; never throws.
 * @property {(muted: boolean) => boolean} write Stores the flag; false where it could not be kept.
 */

/**
 * @typedef {object} VoiceCues
 * @property {(mapId: string | null) => void} setMap Map of the next run; resets the memo.
 * @property {(mapId: string | null) => boolean} has Whether a map has spoken lines.
 * @property {(hud: HudState) => void} onHud Feed one HUD state.
 * @property {() => boolean} muted Whether the voice is muted.
 * @property {(muted: boolean) => void} setMuted Mute or unmute; muting stops the line playing.
 * @property {(fn: (muted: boolean) => void) => () => void} subscribe Called with the flag now and
 *   on every change; returns an unsubscribe function.
 */

/**
 * Creates the voice cue controller.
 * @param {{cues: Readonly<Record<string, Readonly<VoiceCueSet>>>, player: VoicePlayer, store: VoiceMuteStore}} options Options.
 * @returns {VoiceCues} Controller.
 */
export function createVoiceCues({ cues, player, store }) {
  /** @type {Readonly<VoiceCueSet> | null} */
  let current = null;
  /** @type {Readonly<VoiceCueMemo>} */
  let memo = EMPTY_VOICE_MEMO;
  let muted = store.read();
  let warned = false;
  /** @type {Set<(muted: boolean) => void>} */
  const listeners = new Set();

  return {
    setMap(mapId) {
      current = (mapId && Object.hasOwn(cues, mapId) && cues[mapId]) || null;
      memo = EMPTY_VOICE_MEMO;
      player.stop();
    },
    has(mapId) {
      return Boolean(mapId && Object.hasOwn(cues, mapId));
    },
    onHud(hud) {
      const next = stepVoiceCues(memo, hud, current);
      memo = next.memo;
      const last = next.paths.at(-1);
      // One line at a time: when one state triggers several, the latest wins.
      if (last && !muted) player.play(last);
    },
    muted: () => muted,
    setMuted(next) {
      muted = next;
      if (muted) player.stop();
      if (!store.write(next) && !warned) {
        warned = true;
        console.warn('The voice setting could not be saved; it applies to this visit only');
      }
      for (const fn of listeners) fn(next);
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(muted);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
