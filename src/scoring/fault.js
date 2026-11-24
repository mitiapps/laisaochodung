/**
 * Fault by law for ego contacts: each collision or fall event of a step is either charged (a
 * crash breach through the collision policy's clause choice) or a `Notice` with no deduction.
 *
 * Vehicle contacts (cars and motorbikes) run through the policy's `faultRows`, first match wins.
 * Pedestrian contacts never enter the table: they are always charged (D7 keeps the run end).
 * Static objects, kerbs and falls can match only an `aftermath` row; otherwise they are charged as
 * before. Without `faultRows` every contact is charged, as before the table existed.
 *
 * The decision is pure: the scorer gathers the facts from its episodes and passes them in.
 */

/** @typedef {import('../contracts/index.js').CollisionEvent} CollisionEvent */
/** @typedef {import('../contracts/index.js').FallEvent} FallEvent */
/** @typedef {import('../contracts/index.js').CollisionPolicy} CollisionPolicy */
/** @typedef {import('../contracts/index.js').NpcViolation} NpcViolation */
/** @typedef {import('../contracts/index.js').LocalText} LocalText */
/** @typedef {import('./resolve.js').CrashCause} CrashCause */

/**
 * The optional traffic fields of a collision event, with the defaults that make frames recorded
 * before traffic existed score exactly as before.
 * @typedef {object} ContactFields
 * @property {'ego' | 'other' | 'both'} striker Who struck.
 * @property {boolean} otherFromBehind The other party came from behind.
 * @property {readonly NpcViolation[]} otherViolations The other party's latched violations.
 * @property {string | null} otherModel Model key of the other actor.
 */

/**
 * Facts about the scorer state at the contact.
 * @typedef {object} FaultFacts
 * @property {boolean} aftermath Inside the aftermath window of an earlier notice contact.
 * @property {CrashCause | null} cause Worst contributing ego episode active within the cause
 *   window, or null.
 * @property {CrashCause | null} anyCause Worst episode of any rule active within the cause window:
 *   the cause of a contact that is charged outside the table (a pedestrian, a static object, a
 *   fall, or any contact when the policy has no `faultRows`), exactly as before the table existed.
 * @property {CrashCause | null} rearEndCause Worst episode of a `rearEndContributingRules` rule
 *   active within the cause window, or null.
 */

/**
 * @typedef {object} FaultDecision
 * @property {string | null} rowId Matching fault row, null when the contact never enters the table
 *   (a pedestrian, or no `faultRows` in the policy, or a static contact no row matched).
 * @property {'notice' | 'deduction'} result Outcome.
 * @property {CrashCause | null} cause Cause recorded on the crash breach of a deduction.
 */

/** Kinds of the other party that run through the whole table. */
const VEHICLE_KINDS = Object.freeze(['car', 'motorbike']);

/**
 * Vietnamese word for the other vehicle, by model key, then by kind. Game UI text, like the crash
 * notes in `resolve.js`.
 */
const VEHICLE_WORDS = Object.freeze({
  motorbike: 'xe máy',
  car: 'ô tô',
  taxi: 'xe taxi',
  bus: 'xe buýt',
  truck: 'xe tải',
});

/** Fallback word when neither model nor kind names a known vehicle. */
const OTHER_VEHICLE = 'xe khác';

/** Short phrase of each violation, for the two-sided note of a charged contact. */
const VIOLATION_PHRASES = Object.freeze({
  'red-light': 'vượt đèn đỏ',
  speeding: 'chạy quá tốc độ',
  'wrong-way': 'đi ngược chiều',
  'unsafe-lane-change': 'chuyển làn không an toàn',
  'no-yield': 'không nhường đường',
  tailgating: 'không giữ khoảng cách an toàn',
});

/**
 * Traffic fields of a collision event, defaulted for older frames.
 * @param {CollisionEvent} e Event.
 * @returns {ContactFields} Fields.
 */
export function contactFields(e) {
  return {
    striker: e.striker ?? 'ego',
    otherFromBehind: e.otherFromBehind ?? false,
    otherViolations: e.otherViolations ?? [],
    otherModel: e.otherModel ?? null,
  };
}

/**
 * Whether a fault row's condition holds for a contact.
 * @param {import('../contracts/index.js').FaultRow} row Row.
 * @param {CollisionEvent | FallEvent} e Event.
 * @param {FaultFacts} facts Facts.
 * @param {readonly string[]} excusing Excusing violations.
 * @returns {boolean} The row matches.
 */
