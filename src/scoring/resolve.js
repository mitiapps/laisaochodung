/**
 * Turns a detected tier into a fully resolved `Breach` (clause record, source, flags), and picks
 * the collision clause through the collision policy.
 */

/** @typedef {import('../contracts/index.js').Rule} Rule */
/** @typedef {import('../contracts/index.js').Breach} Breach */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').Clause} Clause */
/** @typedef {import('../contracts/index.js').LocalText} LocalText */
/** @typedef {import('./context.js').ScorerEnv} ScorerEnv */
/** @typedef {import('./detectors/collision.js').CollisionOutcome} CollisionOutcome */

/** Texts of collisions that carry no penalty of their own. */
const CRASH_NOTES = Object.freeze({
  carWithCause: 'Va chạm nhẹ với xe khác; mức phạt là của lỗi đã gây ra va chạm, không tính thêm.',
  carNoCause: 'Va chạm nhẹ với xe khác; không có lỗi luật nào được ghi nhận, chỉ trừ điểm trò chơi.',
  static: 'Va chạm với vật cản hoặc lề đường; luật không có mức phạt riêng, chỉ trừ điểm trò chơi.',
  fall: 'Ngã xe; luật không có mức phạt riêng, chỉ trừ điểm trò chơi.',
});

/**
 * Names of the rule's detection parameters with `design` basis.
 * @param {Rule} rule Rule.
 * @returns {string[]} Parameter names, in data order.
 */
export function designParamsOf(rule) {
  return Object.entries(rule.detection.paramBasis)
    .filter(([, basis]) => basis === 'design')
    .map(([name]) => name);
}

/**
 * @typedef {object} BreachMeta
 * @property {string} episodeId Episode id.
 * @property {'new' | 'escalated'} kind New episode or escalation.
 */

/**
 * @param {ScorerEnv} env Static inputs.
 * @param {string | null | undefined} clauseId Clause id.
 * @returns {Pick<Breach, 'clause' | 'source' | 'amendmentSources'>} Clause, its source and the
 *   sources of its amendments.
 */
function clauseAndSource(env, clauseId) {
  const clause = clauseId ? (env.clausesById.get(clauseId) ?? null) : null;
  if (clauseId && !clause) throw new Error(`Unknown clause "${clauseId}" (the rules bundle was not validated)`);
  const src = clause ? env.sourcesById.get(clause.citation.sourceId) : undefined;
  /** @type {Breach['amendmentSources']} */
  const amendmentSources = [];
  for (const a of clause?.amendments ?? []) {
    if (amendmentSources.some((s) => s.sourceId === a.sourceId)) continue;
    const as = env.sourcesById.get(a.sourceId);
    if (!as) throw new Error(`Unknown source "${a.sourceId}" in clause "${clauseId}" (the rules bundle was not validated)`);
    amendmentSources.push({ sourceId: as.id, number: as.number, title: as.title, url: as.url });
  }
  return { clause, source: src ? { number: src.number, title: src.title, url: src.url } : null, amendmentSources };
}

/**
 * Common breach fields.
 * @param {ScorerEnv} env Static inputs.
 * @param {Rule} rule Rule.
 * @param {number} tierIndex Tier.
 * @param {Frame} frame Frame.
 * @param {BreachMeta} meta Episode data.
 * @returns {Omit<Breach, 'clause' | 'source' | 'amendmentSources' | 'inferred' | 'designParams' | 'scoreOnly'>} Fields.
 */
function baseBreach(env, rule, tierIndex, frame, meta) {
  const tier = rule.tiers[tierIndex];
  return {
    ruleId: rule.id,
    title: rule.title,
    tierIndex,
    tick: frame.tick,
    t: frame.t,
    pos: { x: frame.ego.pos.x, z: frame.ego.pos.z },
    danger: tier.danger,
    deduction: env.bundle.scoring.deductionByDanger[String(tier.danger)],
    episodeId: meta.episodeId,
    kind: meta.kind,
  };
}

/**
 * Breach of an ordinary tier.
 * @param {ScorerEnv} env Static inputs.
 * @param {Rule} rule Rule.
 * @param {number} tierIndex Tier.
 * @param {Frame} frame Frame.
 * @param {BreachMeta} meta Episode data.
 * @param {boolean} [basisVerified] False when the detection used unverified legal data.
 * @returns {Breach} Breach.
 */
export function resolveBreach(env, rule, tierIndex, frame, meta, basisVerified = true) {
  const tier = rule.tiers[tierIndex];
  const { clause, source, amendmentSources } = clauseAndSource(env, tier.scoreOnly ? null : tier.clause?.[env.group]);
  /** @type {Breach} */
  const breach = {
    ...baseBreach(env, rule, tierIndex, frame, meta),
    clause,
    source,
    amendmentSources,
    inferred: tier.inferred === true,
    designParams: designParamsOf(rule),
    scoreOnly: clause === null,
    basisVerified,
  };
  if (tier.note) breach.note = tier.note;
  return breach;
}

/**
 * The cause of a collision, as recorded for it.
 * @typedef {object} CrashCause
 * @property {string} ruleId Cause rule.
 * @property {LocalText} title Its title.
 * @property {string | null} clauseId Its resolved clause, null when score only.
 * @property {string} episodeId Its episode.
 */

/**
 * Breach of the crash rule, with the clause chosen by the collision policy.
 * @param {ScorerEnv} env Static inputs.
 * @param {Rule} rule The crash rule.
 * @param {number} tierIndex Tier chosen from the outcome (light or heavy).
 * @param {CollisionOutcome} outcome Classified collision.
 * @param {CrashCause | null} cause Cause, if any.
 * @param {Frame} frame Frame.
 * @param {BreachMeta} meta Episode data.
 * @returns {Breach} Breach.
 */
export function resolveCrash(env, rule, tierIndex, outcome, cause, frame, meta) {
  const policy = env.bundle.collisionPolicy;
  const g = env.group;
  /** @type {string | null} */
  let clauseId = null;
  let inferred = false;
  /** @type {string | null} */
  let note = null;
  /** @type {string[]} */
  const designParams = outcome.kind === 'pedestrian' || outcome.kind === 'fall' ? [] : ['accidentRelSpeed'];
  switch (outcome.kind) {
    case 'pedestrian':
    case 'car-accident': {
      const causeClause = cause?.clauseId ?? null;
      const inB = causeClause !== null && policy.accidentBList[g].includes(causeClause);
      clauseId = inB ? policy.accidentB[g] : policy.accidentA[g];
      inferred =
        !inB &&
        cause !== null &&
        (policy.inferredAccidentCauses.includes(cause.ruleId) ||
          (causeClause !== null && policy.inferredAccidentCauses.includes(causeClause)));
      break;
    }
    case 'same-lane-ahead':
      clauseId = policy.sameLaneAhead[g];
      break;
    case 'car-contact':
      note = cause ? CRASH_NOTES.carWithCause : CRASH_NOTES.carNoCause;
      break;
    case 'static':
      note = CRASH_NOTES.static;
      break;
    default:
      note = CRASH_NOTES.fall;
  }
  const { clause, source, amendmentSources } = clauseAndSource(env, clauseId);
  /** @type {Breach} */
  const breach = {
    ...baseBreach(env, rule, tierIndex, frame, meta),
    clause,
    source,
    amendmentSources,
    inferred,
    designParams,
    scoreOnly: clause === null,
    basisVerified: true,
  };
  if (note) breach.note = { vi: note };
  if (cause) {
    breach.cause = cause.ruleId;
    breach.causeEpisodeId = cause.episodeId;
  }
  return breach;
}
