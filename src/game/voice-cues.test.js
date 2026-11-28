import { describe, expect, it, vi } from 'vitest';
import { VOICE_CUES } from '../config/voice-cues.js';
import { EMPTY_VOICE_MEMO, createVoiceCues, stepVoiceCues } from './voice-cues.js';

/** @typedef {import('../contracts/hud.js').HudState} HudState */

const MAP = 'tutorial-02-nga-tu';
const CUES = VOICE_CUES[MAP];

/**
 * A HUD state with only the fields the cues read.
 * @param {HudState['runStatus']} runStatus Status.
 * @param {string[]} [ruleIds] Rule ids of the toasts.
 * @param {'finish' | 'crash' | 'timeout' | 'quit'} [endedBy] How the run ended, when finished.
 * @returns {HudState} State.
 */
function hud(runStatus, ruleIds = [], endedBy) {
  return /** @type {HudState} */ (
    /** @type {unknown} */ ({
      runStatus,
      toasts: ruleIds.map((ruleId, i) => ({ ruleId, tick: i })),
      ...(endedBy ? { report: { endedBy } } : {}),
    })
  );
}

/**
 * Folds states and collects every path.
 * @param {HudState[]} states States.
 * @param {typeof CUES | null} [cues] Cue set.
 * @returns {string[]} Paths.
 */
function fold(states, cues = CUES) {
  let memo = EMPTY_VOICE_MEMO;
  /** @type {string[]} */
  const out = [];
  for (const s of states) {
    const r = stepVoiceCues(memo, s, cues);
    memo = r.memo;
    out.push(...r.paths);
  }
  return out;
}

describe('VOICE_CUES', () => {
  it('names files under audio/ for tutorial 02 only', () => {
    expect(Object.keys(VOICE_CUES)).toEqual([MAP]);
    const paths = [CUES.start, CUES.finish, ...Object.values(CUES.rules ?? {})];
    for (const p of paths) expect(p).toMatch(/^audio\/tutorial-02\/[a-z-]+\.mp3$/);
  });
});

describe('stepVoiceCues', () => {
  it('plays the start line on ready -> running only, not on resume', () => {
    expect(fold([hud('ready'), hud('running'), hud('running'), hud('paused'), hud('running')])).toEqual([CUES.start]);
  });

  it('plays each cued rule once per run and ignores other rules', () => {
    const paths = fold([hud('ready'), hud('running'), hud('running', ['speeding']), hud('running', ['speeding', 'red-light']), hud('running', ['red-light', 'red-light', 'stop-sign'])]);
    expect(paths).toEqual([CUES.start, CUES.rules?.['red-light'], CUES.rules?.['stop-sign']]);
  });

  it('starts over on a restart', () => {
    const paths = fold([hud('ready'), hud('running', ['red-light']), hud('ready'), hud('running', ['red-light'])]);
    expect(paths).toEqual([CUES.start, CUES.rules?.['red-light'], CUES.start, CUES.rules?.['red-light']]);
  });

  it('plays the finish line on a finish only, once', () => {
    expect(fold([hud('running'), hud('finished', [], 'finish'), hud('finished', [], 'finish')])).toEqual([CUES.finish]);
    for (const end of /** @type {const} */ (['crash', 'timeout', 'quit'])) expect(fold([hud('running'), hud('finished', [], end)])).toEqual([]);
  });

  it('stays silent with no cue set', () => {
    expect(fold([hud('ready'), hud('running', ['red-light']), hud('finished', [], 'finish')], null)).toEqual([]);
  });
});

describe('createVoiceCues', () => {
  /**
   * @param {boolean} [stored] Stored mute flag.
   * @returns {{cues: import('./voice-cues.js').VoiceCues, player: {play: import('vitest').Mock, stop: import('vitest').Mock}, write: import('vitest').Mock}} Rig.
   */
  function rig(stored = false) {
    const player = { play: vi.fn(), stop: vi.fn() };
    const write = vi.fn(() => true);
    const cues = createVoiceCues({ cues: VOICE_CUES, player, store: { read: () => stored, write } });
    return { cues, player, write };
  }

  it('plays only on the cued map', () => {
    const { cues, player } = rig();
    cues.setMap('tutorial-01-co-ban');
    cues.onHud(hud('ready'));
    cues.onHud(hud('running', ['red-light']));
    expect(player.play).not.toHaveBeenCalled();
    cues.setMap(MAP);
    cues.onHud(hud('ready'));
    cues.onHud(hud('running'));
    expect(player.play).toHaveBeenCalledWith(CUES.start);
    expect(cues.has(MAP)).toBe(true);
    expect(cues.has('tutorial-01-co-ban')).toBe(false);
    expect(cues.has('toString')).toBe(false);
  });

  it('consumes events while muted and stops the line on mute', () => {
    const { cues, player, write } = rig();
    /** @type {boolean[]} */
    const seen = [];
    cues.subscribe((m) => seen.push(m));
    cues.setMap(MAP);
    cues.onHud(hud('ready'));
    cues.setMuted(true);
    expect(player.stop).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(true);
    cues.onHud(hud('running', ['red-light']));
    cues.setMuted(false);
    cues.onHud(hud('running', ['red-light']));
    expect(player.play).not.toHaveBeenCalled();
    expect(seen).toEqual([false, true, false]);
  });

  it('starts muted from the store', () => {
    const { cues, player } = rig(true);
    expect(cues.muted()).toBe(true);
    cues.setMap(MAP);
    cues.onHud(hud('ready'));
    cues.onHud(hud('running'));
    expect(player.play).not.toHaveBeenCalled();
  });
});
