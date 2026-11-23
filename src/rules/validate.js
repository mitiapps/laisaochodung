/**
 * Pure validation of a `RulesBundle`: legal provenance (every citation has a known source, a quote
 * and a URL), clause references (every rule tier resolves to a clause for every decree group it
 * covers, or is score only, or takes its clause from the collision policy) and value domains.
 * The rules build runs it and fails on any problem; tests run it on broken copies.
 */

import { CLAUSE_ID_PATTERN, LICENCE_POINT_VALUES } from '../contracts/rule.js';
import { decreeGroupOf } from '../contracts/vehicle.js';
import { DETECTOR_TYPES } from '../scoring/detectors/index.js';

/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */
/** @typedef {import('../contracts/index.js').DecreeGroup} DecreeGroup */

const RULE_CLASSES = Object.freeze(['car', 'motorbike']);
const DECREE_GROUPS = Object.freeze(['D6', 'D7']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASES = Object.freeze(['legal', 'design']);

/**
 * @param {unknown} v Value.
 * @returns {v is Record<string, unknown>} Plain object.
 */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} v Value.
 * @returns {v is string} Non-empty string.
 */
function isStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Collects problems as `path: message` strings.
 */
class Problems {
  constructor() {
    /** @type {string[]} */
    this.list = [];
  }

  /**
   * @param {string} path Field path.
   * @param {string} message Problem.
   */
  add(path, message) {
    this.list.push(`${path}: ${message}`);
  }
}

/**
 * @param {Problems} p Problems.
 * @param {unknown} t Text.
 * @param {string} path Path.
 */
function checkText(p, t, path) {
  if (!isObj(t) || !isStr(t.vi)) p.add(path, 'expected {vi, en?} with a non-empty vi');
  else {
    if (t.en !== undefined && typeof t.en !== 'string') p.add(`${path}.en`, 'expected a string');
    // An unquoted YAML flow mapping splits text at commas into stray keys.
    for (const k of Object.keys(t)) if (k !== 'vi' && k !== 'en') p.add(path, `unexpected key "${k}" (quote the text)`);
  }
}

/**
 * @param {Problems} p Problems.
 * @param {unknown} r Range.
 * @param {string} path Path.
 * @param {boolean} nullable Null allowed.
 */
function checkRange(p, r, path, nullable) {
  if (r === null && nullable) return;
  if (!isObj(r) || !Number.isFinite(r.min) || !Number.isFinite(r.max)) {
    p.add(path, nullable ? 'expected null or {min, max}' : 'expected {min, max}');
    return;
  }
  if (/** @type {number} */ (r.min) < 0) p.add(path, 'min below 0');
  if (/** @type {number} */ (r.min) > /** @type {number} */ (r.max)) p.add(path, 'min above max');
}

/**
 * @param {Problems} p Problems.
 * @param {unknown} c Citation.
 * @param {string} path Path.
 * @param {Set<string>} sourceIds Known sources.
 */
