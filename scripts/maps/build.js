#!/usr/bin/env node
/**
 * Map build: `npm run build:maps`.
 *
 * Reads every `data/maps/<id>/source.yaml` (tutorial, or OSM with `raw.overpass.json` and
 * `overrides.yaml`), converts it, validates it with `assertMap` against the sign codes in
 * `data/signs/signs.yaml`, adds typed buildings and street props, and writes byte-stable JSON to `public/maps/<id>.json` plus
 * `public/maps/index.json` (`MapIndexEntry[]`). Exits non-zero on any error. Never fetches.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assertMap } from '../../src/contracts/assert-map.js';
import { MAP_COLLECTIONS, OPTIONAL_MAP_COLLECTIONS } from '../../src/contracts/map.js';
import { angleDiff, headingOf } from '../../src/geometry/index.js';
import { frontageRows, importOsmBuildings, parseLandmarks, typeTutorialRows } from './lib/buildings.js';
import { buildLaneGraph } from './lib/connectors.js';
import { compileMap, routeLength, topologyOf } from './lib/elements.js';
import { wayPoints } from './lib/graph.js';
import { buildLaneArrows } from './lib/lane-arrows.js';
import { createProjection } from './lib/project.js';
import {
  Blockers,
  PROP_SPECS,
  PropSet,
  fillForecourts,
  fillPavements,
  importOsmProps,
  mapBlockers,
  parsePropList,
  placePropList,
  propSpecFootprint,
  roadSides,
} from './lib/props.js';
import { osmSpec, tutorialSpec } from './lib/source.js';
import { parseTrafficSource, trafficConfig, trafficTimeLimit } from './lib/traffic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Longest OSM corridor route (m), plan decision D1. */
export const MAX_OSM_ROUTE_M = 1200;
/** Smallest heading change that counts as a turn between two route ways. */
const TURN_MIN_RAD = Math.PI / 4;

/** @typedef {import('../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../src/contracts/catalog.js').MapIndexEntry} MapIndexEntry */
/** @typedef {import('./lib/source.js').MapSpec} MapSpec */
/** @typedef {import('./lib/source.js').SourceYaml} SourceYaml */
/** @typedef {import('./lib/buildings.js').OsmBuildingElement} OsmBuildingElement */
/** @typedef {import('./lib/props.js').OsmPropElement} OsmPropElement */

/**
 * Rounding scales of keys whose numbers are not lengths: degrees under `origin`, and traffic mix
 * shares, which are fractions that must still sum to 1 after rounding.
 * @type {Record<string, number>}
 */
const KEY_SCALES = { origin: 1e7, share: 1e9 };

/**
 * Canonical JSON value: numbers rounded (millimetres, or the `KEY_SCALES` scale under those
 * keys), no −0, object keys sorted, undefined fields dropped.
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
      if (x !== undefined) out[k] = canonical(x, KEY_SCALES[k] ?? scale);
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
  for (const key of [...MAP_COLLECTIONS, ...OPTIONAL_MAP_COLLECTIONS]) {
    if (copy[key] === undefined) continue;
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
 * Adds the lane graph and the lane arrows it implies to a compiled map and, when its source has a
 * `traffic` key, the traffic block and the traffic time limit.
 * @param {GameMap} map Compiled map (changed in place).
 * @param {SourceYaml | undefined} trafficSrc Value of the source's `traffic` key.
 * @param {string} where Source file name for messages.
 * @returns {string[]} Build notes worth logging.
 */
