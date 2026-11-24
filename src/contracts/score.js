/**
 * Scorer output contract. Breaches are fully resolved so the UI needs no rule or clause lookup.
 */

/** @typedef {import('./vehicle.js').LocalText} LocalText */

/**
 * @typedef {object} Breach
 * @property {string} ruleId Rule id.
 * @property {LocalText} title Rule title.
 * @property {number} tierIndex Index into the rule's tiers.
 * @property {number} tick Tick of the breach.
 * @property {number} t Time of the breach.
 * @property {import('./telemetry.js').Pos2} pos Ego position at the breach.
 * @property {1 | 2 | 3 | 4 | 5} danger Danger level.
 * @property {number} deduction Score deduction of this breach.
 * @property {import('./rule.js').Clause | null} clause Resolved clause, null when score only.
 * @property {{number: string, title: string, url: string} | null} source Source of the clause.
 * @property {{sourceId: string, number: string, title: string, url: string}[]} amendmentSources
 *   One entry per distinct `sourceId` in `clause.amendments`, in first-use order; empty when the
 *   clause has no amendments or the breach is score only.
 * @property {boolean} inferred The clause applies by inference ("suy luận").
 * @property {string[]} designParams Detection parameters with `design` basis ("ngưỡng của trò chơi").
 * @property {boolean} scoreOnly No legal penalty.
 * @property {LocalText} [note] Tier note.
 * @property {string} [cause] Rule id of the cause (crash breaches).
 * @property {string} [causeEpisodeId] Episode id of the cause (crash breaches with a cause).
 * @property {string} [fineAbsorbedBy] Set in the report only: episode id of the accident whose fine
 *   band includes this breach's band, so it does not add to `fineTotalVnd` (the accident clause
 *   names the cause as an element of the offence).
 * @property {boolean} basisVerified False when the detection used unverified legal data (today a
 *   TT 38 default speed limit); the UI then shows "chưa kiểm chứng".
 * @property {string} episodeId Episode id; escalations reuse it.
 * @property {'new' | 'escalated'} kind A new episode, or a worse tier of an open one.
 */

/**
 * @typedef {object} ScoreContext
 * @property {number | null} speedLimitKmh Limit in force for the ego lane.
 * @property {'sign' | 'default' | null} speedLimitSource A placed sign or tutorial zone, a TT 38
 *   default, or null when no limit is in force.
 * @property {boolean} speedLimitVerified False only when the limit in force is an unverified TT 38
 *   default (the UI then shows "chưa kiểm chứng"); true for signs and when no limit is in force.
 * @property {boolean} builtUp Inside a built-up zone.
 * @property {string | null} roadId Road under the ego.
 * @property {string | null} laneId Lane under the ego.
 * @property {boolean} wrongWay Ego travels against its lane.
 */

/**
 * A contact the player did not cause (fault by law): shown to the player, no deduction.
 * @typedef {object} Notice
 * @property {'npc-fault'} kind Notice kind.
 * @property {number} tick Tick of the contact.
 * @property {number} t Time of the contact.
 * @property {import('./telemetry.js').Pos2} pos Ego position at the contact.
 * @property {import('./telemetry.js').CollisionEvent['otherKind'] | null} otherKind What the ego
 *   touched; null for a scooter fall inside the aftermath of a notice contact.
 * @property {string | null} otherModel Model key of the other actor, when known.
 * @property {import('./telemetry.js').NpcViolation[]} violations The other party's latched flags.
 * @property {LocalText} text Message, resolved from the policy's `noticeTexts`.
 */

/**
 * @typedef {object} ScoreReport
 * @property {number} score `max(0, 10 − Σ deductions)`, 0 after a pedestrian hit.
 * @property {Breach[]} breaches One entry per episode at its worst tier.
 * @property {Notice[]} notices Contacts the player did not cause, oldest first.
 * @property {{start: 12, deducted: number, remaining: number}} licence Only the largest point value
 *   is deducted, once, floor 0 (ND 168 Điều 50 khoản 1 điểm b, c).
 * @property {{min: number, max: number}} fineTotalVnd Sum of the fine bands of every episode not
 *   absorbed by an accident (`fineAbsorbedBy`), labelled "ước tính".
 * @property {boolean} finished Reached the finish.
 * @property {'finish' | 'crash' | 'timeout' | 'quit'} endedBy How the run ended.
 */

/** @type {readonly ScoreReport['endedBy'][]} */
export const ENDED_BY = Object.freeze(['finish', 'crash', 'timeout', 'quit']);

/** Licence points at the start of a run. */
export const LICENCE_START_POINTS = 12;
