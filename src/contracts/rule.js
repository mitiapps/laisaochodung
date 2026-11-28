/**
 * Legal data contract. Penalties live once in a clause table keyed by `D6.3.a`-style ids
 * (`D<điều>.<khoản>.<điểm>` of ND 168/2024, or `D<điều>.<khoản>` for a khoản with no điểm); rules point at clauses, so a law change edits one
 * record. `src/generated/rules.json` is one `RulesBundle`, the only rule input the game loads.
 */

/** @typedef {import('./vehicle.js').LocalText} LocalText */
/** @typedef {import('./vehicle.js').DecreeGroup} DecreeGroup */

/**
 * A quoted passage of a legal source.
 * @typedef {object} Citation
 * @property {string} sourceId `Source.id`.
 * @property {string} article Article, e.g. `Điều 6` or `Phụ lục B`.
 * @property {string} [clause] Khoản (or numbered clause such as `26.8`).
 * @property {string} [point] Điểm (or lettered point such as `B.27 b)`).
 * @property {string} quote Verbatim quote, Vietnamese.
 * @property {string} url Where the quote was read.
 */

/**
 * @typedef {object} Source
 * @property {string} id Stable id, e.g. `nd168-2024`.
 * @property {string} title Full title.
 * @property {string} number Official number, e.g. `168/2024/NĐ-CP`.
 * @property {string} edition Edition or consolidation note.
 * @property {string | null} issued `YYYY-MM-DD`, null until read from the text.
 * @property {string | null} effectiveFrom `YYYY-MM-DD`, null until read from the text.
 * @property {string} url Canonical URL.
 * @property {string[]} [amendedBy] Ids of amending sources.
 * @property {boolean} official The URL is an official publication.
 */

/** @typedef {{min: number, max: number}} Range Inclusive range. */

/**
 * One điểm (or a khoản without điểm) of ND 168 with its penalty.
 * @typedef {object} Clause
 * @property {string} id `D6.3.a`-style id.
 * @property {Range | null} fineVnd Fine band in VND.
 * @property {0 | 2 | 4 | 6 | 10} licencePoints Licence points deducted.
 * @property {Range | null} suspensionMonths Licence suspension.
 * @property {Citation} citation The ND 168 sentence.
 * @property {Citation[]} [amendments] Inserted or replaced wording, quoted separately (ND 238).
 * @property {string} effectiveFrom `YYYY-MM-DD` the current wording applies from.
 * @property {boolean} verified Read from an official text, or two copies of which one is official.
 * @property {string} checkedOn `YYYY-MM-DD` of the last check.
 */

/**
 * One penalty tier of a rule. Exactly one of three shapes:
 * - `scoreOnly: true`: has a `note`, no `clause`, no `clauseFromPolicy`.
 * - `clauseFromPolicy: true` (the crash rule): no `clause`; resolved through `CollisionPolicy`.
 * - otherwise: `clause` names a clause for every decree group the rule covers.
 * @typedef {object} Tier
 * @property {Record<string, unknown>} [when] Detector-specific condition (e.g. `{overKmh: {min: 5, max: 10}}`).
 * @property {1 | 2 | 3 | 4 | 5} danger Danger level; sets the score deduction.
 * @property {boolean} scoreOnly No legal penalty; deducts score only.
 * @property {boolean} [clauseFromPolicy] Clause chosen by `CollisionPolicy`.
 * @property {{D6?: string, D7?: string}} [clause] Clause id per decree group.
 * @property {boolean} [inferred] The clause applies by inference; the UI shows "suy luận".
 * @property {LocalText} [note] Explanation shown with the breach.
 */

/**
 * @typedef {object} Detection
 * @property {string} type Detector id implemented in `src/scoring/`.
 * @property {Record<string, unknown>} params Detector parameters (km/h, s, m).
 * @property {Record<string, 'legal' | 'design'>} paramBasis Basis of each parameter; `design`
 *   marks a threshold the game invented ("ngưỡng của trò chơi").
 */