function checkCitation(p, c, path, sourceIds) {
  if (!isObj(c)) {
    p.add(path, 'missing citation');
    return;
  }
  if (!isStr(c.sourceId)) p.add(`${path}.sourceId`, 'missing');
  else if (!sourceIds.has(c.sourceId)) p.add(`${path}.sourceId`, `unknown source "${c.sourceId}"`);
  if (!isStr(c.article)) p.add(`${path}.article`, 'missing');
  if (!isStr(c.quote)) p.add(`${path}.quote`, 'missing or empty quote');
  if (!isStr(c.url) || !/^https:\/\//.test(c.url)) p.add(`${path}.url`, 'expected an https URL');
  for (const k of ['clause', 'point']) {
    if (c[k] !== undefined && !isStr(c[k])) p.add(`${path}.${k}`, 'expected a non-empty string');
  }
}

/**
 * @param {Problems} p Problems.
 * @param {unknown} list Array to check.
 * @param {string} path Path.
 * @param {(item: Record<string, unknown>) => unknown} key Id of an item.
 * @returns {Record<string, unknown>[]} The object items.
 */
function uniqueItems(p, list, path, key) {
  if (!Array.isArray(list)) {
    p.add(path, 'expected an array');
    return [];
  }
  const seen = new Set();
  /** @type {Record<string, unknown>[]} */
  const out = [];
  list.forEach((item, i) => {
    if (!isObj(item)) {
      p.add(`${path}[${i}]`, 'expected an object');
      return;
    }
    const id = key(item);
    if (seen.has(id)) p.add(`${path}[${i}]`, `duplicate id "${String(id)}"`);
    seen.add(id);
    out.push(item);
  });
  return out;
}

/**
 * The clause id a citation of ND 168 points at, e.g. `Điều 6`, `3`, `a` → `D6.3.a`.
 * @param {Record<string, unknown>} c Citation.
 * @returns {string} Clause id.
 */
function citedClauseId(c) {
  const article = String(c.article ?? '').replace(/^Điều\s+/u, '');
  return c.point ? `D${article}.${String(c.clause)}.${String(c.point)}` : `D${article}.${String(c.clause)}`;
}

/**
 * Decree groups a tier must name a clause for.
 * @param {('car' | 'motorbike')[]} classes Rule classes.
 * @param {Record<string, unknown> | undefined} when Tier condition.
 * @returns {DecreeGroup[]} Groups.
 */
export function requiredGroups(classes, when) {
  const groups = [...new Set(classes.map((c) => decreeGroupOf(c)))];
  const only = when?.decreeGroups;
  return Array.isArray(only) ? groups.filter((g) => only.includes(g)) : groups;
}

/**
 * Validates a rules bundle.
 * @param {RulesBundle} bundle Bundle as loaded from the data files.
 * @returns {string[]} Problems, empty when the bundle is valid.
 */
export function validateRules(bundle) {
  const p = new Problems();
  if (!isObj(bundle)) return ['bundle: expected an object'];
  /** @type {Record<string, unknown>} */
  const b = bundle;

  const sources = uniqueItems(p, b.sources, 'sources', (s) => s.id);
  const sourceIds = new Set(sources.map((s) => String(s.id)));
  sources.forEach((s, i) => {
    const path = `sources[${i}]`;
    for (const k of ['id', 'title', 'number', 'edition', 'url']) if (!isStr(s[k])) p.add(`${path}.${k}`, 'missing');
    if (isStr(s.url) && !/^https:\/\//.test(s.url)) p.add(`${path}.url`, 'expected an https URL');
    for (const k of ['issued', 'effectiveFrom']) {
      if (s[k] !== null && !(typeof s[k] === 'string' && DATE.test(s[k]))) p.add(`${path}.${k}`, 'expected YYYY-MM-DD or null');
    }
    if (typeof s.official !== 'boolean') p.add(`${path}.official`, 'expected a boolean');
    if (s.amendedBy !== undefined) {
      if (!Array.isArray(s.amendedBy)) p.add(`${path}.amendedBy`, 'expected an array');
      else for (const a of s.amendedBy) if (!sourceIds.has(String(a))) p.add(`${path}.amendedBy`, `unknown source "${String(a)}"`);
    }
  });

  const clauses = uniqueItems(p, b.clauses, 'clauses', (c) => c.id);
  const clauseIds = new Set(clauses.map((c) => String(c.id)));
  clauses.forEach((c, i) => {
    const path = `clauses[${i}]`;
    if (!isStr(c.id) || !CLAUSE_ID_PATTERN.test(c.id)) p.add(`${path}.id`, 'expected a D6.3.a-style id');
    checkRange(p, c.fineVnd, `${path}.fineVnd`, true);
    if (!LICENCE_POINT_VALUES.includes(/** @type {never} */ (c.licencePoints))) {
      p.add(`${path}.licencePoints`, `expected one of ${LICENCE_POINT_VALUES.join(', ')}`);
    }
    checkRange(p, c.suspensionMonths, `${path}.suspensionMonths`, true);
    checkCitation(p, c.citation, `${path}.citation`, sourceIds);
    if (isObj(c.citation) && isStr(c.id) && citedClauseId(c.citation) !== c.id) {
      p.add(`${path}.citation`, `cites ${citedClauseId(c.citation)}, not ${c.id}`);
    }
    if (c.amendments !== undefined) {
      if (!Array.isArray(c.amendments)) p.add(`${path}.amendments`, 'expected an array');
      else c.amendments.forEach((a, k) => checkCitation(p, a, `${path}.amendments[${k}]`, sourceIds));
    }
    if (!(typeof c.effectiveFrom === 'string' && DATE.test(c.effectiveFrom))) p.add(`${path}.effectiveFrom`, 'expected YYYY-MM-DD');
    if (typeof c.verified !== 'boolean') p.add(`${path}.verified`, 'expected a boolean');
    if (!(typeof c.checkedOn === 'string' && DATE.test(c.checkedOn))) p.add(`${path}.checkedOn`, 'expected YYYY-MM-DD');
  });

  uniqueItems(p, b.signs, 'signs', (s) => s.code).forEach((s, i) => {
    if (!isStr(s.code)) p.add(`signs[${i}].code`, 'missing');
    checkText(p, s.name, `signs[${i}].name`);
    checkCitation(p, s.citation, `signs[${i}].citation`, sourceIds);
    if (typeof s.verified !== 'boolean') p.add(`signs[${i}].verified`, 'expected a boolean');
    if (!(s.figureChecked === null || (typeof s.figureChecked === 'string' && DATE.test(s.figureChecked)))) {
      p.add(`signs[${i}].figureChecked`, 'expected YYYY-MM-DD or null');
    }
  });

  uniqueItems(p, b.speedDefaults, 'speedDefaults', (s) => `${String(s.legalClass)}/${String(s.builtUp)}/${String(s.multiLane)}`).forEach(
    (s, i) => {
      const path = `speedDefaults[${i}]`;
      if (!['car', 'motorbike', 'moped'].includes(String(s.legalClass))) p.add(`${path}.legalClass`, 'unknown class');
      if (typeof s.builtUp !== 'boolean') p.add(`${path}.builtUp`, 'expected a boolean');
      if (typeof s.multiLane !== 'boolean') p.add(`${path}.multiLane`, 'expected a boolean');
      if (!(Number.isFinite(s.maxKmh) && /** @type {number} */ (s.maxKmh) > 0)) p.add(`${path}.maxKmh`, 'expected a positive number');
      checkCitation(p, s.citation, `${path}.citation`, sourceIds);
      if (typeof s.verified !== 'boolean') p.add(`${path}.verified`, 'expected a boolean');
    },
  );

  const scoring = b.scoring;
  if (!isObj(scoring)) p.add('scoring', 'expected an object');
  else {
    const d = scoring.deductionByDanger;
    for (const k of ['1', '2', '3', '4', '5']) {
      if (!isObj(d) || !(Number.isFinite(d[k]) && /** @type {number} */ (d[k]) >= 0)) p.add(`scoring.deductionByDanger.${k}`, 'expected a number ≥ 0');
    }
    for (const k of ['rearmS', 'crashCauseWindowS', 'accidentRelSpeed', 'contactMinEgoSpeed']) {
      if (!(Number.isFinite(scoring[k]) && /** @type {number} */ (scoring[k]) >= 0)) p.add(`scoring.${k}`, 'expected a number ≥ 0');
    }
  }

  const rules = uniqueItems(p, b.rules, 'rules', (r) => r.id);
  const ruleIds = new Set(rules.map((r) => String(r.id)));

  const policy = b.collisionPolicy;
  if (!isObj(policy)) p.add('collisionPolicy', 'expected an object');
  else {
    for (const k of ['accidentA', 'accidentB', 'sameLaneAhead']) {
      const pair = policy[k];
      for (const g of DECREE_GROUPS) {
        const id = isObj(pair) ? pair[g] : undefined;
        if (!clauseIds.has(String(id))) p.add(`collisionPolicy.${k}.${g}`, `unknown clause "${String(id)}"`);
        else if (!String(id).startsWith(`${g}.`)) p.add(`collisionPolicy.${k}.${g}`, `clause ${String(id)} is not in ${g}`);
      }
    }
    const lists = policy.accidentBList;
    for (const g of DECREE_GROUPS) {
      const list = isObj(lists) ? lists[g] : undefined;
      if (!Array.isArray(list)) p.add(`collisionPolicy.accidentBList.${g}`, 'expected an array');
      else {
        for (const id of list) {
          if (!(typeof id === 'string' && CLAUSE_ID_PATTERN.test(id) && id.startsWith(`${g}.`))) {
            p.add(`collisionPolicy.accidentBList.${g}`, `"${String(id)}" is not a ${g} clause id`);
          }
        }
      }
    }
    if (!Array.isArray(policy.inferredAccidentCauses)) p.add('collisionPolicy.inferredAccidentCauses', 'expected an array');
    else {
      for (const c of policy.inferredAccidentCauses) {
        if (!clauseIds.has(String(c)) && !ruleIds.has(String(c))) {
          p.add('collisionPolicy.inferredAccidentCauses', `"${String(c)}" is neither a clause nor a rule`);
        }
      }
    }
    if (policy.staticAndFall !== 'scoreOnly') p.add('collisionPolicy.staticAndFall', "expected 'scoreOnly'");
  }

  rules.forEach((r, i) => checkRule(p, r, `rules[${i}]`, { sourceIds, clauseIds, ruleIds }));
  return p.list;
}

/**
 * @param {Problems} p Problems.
 * @param {Record<string, unknown>} r Rule.
 * @param {string} path Path.
 * @param {{sourceIds: Set<string>, clauseIds: Set<string>, ruleIds: Set<string>}} known Known ids.
 */
function checkRule(p, r, path, known) {
  if (!isStr(r.id)) p.add(`${path}.id`, 'missing');
  checkText(p, r.title, `${path}.title`);
  checkText(p, r.description, `${path}.description`);
  /** @type {('car' | 'motorbike')[]} */
  let classes = [];
  if (!Array.isArray(r.vehicleClasses) || r.vehicleClasses.length === 0) p.add(`${path}.vehicleClasses`, 'expected a non-empty array');
  else {
    for (const c of r.vehicleClasses) if (!RULE_CLASSES.includes(c)) p.add(`${path}.vehicleClasses`, `unknown class "${String(c)}"`);
    classes = /** @type {('car' | 'motorbike')[]} */ (r.vehicleClasses.filter((c) => RULE_CLASSES.includes(c)));
  }

  const det = r.detection;
  let isCollision = false;
  if (!isObj(det)) p.add(`${path}.detection`, 'expected an object');
  else {
    if (!DETECTOR_TYPES.includes(/** @type {never} */ (det.type))) p.add(`${path}.detection.type`, `unknown detector "${String(det.type)}"`);
    isCollision = det.type === 'collision';
    const params = isObj(det.params) ? det.params : null;
    const basis = isObj(det.paramBasis) ? det.paramBasis : null;
    if (!params) p.add(`${path}.detection.params`, 'expected an object');
    if (!basis) p.add(`${path}.detection.paramBasis`, 'expected an object');
    if (params && basis) {
      for (const [k, v] of Object.entries(basis)) {
        if (!(k in params)) p.add(`${path}.detection.paramBasis.${k}`, 'not a detection parameter');
        if (!BASES.includes(/** @type {never} */ (v))) p.add(`${path}.detection.paramBasis.${k}`, "expected 'legal' or 'design'");
      }
      for (const k of Object.keys(params)) if (!(k in basis)) p.add(`${path}.detection.params.${k}`, 'has no paramBasis');
    }
  }

  if (!Array.isArray(r.obligation) || r.obligation.length === 0) p.add(`${path}.obligation`, 'expected at least one citation');
  else r.obligation.forEach((c, k) => checkCitation(p, c, `${path}.obligation[${k}]`, known.sourceIds));

  if (r.supersedes !== undefined) {
    if (!Array.isArray(r.supersedes)) p.add(`${path}.supersedes`, 'expected an array');
    else {
      r.supersedes.forEach((s, k) => {
        const sp = `${path}.supersedes[${k}]`;
        if (!isObj(s) || !known.ruleIds.has(String(s.ruleId))) p.add(sp, `unknown rule "${isObj(s) ? String(s.ruleId) : ''}"`);
        else if (s.ruleId === r.id) p.add(sp, 'a rule cannot supersede itself');
        if (isObj(s) && s.decreeGroups !== undefined) {
          if (!Array.isArray(s.decreeGroups) || s.decreeGroups.some((g) => !DECREE_GROUPS.includes(g))) p.add(`${sp}.decreeGroups`, 'expected D6 and/or D7');
        }
      });
    }
  }

  if (!Array.isArray(r.tiers) || r.tiers.length === 0) {
    p.add(`${path}.tiers`, 'expected at least one tier');
    return;
  }
  r.tiers.forEach((t, k) => {
    const tp = `${path}.tiers[${k}]`;
    if (!isObj(t)) {
      p.add(tp, 'expected an object');
      return;
    }
    if (![1, 2, 3, 4, 5].includes(/** @type {number} */ (t.danger))) p.add(`${tp}.danger`, 'expected 1 to 5');
    if (typeof t.scoreOnly !== 'boolean') p.add(`${tp}.scoreOnly`, 'expected a boolean');
    if (t.when !== undefined && !isObj(t.when)) p.add(`${tp}.when`, 'expected an object');
    if (t.inferred !== undefined && typeof t.inferred !== 'boolean') p.add(`${tp}.inferred`, 'expected a boolean');
    if (t.note !== undefined) checkText(p, t.note, `${tp}.note`);
    const shapes = [t.scoreOnly === true, t.clauseFromPolicy === true, t.clause !== undefined].filter(Boolean).length;
    if (shapes !== 1) {
      p.add(tp, 'expected exactly one of scoreOnly, clauseFromPolicy or clause');
      return;
    }
    if (t.scoreOnly === true && t.note === undefined) p.add(`${tp}.note`, 'a score-only tier needs a note');
    if (t.clauseFromPolicy === true && !isCollision) p.add(`${tp}.clauseFromPolicy`, 'only the collision detector takes its clause from the policy');
    if (t.clause !== undefined) {
      if (!isObj(t.clause)) {
        p.add(`${tp}.clause`, 'expected {D6?, D7?}');
        return;
      }
      for (const g of requiredGroups(classes, /** @type {Record<string, unknown> | undefined} */ (t.when))) {
        const id = t.clause[g];
        if (id === undefined) p.add(`${tp}.clause.${g}`, 'missing clause for this decree group');
        else if (!known.clauseIds.has(String(id))) p.add(`${tp}.clause.${g}`, `unknown clause "${String(id)}"`);
        else if (!String(id).startsWith(`${g}.`)) p.add(`${tp}.clause.${g}`, `clause ${String(id)} is not in ${g}`);
      }
    }
  });
}

/**
 * Counts unverified legal data for the release gate.
 * @param {RulesBundle} bundle Bundle.
 * @returns {{clauses: string[], speedDefaults: number, signs: string[], figures: string[], total: number}}
 *   Unverified clause ids, speed default rows, sign codes whose meaning is unverified, and sign
 *   codes whose drawing was not yet compared with the official figure (`figureChecked: null`).
 */
export function countUnverified(bundle) {
  const clauses = bundle.clauses.filter((c) => !c.verified).map((c) => c.id);
  const speedDefaults = bundle.speedDefaults.filter((s) => !s.verified).length;
  const signs = bundle.signs.filter((s) => !s.verified).map((s) => s.code);
  const figures = bundle.signs.filter((s) => s.figureChecked === null).map((s) => s.code);
  return { clauses, speedDefaults, signs, figures, total: clauses.length + speedDefaults + signs.length + figures.length };
}
