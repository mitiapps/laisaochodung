#!/usr/bin/env node
/**
 * Map build: `npm run build:maps`.
 *
 * Reads every `data/maps/<id>/source.yaml` (tutorial, or OSM with `raw.overpass.json` and
 * `overrides.yaml`), converts it, validates it with `assertMap` against the sign codes in
 * `data/signs/signs.yaml`, and writes byte-stable JSON to `public/maps/<id>.json` plus
 * `public/maps/index.json` (`MapIndexEntry[]`). Exits non-zero on any error. Never fetches.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assertMap } from '../../src/contracts/assert-map.js';
import { MAP_COLLECTIONS } from '../../src/contracts/map.js';
import { angleDiff, headingOf } from '../../src/geometry/index.js';
import { compileMap, routeLength } from './lib/elements.js';
import { wayPoints } from './lib/graph.js';
import { osmSpec, tutorialSpec } from './lib/source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Longest OSM corridor route (m), plan decision D1. */
export const MAX_OSM_ROUTE_M = 1200;
/** Smallest heading change that counts as a turn between two route ways. */
const TURN_MIN_RAD = Math.PI / 4;

/** @typedef {import('../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../src/contracts/catalog.js').MapIndexEntry} MapIndexEntry */
/** @typedef {import('./lib/source.js').MapSpec} MapSpec */
/** @typedef {import('./lib/source.js').SourceYaml} SourceYaml */

/**
 * Canonical JSON value: numbers rounded (millimetres, or 1e-7° under `origin`), no −0, object
 * keys sorted, undefined fields dropped.
 * @param {unknown} v Value.
 * @param {number} [scale] Rounding scale.
 * @returns {unknown} Canonical copy.
 */
export function canonical(v, scale = 1000) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in map output: ${v}`);
    const r = Math.round(v * scale) / scale;
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(v)) return v.map((x) => canonical(x, scale));
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const x = /** @type {Record<string, unknown>} */ (v)[k];
      if (x !== undefined) out[k] = canonical(x, k === 'origin' ? 1e7 : scale);
    }
    return out;
  }
  return v;
}

/**
 * Serialises a map: collections sorted by id, canonical numbers and keys, two-space JSON.
 * @param {GameMap} map Map.
 * @returns {string} JSON text with a trailing newline.
 */
export function serializeMap(map) {
  /** @type {Record<string, unknown>} */
  const copy = { ...map };
  for (const key of MAP_COLLECTIONS) {
    copy[key] = [.../** @type {Array<{id: string}>} */ (copy[key])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return `${JSON.stringify(canonical(copy), null, 2)}\n`;
}

/**
 * Sign codes from the sign table.
 * @param {string} root Repo root.
 * @returns {Promise<string[]>} Codes.
 */
export async function loadSignCodes(root = ROOT) {
  const table = parse(await readFile(path.join(root, 'data/signs/signs.yaml'), 'utf8'));
  if (!Array.isArray(table)) throw new Error('data/signs/signs.yaml must be a list');
  return table.map((s, i) => {
    if (typeof s?.code !== 'string') throw new Error(`data/signs/signs.yaml[${i}]: missing code`);
    return s.code;
  });
}

/**
 * Reads and parses a YAML file.
 * @param {string} file Path.
 * @returns {Promise<SourceYaml>} Mapping.
 */
async function readYaml(file) {
  const v = parse(await readFile(file, 'utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path.relative(ROOT, file)}: expected a mapping`);
  return v;
}

/**
 * Builds the spec of one map directory.
 * @param {string} mapsDir `data/maps` directory.
 * @param {string} id Map id (directory name).
 * @returns {Promise<MapSpec>} Spec.
 */
export async function loadSpec(mapsDir, id) {
  const dir = path.join(mapsDir, id);
  const src = await readYaml(path.join(dir, 'source.yaml'));
  if (src.kind === 'tutorial') {
    /** @type {Map<string, Record<string, unknown>>} */
    const layouts = new Map();
    if (typeof src.layout === 'string') {
      if (!/^[a-z0-9-]+$/.test(src.layout)) throw new Error(`${id}: bad layout id ${src.layout}`);
      layouts.set(src.layout, await readYaml(path.join(mapsDir, src.layout, 'source.yaml')));
    }
    return tutorialSpec(id, src, (name) => {
      const base = layouts.get(name);
      if (!base || base.kind !== 'tutorial') throw new Error(`${id}: layout ${name} is not a tutorial map`);
      return base;
    });
  }
  if (src.kind === 'osm') {
    const rawFile = path.join(dir, 'raw.overpass.json');
    if (!existsSync(rawFile)) throw new Error(`${id}: raw.overpass.json is missing; run npm run fetch:osm -- ${id} once and commit it`);
    const raw = JSON.parse(await readFile(rawFile, 'utf8'));
    const overrides = await readYaml(path.join(dir, 'overrides.yaml'));
    return osmSpec(id, src, raw, overrides);
  }
  throw new Error(`${id}/source.yaml: kind must be tutorial or osm`);
}