/**
 * @typedef {object} Rule
 * @property {string} id Rule id, e.g. `speeding`.
 * @property {LocalText} title Title.
 * @property {LocalText} description What the rule checks.
 * @property {('car' | 'motorbike')[]} vehicleClasses Classes it applies to.
 * @property {Detection} detection Detector and parameters.
 * @property {Citation[]} obligation The duty itself (Law 36, TT 38 or QCVN 41).
 * @property {{ruleId: string, decreeGroups?: DecreeGroup[]}[]} [supersedes] One act yields one
 *   breach: this rule wins over these; omitted groups mean both.
 * @property {Tier[]} tiers Tiers from mildest to worst.
 */

/**
 * Meaning of one QCVN 41 sign code (`data/signs/signs.yaml`).
 * @typedef {object} SignMeaning
 * @property {string} code Code, e.g. `P.127`.
 * @property {LocalText} name Official name.
 * @property {Citation} citation Quote from QCVN 41:2024/BGTVT.
 * @property {boolean} verified Quote checked against the official text.
 * @property {string | null} figureChecked Date (YYYY-MM-DD) the game's drawing was compared with the
 *   official QCVN 41 figure, null until then; a null blocks the release.
 */

/**
 * Statutory default speed limit (TT 38/2024/TT-BGTVT).
 * @typedef {object} SpeedDefault
 * @property {import('./vehicle.js').LegalClass} legalClass Vehicle class.
 * @property {boolean} builtUp Inside an R.420 built-up area.
 * @property {boolean} multiLane Divided road, or one-way with two or more motor lanes.
 * @property {number} maxKmh Limit.
 * @property {Citation} citation Source quote.
 * @property {boolean} verified Read from an official text.
 */

/**
 * @typedef {object} ScoringTable
 * @property {Record<'1' | '2' | '3' | '4' | '5', number>} deductionByDanger Score deduction per danger level.
 * @property {number} rearmS Seconds clear before a rule can open a new episode.
 * @property {number} crashCauseWindowS Look-back window for a crash cause.
 * @property {number} accidentRelSpeed Closing speed (m/s) from which an NPC car contact is an accident,
 *   and a static or kerb hit is heavy (`design`). Closing speed, unlike impulse, does not scale with
 *   the player's mass, so one value fits both vehicles.
 * @property {number} contactMinEgoSpeed Below this ego speed (m/s) a contact is never a breach.
 */

