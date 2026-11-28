/**
 * Spoken tutorial lines per map: which audio file plays on which run event. Paths are relative to
 * `public/`. The lines carry no legal number: fines, points and limits stay in the rules data.
 * A map without an entry stays silent.
 */

/**
 * @typedef {object} VoiceCueSet
 * @property {string} [start] Played when a run starts (`ready` -> `running`).
 * @property {string} [finish] Played when a run ends with `endedBy: 'finish'`.
 * @property {Readonly<Record<string, string>>} [rules] Played on the first breach of each rule id
 *   in a run.
 */

/** @type {Readonly<Record<string, Readonly<VoiceCueSet>>>} */
export const VOICE_CUES = Object.freeze({
  'tutorial-02-nga-tu': Object.freeze({
    start: 'audio/tutorial-02/start.mp3',
    finish: 'audio/tutorial-02/finish.mp3',
    rules: Object.freeze({
      'red-light': 'audio/tutorial-02/red-light.mp3',
      'stop-sign': 'audio/tutorial-02/stop-sign.mp3',
    }),
  }),
});
