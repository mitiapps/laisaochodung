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
 * @property {number} accidentImpulse Impulse (N·s) from which a car contact is an accident (`design`).
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