/**
 * Collision clause choice. The accident clause is `accidentB` when the cause's resolved clause is
 * in `accidentBList`, else `accidentA`.
 * @typedef {object} CollisionPolicy
 * @property {{D6: string, D7: string}} accidentA Accident clauses 6.10.a / 7.10.a.
 * @property {{D6: string, D7: string}} accidentB Accident clauses 6.10.b / 7.10.b.
 * @property {{D6: string[], D7: string[]}} accidentBList Clauses named in 10.b, copied from the text.
 * @property {string[]} inferredAccidentCauses Causes in neither list (accidentA is then `inferred`).
 *   Each entry is a clause id or a rule id; a rule id is needed when one clause covers several acts
 *   of which only some are named in 10.a (D7.7.a: pavement riding is inferred, wrong-way riding is not).
 * @property {{D6: string, D7: string}} sameLaneAhead Va chạm with the vehicle ahead: 6.4.l / 7.3.i.
 * @property {'scoreOnly'} staticAndFall Static objects, kerbs and falls never carry a penalty.
 * @property {FaultRow[]} [faultRows] Fault table for ego contacts with vehicles, first match wins;
 *   absent, every contact is charged as before.
 * @property {string[]} [nonContributingRules] Rule ids whose episodes never contribute to a contact.
 * @property {string[]} [rearEndContributingRules] Rule ids whose open episode makes being hit from
 *   behind the player's fault (a cut-in or an unsignalled turn).
 * @property {import('./telemetry.js').NpcViolation[]} [excusingViolations] Other-party violations
 *   that excuse a striking ego (right-of-way violations).
 * @property {number} [aftermathWindowS] Seconds after a notice contact during which every further
 *   contact and a fall are notices too.
 * @property {number} [excuseMaxSpeedGainMps] An excusing violation excuses the player only if the
 *   player's speed at the contact (the event's `egoSpeed`) is no more than this (m/s) above its
 *   speed when the violation first showed on that party; absent, no speed check.
 * @property {import('./telemetry.js').NpcViolation[]} [rightOfWayViolations] Excusing violations
 *   that keep excusing a player who gained speed when the other party was moving at the contact
 *   (not a wreck, at or above `contactMinEgoSpeed`) and not ahead in the player's lane (it was
 *   crossing the player's right of way); each must be in `excusingViolations`.
 * @property {Record<string, import('./vehicle.js').LocalText>} [noticeTexts] Notice templates keyed
 *   by the other party's first violation, or by `from-behind` and `none` when it has none, and by
 *   `aftermath` for a contact inside the aftermath window; `ego-slow` for a vehicle contact the ego
 *   struck (or a fall) and `pedestrian-slow` for a pedestrian contact that are notices only
 *   because the ego was below `contactMinEgoSpeed`; a below-gate contact the other vehicle struck
 *   keeps its violation, `from-behind` or `none` text. `{vehicle}` in a template is replaced with the Vietnamese word for the
 *   other vehicle (capitalised at the start of the text).
 * @property {Partial<Record<'nonContributingRules' | 'rearEndContributingRules' | 'excusingViolations' |
 *   'aftermathWindowS' | 'excuseMaxSpeedGainMps' | 'rightOfWayViolations', 'legal' | 'design'>>} [paramBasis] Basis of each
 *   fault-table choice; required for every one of them the policy sets.
 */

/**
 * Condition of a fault row, evaluated per contact from the frame and the scorer state:
 * - `aftermath`: within `aftermathWindowS` of a notice contact, other party not a pedestrian;
 * - `from-behind`: `otherFromBehind` and the striker is not the ego;
 * - `contributing-episode`: an episode of a contributing rule is open within `crashCauseWindowS`;
 * - `same-lane-ahead`: `sameLaneAhead`, the striker is the ego or both, and the other party has no
 *   excusing violation (one the player sped up into does not count);
 * - `ego-strikes`: the striker is the ego and the other party has no excusing violation (one the
 *   player sped up into does not count, except a `rightOfWayViolations` one of a party moving at
 *   the contact);
 * - `otherwise`: always matches.
 * @typedef {'aftermath' | 'from-behind' | 'contributing-episode' | 'same-lane-ahead' | 'ego-strikes'
 *   | 'otherwise'} FaultCondition
 */

/**
 * @typedef {object} FaultRow
 * @property {string} id Row id, for tests and notes.
 * @property {FaultCondition} when Condition.
 * @property {'notice' | 'deduction'} result Outcome when the condition holds.
 * @property {boolean} [unlessRearEndContributing] A notice row becomes a deduction when a
 *   `rearEndContributingRules` episode is open in the window (that episode is the cause).
 */

/**
 * @typedef {object} RulesBundle
 * @property {Rule[]} rules Rules.
 * @property {Clause[]} clauses Clause table.
 * @property {Source[]} sources Legal sources.
 * @property {SpeedDefault[]} speedDefaults Default limits.
 * @property {SignMeaning[]} signs Sign meanings.
 * @property {ScoringTable} scoring Score parameters.
 * @property {CollisionPolicy} collisionPolicy Collision clause choice.
 */

/** Licence points a clause may carry (ND 168 Điều 6 khoản 16, Điều 7 khoản 13). */
export const LICENCE_POINT_VALUES = Object.freeze([0, 2, 4, 6, 10]);

/** Pattern of a clause id: `D6.3.a`, `D6.5.đ`, `D7.10.b`, or a whole khoản such as `D6.12`. */
export const CLAUSE_ID_PATTERN = /^D[67]\.\d+[a-z]?(\.[a-zđ]+)?$/u;