export function addLaneGraphAndTraffic(map, trafficSrc, where) {
  const graph = buildLaneGraph(map);
  map.connectors = graph.connectors;
  map.conflicts = graph.conflicts;
  // A plain join hands a lane to the next road with no junction.
  map.laneJoins = graph.joins.map((j) => ({ fromLaneId: j.fromLaneId, toLaneId: j.toLaneId }));
  const arrows = buildLaneArrows(map);
  if (arrows.arrows.length > 0) map.laneArrows = arrows.arrows;
  const notes = [...arrows.notes];
  if (trafficSrc !== undefined && graph.joins.length > 0) {
    notes.push(`plain joins: ${graph.joins.map((j) => `${j.fromLaneId}→${j.toLaneId}`).join(', ')}`);
  }
  if (trafficSrc === undefined) return notes;
  map.traffic = trafficConfig(map, parseTrafficSource(trafficSrc, where), graph);
  const limit = trafficTimeLimit(map, graph);
  map.route.timeLimitS = limit.timeLimitS;
  notes.push(
    `traffic: maxAgents ${map.traffic.maxAgents}, ${map.traffic.sources.length} sources, ${map.traffic.sinks.length} sinks; ` +
      `timeLimitS ${limit.timeLimitS} (formula ${limit.formulaS} s over ${limit.routeM.toFixed(0)} m)`,
  );
  return notes;
}

/**
 * Scenery sources of one map.
 * @typedef {object} ScenerySource
 * @property {string} file Source file name for messages.
 * @property {unknown} props Tutorial `props:` list (a layout's when the map sets none).
 * @property {{raw: {elements: Array<OsmBuildingElement & OsmPropElement>}, landmarks: unknown} | null} osm OSM extract and the
 *   `landmarks` overrides, for OSM maps.
 */

/**
 * Adds typed buildings and street props to a compiled map: OSM footprints and furniture on OSM
 * maps; shophouse typing of the written rows, generated rows along every free pavement edge and
 * the `props:` list on tutorial maps; then a seeded fill of trees, lamps, poles and parked
 * motorbikes on every map. Only building fields, new building obstacles and `props` are added;
 * nothing else in the map changes.
 * @param {GameMap} map Compiled map (changed in place).
 * @param {MapSpec} spec Its spec.
 * @param {ScenerySource} source Scenery sources.
 * @returns {string[]} Build notes worth logging.
 */
export function addScenery(map, spec, source) {
  const topo = topologyOf(spec);
  const sides = roadSides(topo);
  const roadLines = topo.roads.map((r) => r.points);
  const lanes = new Blockers();
  for (const road of map.roads) for (const lane of road.lanes) lanes.add(lane.polygon, `lane ${lane.id}`);
  for (const j of map.junctions) lanes.add(j.polygon, `junction ${j.id}`);
  /** @type {string[]} */
  const notes = [];

  const toXZ = spec.origin ? createProjection(spec.origin).toXZ : null;
  if (source.osm) {
    if (!toXZ) throw new Error(`${source.file}: an OSM map needs a projection origin`);
    const landmarks = parseLandmarks(source.osm.landmarks, source.file);
    const imported = importOsmBuildings(source.osm.raw, toXZ, { mapId: map.id, lanes, landmarks, roadLines });
    map.obstacles.push(...imported.obstacles);
    notes.push(...imported.notes);
  }
  typeTutorialRows(map.obstacles, roadLines);

  const specs = parsePropList(source.props, topo, sides, source.file);
  /** @type {import('./lib/props.js').Forecourt[]} */
  let forecourts = [];
  if (map.kind === 'tutorial') {
    const rowBlockers = new Blockers();
    for (const it of lanes.items) rowBlockers.add(it.ring, it.what);
    for (const pv of map.pavements) rowBlockers.add(pv.polygon, `pavement ${pv.id}`);
    for (const o of map.obstacles) rowBlockers.add(o.footprint, `obstacle ${o.id}`);
    const frontage = specs.filter((p) => PROP_SPECS[p.kind].frontage).map(propSpecFootprint);
    const generated = frontageRows(map.id, sides, rowBlockers, frontage);
    map.obstacles.push(...generated.rows);
    forecourts = generated.forecourts;
    notes.push(`buildings: ${generated.rows.length} shophouse rows generated, ${forecourts.length} with a forecourt`);
  }

  const set = new PropSet(sides, mapBlockers(map));
  placePropList(set, specs, source.file);
  if (source.osm && toXZ) notes.push(...importOsmProps(source.osm.raw, toXZ, topo, set));
  fillForecourts(set, map.id, forecourts);
  fillPavements(set, map.id, map.kind === 'tutorial');
  map.props = set.props;
  /** @type {Record<string, number>} */
  const byKind = {};
  for (const p of set.props) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  notes.push(`props: ${Object.keys(byKind).sort().map((k) => `${byKind[k]} ${k}`).join(', ') || 'none'}`);
  return notes;
}