function rowMatches(row, e, facts, excusing) {
  if (row.when === 'aftermath') return facts.aftermath;
  // Only vehicle contacts reach the other conditions (the caller filters the rest).
  const c = contactFields(/** @type {CollisionEvent} */ (e));
  const excused = c.otherViolations.some((v) => excusing.includes(v));
  switch (row.when) {
    case 'from-behind':
      return c.otherFromBehind && c.striker !== 'ego';
    case 'contributing-episode':
      return facts.cause !== null;
    case 'same-lane-ahead':
      return /** @type {CollisionEvent} */ (e).sameLaneAhead && c.striker !== 'other' && !excused;
    case 'ego-strikes':
      return c.striker === 'ego' && !excused;
    default:
      return true;
  }
}

/**
 * Decides one contact.
 * @param {CollisionPolicy} policy Collision policy.
 * @param {CollisionEvent | FallEvent} e Collision or fall event.
 * @param {FaultFacts} facts Facts at the contact.
 * @returns {FaultDecision} Decision.
 */
export function decideFault(policy, e, facts) {
  const rows = policy.faultRows;
  const charged = /** @type {FaultDecision} */ ({ rowId: null, result: 'deduction', cause: facts.anyCause });
  if (!rows) return charged;
  const vehicle = e.type === 'collision' && VEHICLE_KINDS.includes(e.otherKind);
  if (e.type === 'collision' && e.otherKind === 'pedestrian') return charged;
  const excusing = policy.excusingViolations ?? [];
  for (const row of rows) {
    if (!vehicle && row.when !== 'aftermath') continue;
    if (!rowMatches(row, e, facts, excusing)) continue;
    if (row.result === 'deduction') return { rowId: row.id, result: 'deduction', cause: facts.cause };
    if (row.unlessRearEndContributing && facts.rearEndCause !== null) {
      return { rowId: row.id, result: 'deduction', cause: facts.rearEndCause };
    }
    return { rowId: row.id, result: 'notice', cause: null };
  }
  return charged;
}

/**
 * Vietnamese word for the other vehicle.
 * @param {CollisionEvent['otherKind'] | null} kind Other kind.
 * @param {string | null} model Model key.
 * @returns {string} Word, lower case.
 */
export function vehicleWord(kind, model) {
  /** @type {Readonly<Record<string, string>>} */
  const words = VEHICLE_WORDS;
  return (model !== null ? words[model] : undefined) ?? (kind !== null ? words[kind] : undefined) ?? OTHER_VEHICLE;
}

/**
 * Upper-cases the first character.
 * @param {string} s Text.
 * @returns {string} Text.
 */
function capitalise(s) {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Notice text of a contact: the template of the other party's first violation, else
 * `from-behind`, else `none`; `aftermath` inside the aftermath window.
 * @param {CollisionPolicy} policy Collision policy.
 * @param {CollisionEvent | FallEvent} e Event.
 * @param {boolean} aftermath The notice comes from the aftermath row.
 * @returns {LocalText} Text.
 * @throws {Error} When the policy lacks the needed template (the bundle was not validated).
 */
export function noticeText(policy, e, aftermath) {
  const texts = policy.noticeTexts ?? {};
  /** @type {string} */
  let key = 'none';
  let kind = /** @type {CollisionEvent['otherKind'] | null} */ (null);
  let model = /** @type {string | null} */ (null);
  if (e.type === 'collision') {
    const c = contactFields(e);
    kind = e.otherKind;
    model = c.otherModel;
    const first = c.otherViolations.find((v) => texts[v] !== undefined);
    if (first !== undefined) key = first;
    else if (c.otherFromBehind) key = 'from-behind';
  }
  if (aftermath) key = 'aftermath';
  const template = texts[key];
  if (!template) throw new Error(`Collision policy has no notice text "${key}" (the rules bundle was not validated)`);
  const word = vehicleWord(kind, model);
  const vi = template.vi.replace(/^\{vehicle\}/u, capitalise(word)).replaceAll('{vehicle}', word);
  return { vi };
}

/**
 * Two-sided note of a charged vehicle contact whose other party also broke a rule ("Bạn chạy quá
 * tốc độ quy định; xe kia vượt đèn đỏ."), or null when the note would have one side only.
 * @param {CrashCause | null} cause Player cause.
 * @param {readonly NpcViolation[]} violations Other party's violations.
 * @returns {string | null} Note.
 */
export function bothSidesNote(cause, violations) {
  if (!cause || violations.length === 0) return null;
  const phrases = [...new Set(violations.map((v) => VIOLATION_PHRASES[v]).filter((x) => x !== undefined))];
  if (phrases.length === 0) return null;
  const title = cause.title.vi;
  const mine = title.charAt(0).toLowerCase() + title.slice(1);
  return `Bạn ${mine}; xe kia ${phrases.join(', ')}.`;
}
