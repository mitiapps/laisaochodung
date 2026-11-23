/**
 * Loads the rules data files into one `RulesBundle` (Node only: file system and YAML).
 *
 * Layout under the data root: `legal/sources.yaml`, `legal/clauses.yaml`,
 * `legal/speed-defaults.yaml`, `rules/*.yaml` (one rule per file), `scoring/scoring.yaml`,
 * `scoring/collision-policy.yaml` and `signs/signs.yaml`. Collections are sorted by id (code
 * point order) so the bundle is byte-stable; the order inside a rule (tiers) is kept.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/** @typedef {import('../../../src/contracts/index.js').RulesBundle} RulesBundle */

/**
 * Reads and parses one YAML file.
 * @param {string} file Path.
 * @returns {Promise<unknown>} Parsed value.
 */
export async function readYaml(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${/** @type {Error} */ (err).message}`, { cause: err });
  }
  try {
    return parse(text);
  } catch (err) {
    throw new Error(`Invalid YAML in ${file}: ${/** @type {Error} */ (err).message}`, { cause: err });
  }
}

/**
 * Code-point comparison, independent of locale.
 * @param {string} a Left.
 * @param {string} b Right.
 * @returns {number} Order.
 */
export function compareCodePoints(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @template T
 * @param {unknown} v Parsed file content.
 * @param {string} file File, for the message.
 * @returns {T[]} The array.
 */
function asArray(v, file) {
  if (!Array.isArray(v)) throw new Error(`${file} must hold a YAML list`);
  return v;
}

/**
 * @param {unknown} v Parsed content.
 * @param {string} file File, for the message.
 * @returns {Record<string, unknown>} The mapping.
 */
function asObject(v, file) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file} must hold a YAML mapping`);
  return /** @type {Record<string, unknown>} */ (v);
}

/**
 * Loads the bundle from a data root.
 * @param {string} dataDir Data root (the repo's `data/`).
 * @returns {Promise<RulesBundle>} Bundle, not yet validated.
 */
export async function loadRules(dataDir) {
  const f = (/** @type {string[]} */ ...parts) => path.join(dataDir, ...parts);
  const rulesDir = f('rules');
  let ruleFiles;
  try {
    ruleFiles = (await readdir(rulesDir)).filter((n) => n.endsWith('.yaml')).sort(compareCodePoints);
  } catch (err) {
    throw new Error(`Cannot list ${rulesDir}: ${/** @type {Error} */ (err).message}`, { cause: err });
  }
  const rules = [];
  for (const name of ruleFiles) {
    const file = path.join(rulesDir, name);
    const rule = asObject(await readYaml(file), file);
    if (rule.id !== name.replace(/\.yaml$/, '')) throw new Error(`${file}: rule id "${String(rule.id)}" must match the file name`);
    rules.push(rule);
  }

  /** @type {(file: string) => Promise<Record<string, unknown>[]>} */
  const list = async (file) => asArray(await readYaml(file), file);
  const sources = await list(f('legal', 'sources.yaml'));
  const clauses = await list(f('legal', 'clauses.yaml'));
  const speedDefaults = await list(f('legal', 'speed-defaults.yaml'));
  const signs = await list(f('signs', 'signs.yaml'));
  const scoringFile = f('scoring', 'scoring.yaml');
  const policyFile = f('scoring', 'collision-policy.yaml');
  const scoring = asObject(await readYaml(scoringFile), scoringFile);
  const collisionPolicy = asObject(await readYaml(policyFile), policyFile);

  const byKey = (/** @type {string} */ k) => (/** @type {Record<string, unknown>} */ a, /** @type {Record<string, unknown>} */ b) =>
    compareCodePoints(String(a[k]), String(b[k]));
  const speedKey = (/** @type {Record<string, unknown>} */ s) => `${String(s.legalClass)}/${s.builtUp ? 1 : 0}/${s.multiLane ? 1 : 0}`;

  return /** @type {RulesBundle} */ (
    /** @type {unknown} */ ({
      rules: [...rules].sort(byKey('id')),
      clauses: [...clauses].sort(byKey('id')),
      sources: [...sources].sort(byKey('id')),
      speedDefaults: [...speedDefaults].sort((a, b) => compareCodePoints(speedKey(a), speedKey(b))),
      signs: [...signs].sort(byKey('code')),
      scoring,
      collisionPolicy,
    })
  );
}

/**
 * JSON with object keys sorted by code point at every level; arrays keep their order.
 * @param {unknown} value Plain data.
 * @returns {string} JSON text with a trailing newline.
 */
export function stableStringify(value) {
  /**
   * @param {unknown} v Value.
   * @returns {unknown} Copy with sorted keys.
   */
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (typeof v === 'object' && v !== null) {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const k of Object.keys(v).sort(compareCodePoints)) out[k] = sortKeys(/** @type {Record<string, unknown>} */ (v)[k]);
      return out;
    }
    return v;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