/**
 * Scenery sources of one map directory.
 * @param {string} mapsDir `data/maps` directory.
 * @param {string} id Map id.
 * @param {SourceYaml} src Parsed `source.yaml`.
 * @returns {Promise<ScenerySource>} Sources.
 */
async function scenerySource(mapsDir, id, src) {
  const file = `${id}/source.yaml`;
  if (src.kind === 'osm') {
    const dir = path.join(mapsDir, id);
    const raw = JSON.parse(await readFile(path.join(dir, 'raw.overpass.json'), 'utf8'));
    const overrides = await readYaml(path.join(dir, 'overrides.yaml'));
    return { file: `${id}/overrides.yaml`, props: undefined, osm: { raw, landmarks: overrides.landmarks } };
  }
  let props = src.props;
  if (props === undefined && typeof src.layout === 'string') props = (await readYaml(path.join(mapsDir, src.layout, 'source.yaml'))).props;
  return { file, props, osm: null };
}

/**
 * Builds one map.
 * @param {string} mapsDir `data/maps` directory.
 * @param {string} id Map id.
 * @param {string[]} signCodes Allowed sign codes.
 * @param {{scenery?: boolean}} [options] `scenery: false` leaves out typed buildings and props,
 *   for comparing a build without them.
 * @returns {Promise<{map: GameMap, json: string, entry: MapIndexEntry, spec: MapSpec, notes: string[]}>} Result
 *   and the notes worth logging (stubs kept short, traffic values, scenery counts).
 */
export async function buildOne(mapsDir, id, signCodes, options = {}) {
  const spec = await loadSpec(mapsDir, id);
  for (const s of spec.signs) {
    if (!signCodes.includes(s.code)) throw new Error(`${id}: sign ${s.id} uses code ${s.code}, which is not in data/signs/signs.yaml`);
  }
  const notes = (spec.stubNotes ?? []).map((n) => `stub of way ${n.osmWayId} at ${n.nodeId} (${n.side}) kept at ${n.lengthM.toFixed(0)} m: ${n.reason}`);
  const compiled = compileMap(spec, notes);
  const src = await readYaml(path.join(mapsDir, id, 'source.yaml'));
  notes.push(...addLaneGraphAndTraffic(compiled, src.traffic, `${id}/source.yaml`));
  if (options.scenery !== false) notes.push(...addScenery(compiled, spec, await scenerySource(mapsDir, id, src)));
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
  return { map, json, entry, spec, notes };
}

/**
 * Builds every map in a directory.
 * @param {string} mapsDir `data/maps` directory.
 * @param {string[]} signCodes Allowed sign codes.
 * @returns {Promise<{files: Map<string, string>, entries: MapIndexEntry[], notes: Map<string, string[]>}>} JSON text per
 *   map id, the index, and the build notes per map id.
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
  /** @type {Map<string, string[]>} */
  const notes = new Map();
  for (const id of ids) {
    const built = await buildOne(mapsDir, id, signCodes);
    files.set(id, built.json);
    entries.push(built.entry);
    notes.set(id, built.notes);
  }
  return { files, entries, notes };
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
  const { files, entries, notes } = await buildAll(path.join(ROOT, 'data/maps'), signCodes);
  const out = path.join(ROOT, 'public/maps');
  await mkdir(out, { recursive: true });
  for (const [id, json] of files) await writeFile(path.join(out, `${id}.json`), json);
  await writeFile(path.join(out, 'index.json'), serializeIndex(entries));
  for (const e of entries) {
    console.log(`built ${e.id} (${e.kind}, ${e.lengthM} m)`);
    for (const n of notes.get(e.id) ?? []) console.log(`  ${e.id}: ${n}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
