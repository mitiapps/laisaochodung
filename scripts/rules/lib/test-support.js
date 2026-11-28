/**
 * Test support for the rules and scorer tests (Node only): the real rules bundle loaded from the
 * data files, the minimal fixture map, the vehicle catalog, and validated map variants.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMap } from '../../../src/contracts/index.js';
import { loadRules } from './load.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../../../src/contracts/index.js').RulesBundle} RulesBundle */

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** @type {Promise<RulesBundle> | null} */
let bundlePromise = null;

/**
 * The bundle built from `data/`, loaded once per test process. Do not mutate it; clone first.
 * @returns {Promise<RulesBundle>} Bundle.
 */
export function realBundle() {
  bundlePromise ??= loadRules(path.join(ROOT, 'data'));
  return bundlePromise;
}

/**
 * Deep copy of plain data.
 * @template T
 * @param {T} v Value.
 * @returns {T} Copy.
 */
export function clone(v) {
  return /** @type {T} */ (JSON.parse(JSON.stringify(v)));
}

/**
 * The minimal fixture map (fresh copy).
 * @returns {GameMap} Map.
 */
export function minimalMap() {
  return JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'map-minimal.json'), 'utf8'));
}

/**
 * The hand-written junction fixture map (fresh copy), with a lane graph and a traffic block.
 * @param {(map: GameMap) => void} [edit] Mutates the copy; the result is checked with `assertMap`.
 * @returns {GameMap} Map.
 */
export function junctionMap(edit) {
  /** @type {GameMap} */
  const map = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'map-junction.json'), 'utf8'));
  if (edit) {
    edit(map);
    assertMap(map);
  }
  return map;
}

/**
 * A vehicle from the catalog.
 * @param {'car-sedan' | 'scooter'} id Vehicle id.
 * @returns {VehicleInfo} Vehicle.
 */
export function vehicle(id) {
  /** @type {VehicleInfo[]} */
  const list = JSON.parse(readFileSync(path.join(ROOT, 'data', 'vehicles', 'vehicles.json'), 'utf8'));
  const v = list.find((x) => x.id === id);
  if (!v) throw new Error(`No vehicle ${id}`);
  return v;
}

/**
 * A variant of the minimal map, checked with `assertMap`.
 * @param {(map: GameMap) => void} edit Mutates the fresh copy.
 * @returns {GameMap} Variant.
 */
export function mapVariant(edit) {
  const map = minimalMap();
  edit(map);
  assertMap(map);
  return map;
}

/**
 * Scores a kinematic script with the real bundle, or with an edited copy of it.
 * @param {Omit<import('../../../src/testing/frame-builder.js').BuildOptions, 'vehicle'> & {vehicleId?: 'car-sedan' | 'scooter', quit?: boolean, bundle?: import('../../../src/contracts/index.js').RulesBundle, endOnPedestrianHit?: boolean}} script
 *   Frame-builder options plus the vehicle id (default car), the quit flag (default false), the
 *   bundle (default the real one) and the scorer's `endOnPedestrianHit` (default true).
 * @returns {Promise<{report: import('../../../src/contracts/index.js').ScoreReport, frames: import('../../../src/contracts/index.js').Frame[], live: import('../../../src/contracts/index.js').Breach[][]}>}
 *   Report, frames and the breaches of each live step.
 */
export async function scoreScript(script) {
  const { buildFrames } = await import('../../../src/testing/index.js');
  const { createScorer } = await import('../../../src/scoring/index.js');
  const { vehicleId = 'car-sedan', quit = false, bundle, endOnPedestrianHit, ...options } = script;
  const veh = vehicle(vehicleId);
  const frames = buildFrames({ ...options, vehicle: veh });
  const scorer = createScorer(bundle ?? (await realBundle()), options.map, veh, { endOnPedestrianHit });
  let state = scorer.initial;
  /** @type {import('../../../src/contracts/index.js').Breach[][]} */
  const live = [];
  for (const f of frames) {
    const r = scorer.step(state, f);
    state = r.state;
    live.push(r.breaches);
  }
  return { report: scorer.report(state, { quit }), frames, live };
}

/**
 * `ruleId:tierIndex:clauseId` of each reported breach, for compact assertions.
 * @param {import('../../../src/contracts/index.js').ScoreReport} report Report.
 * @returns {string[]} Summaries.
 */
export function summary(report) {
  return report.breaches.map((b) => `${b.ruleId}:${b.tierIndex}:${b.clause ? b.clause.id : '-'}`);
}