/**
 * D1 selection constraint for OSM corridors: one signalled junction on the route, one marked
 * crossing, one one-way route road, one turn between two mapped ways, and at most 1.2 km.
 * @param {MapSpec} spec Spec.
 * @param {GameMap} map Built map.
 * @returns {string[]} Problems (empty when the corridor qualifies).
 */
export function corridorProblems(spec, map) {
  const problems = [];
  const routeWays = new Set(spec.routeOsmWays ?? []);
  const routeRoads = new Set(map.roads.filter((r) => r.osmWayId !== undefined && routeWays.has(r.osmWayId)).map((r) => r.id));
  if (!map.junctions.some((j) => j.signalized && j.roadIds.some((id) => routeRoads.has(id)))) problems.push('no signalled junction on the route');
  if (map.crosswalks.length === 0) problems.push('no marked crossing');
  if (!map.roads.some((r) => routeRoads.has(r.id) && r.oneway)) problems.push('no one-way route street');
  const len = routeLength(map);
  if (len > MAX_OSM_ROUTE_M) problems.push(`route is ${len.toFixed(0)} m, over ${MAX_OSM_ROUTE_M} m`);

  // A turn: consecutive route ways meeting with a heading change of at least 45°.
  const { network } = spec;
  const ids = spec.routeOsmWays ?? [];
  let turned = false;
  for (let i = 1; i < ids.length; i += 1) {
    const a = network.ways.find((w) => w.id === `w${ids[i - 1]}`);
    const b = network.ways.find((w) => w.id === `w${ids[i]}`);
    if (!a || !b) continue;
    const pa = wayPoints(network, a);
    const pb = wayPoints(network, b);
    const da = spec.routeDirs?.get(a.id) === 'backward' ? [...pa].reverse() : pa;
    const db = spec.routeDirs?.get(b.id) === 'backward' ? [...pb].reverse() : pb;
    const ha = headingOf(da[da.length - 1][0] - da[da.length - 2][0], da[da.length - 1][1] - da[da.length - 2][1]);
    const hb = headingOf(db[1][0] - db[0][0], db[1][1] - db[0][1]);
    if (Math.abs(angleDiff(ha, hb)) >= TURN_MIN_RAD) turned = true;
  }
  if (!turned) problems.push('no turn between two mapped route ways');
  return problems;
}

/**
 * Builds one map.
 * @param {string} mapsDir `data/maps` directory.
 * @param {string} id Map id.
 * @param {string[]} signCodes Allowed sign codes.
 * @returns {Promise<{map: GameMap, json: string, entry: MapIndexEntry, spec: MapSpec}>} Result.
 */
export async function buildOne(mapsDir, id, signCodes) {
  const spec = await loadSpec(mapsDir, id);
  for (const s of spec.signs) {
    if (!signCodes.includes(s.code)) throw new Error(`${id}: sign ${s.id} uses code ${s.code}, which is not in data/signs/signs.yaml`);
  }
  const compiled = compileMap(spec);
  const json = serializeMap(compiled);
  const map = /** @type {GameMap} */ (JSON.parse(json));
  assertMap(map, { signCodes });
  if (map.kind === 'osm') {
    const problems = corridorProblems(spec, map);
    if (problems.length > 0) throw new Error(`${id}: corridor fails the selection constraint: ${problems.join('; ')}`);
  }
  /** @type {MapIndexEntry} */
  const entry = { id: map.id, name: map.name, kind: map.kind, lengthM: Math.round(routeLength(map)) };
  if (map.attribution) entry.attribution = map.attribution;
  return { map, json, entry, spec };
}

/**
 * Builds every map in a directory.
 * @param {string} mapsDir `data/maps` directory.
 * @param {string[]} signCodes Allowed sign codes.
 * @returns {Promise<{files: Map<string, string>, entries: MapIndexEntry[]}>} JSON text per map id and the index.
 */
export async function buildAll(mapsDir, signCodes) {
  const ids = (await readdir(mapsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && existsSync(path.join(mapsDir, d.name, 'source.yaml')))
    .map((d) => d.name)
    .sort();
  if (ids.length === 0) throw new Error(`no maps under ${mapsDir}`);
  /** @type {Map<string, string>} */
  const files = new Map();
  const entries = [];
  for (const id of ids) {
    const { json, entry } = await buildOne(mapsDir, id, signCodes);
    files.set(id, json);
    entries.push(entry);
  }
  return { files, entries };
}

/**
 * Serialised map index.
 * @param {MapIndexEntry[]} entries Entries.
 * @returns {string} JSON text.
 */
export function serializeIndex(entries) {
  return `${JSON.stringify(canonical(entries), null, 2)}\n`;
}

/**
 * Entry point.
 * @returns {Promise<void>} Resolves when every map is written.
 */
async function main() {
  const signCodes = await loadSignCodes(ROOT);
  const { files, entries } = await buildAll(path.join(ROOT, 'data/maps'), signCodes);
  const out = path.join(ROOT, 'public/maps');
  await mkdir(out, { recursive: true });
  for (const [id, json] of files) await writeFile(path.join(out, `${id}.json`), json);
  await writeFile(path.join(out, 'index.json'), serializeIndex(entries));
  for (const e of entries) console.log(`built ${e.id} (${e.kind}, ${e.lengthM} m)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
