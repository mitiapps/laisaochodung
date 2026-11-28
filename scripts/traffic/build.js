/**
 * `npm run build:traffic`: loads `data/traffic/params.yaml`, checks that every number carries a
 * `paramBasis` entry naming `design` or a listed source, strips the provenance, adds the statutory
 * default limits of `data/legal/speed-defaults.yaml` (without their citations, which the rules
 * build checks), validates the values against `TrafficParams` and writes
 * `src/generated/traffic-params.json`. Exits non-zero on any problem.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkTrafficParams } from '../../src/contracts/traffic.js';

/** @typedef {import('../../src/contracts/traffic.js').TrafficParams} TrafficParams */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {unknown} v Value.
 * @returns {v is Record<string, unknown>} Plain object.
 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A value that needs its own basis entry: a number, a list of numbers, or a mapping of numbers
 * (such as turn weights).
 * @param {unknown} v Value.
 * @returns {boolean} Leaf parameter.
 */
function isParamLeaf(v) {
  if (typeof v === 'number') return true;
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => typeof x === 'number');
  if (isObject(v)) {
    const vals = Object.values(v);
    return vals.length > 0 && vals.every((x) => typeof x === 'number');
  }
  return false;
}

/**
 * Removes `paramBasis` from a tree, collecting a problem for every leaf without a valid basis.
 * @param {unknown} node Parsed YAML node.
 * @param {string} at Path for messages.
 * @param {Set<string>} sourceIds Known source ids.
 * @param {string[]} problems Problems found.
 * @returns {unknown} The node without provenance.
 */
function stripBasis(node, at, sourceIds, problems) {
  if (!isObject(node)) return node;
  const basis = node.paramBasis;
  if (basis !== undefined && !isObject(basis)) problems.push(`${at}.paramBasis: expected a mapping`);
  const basisMap = isObject(basis) ? basis : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'paramBasis') continue;
    const p = at ? `${at}.${key}` : key;
    if (isParamLeaf(value)) {
      const b = basisMap[key];
      if (b === undefined) problems.push(`${p}: missing paramBasis (design or {sourced: <id>})`);
      else if (b !== 'design') {
        if (!isObject(b) || typeof b.sourced !== 'string' || Object.keys(b).length !== 1) {
          problems.push(`${at}.paramBasis.${key}: expected design or {sourced: <source id>}`);
        } else if (!sourceIds.has(b.sourced)) {
          problems.push(`${at}.paramBasis.${key}: unknown source "${b.sourced}"`);
        }
      }
      out[key] = value;
    } else {
      out[key] = stripBasis(value, p, sourceIds, problems);
    }
  }
  for (const key of Object.keys(basisMap)) {
    if (!(key in node) || !isParamLeaf(node[key])) problems.push(`${at}.paramBasis.${key}: names no parameter`);
  }
  return out;
}

/**
 * The limit fields of parsed `speed-defaults.yaml` rows; anything else in a row is dropped.
 * @param {unknown} doc Parsed YAML.
 * @param {string[]} problems Problems found.
 * @returns {unknown[]} Rows, for `checkTrafficParams` to validate.
 */
function speedDefaultRows(doc, problems) {
  if (!Array.isArray(doc)) {
    problems.push('speed defaults: expected a list of rows');
    return [];
  }
  return doc.map((row) =>
    isObject(row) ? { legalClass: row.legalClass, builtUp: row.builtUp, multiLane: row.multiLane, maxKmh: row.maxKmh } : row,
  );
}

/**
 * Compiles parsed `params.yaml` content with the parsed statutory default limits.
 * @param {unknown} doc Parsed `params.yaml`.
 * @param {unknown} speedDefaults Parsed `data/legal/speed-defaults.yaml`.
 * @returns {TrafficParams} Compiled parameters.
 * @throws {Error} Listing every problem when the data is invalid.
 */
export function compileTrafficParams(doc, speedDefaults) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(doc)) throw new Error('data/traffic/params.yaml must hold a mapping');
  const { sources, ...rest } = doc;
  /** @type {Set<string>} */
  const sourceIds = new Set();
  if (!isObject(sources)) problems.push('sources: expected a mapping of source id to {description, url}');
  else {
    for (const [id, s] of Object.entries(sources)) {
      if (!isObject(s) || typeof s.description !== 'string' || typeof s.url !== 'string' || !/^https:\/\//u.test(s.url)) {
        problems.push(`sources.${id}: expected {description, url} with an https url`);
      }
      sourceIds.add(id);
    }
  }
  const params = /** @type {Record<string, unknown>} */ (stripBasis(rest, '', sourceIds, problems));
  if ('speedDefaults' in params) problems.push('speedDefaults: comes from data/legal/speed-defaults.yaml, not params.yaml');
  params.speedDefaults = speedDefaultRows(speedDefaults, problems);
  problems.push(...checkTrafficParams(params));
  if (problems.length > 0) {
    throw new Error(`Traffic parameters have ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  }
  return /** @type {TrafficParams} */ (params);
}

/**
 * Reads and parses a YAML file.
 * @param {string} file Path.
 * @returns {Promise<unknown>} Parsed content.
 * @throws {Error} When the file cannot be read or parsed.
 */
async function readYaml(file) {
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
 * Builds the compiled parameters file.
 * @param {{inFile?: string, speedDefaultsFile?: string, outFile?: string}} [options] Paths,
 *   defaulting to the repo's.
 * @returns {Promise<{models: number, outFile: string}>} What was written.
 * @throws {Error} When a file cannot be read or the data is invalid.
 */
export async function buildTraffic(options = {}) {
  const inFile = options.inFile ?? path.join(ROOT, 'data', 'traffic', 'params.yaml');
  const speedDefaultsFile = options.speedDefaultsFile ?? path.join(ROOT, 'data', 'legal', 'speed-defaults.yaml');
  const outFile = options.outFile ?? path.join(ROOT, 'src', 'generated', 'traffic-params.json');
  const doc = await readYaml(inFile);
  const params = compileTrafficParams(doc, await readYaml(speedDefaultsFile));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(params, null, 2)}\n`);
  return { models: Object.keys(params.models).length, outFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTraffic().then(
    ({ models, outFile }) => console.log(`Wrote traffic parameters (${models} models) to ${path.relative(ROOT, outFile)}`),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
