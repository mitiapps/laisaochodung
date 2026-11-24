#!/usr/bin/env node
/**
 * Manual, one-off OSM fetch for an OSM corridor map: `npm run fetch:osm -- <map-id>`.
 *
 * Reads `data/maps/<id>/source.yaml` (its `bbox`), POSTs one Overpass query, writes
 * `data/maps/<id>/raw.overpass.json` and prints tag coverage plus OSM `maxspeed` values as hints
 * for the override author. Never run it from CI or the build: the extract is committed so builds
 * are offline, and the public Overpass instance is rate limited.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { bboxCentre } from './lib/project.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * Public Overpass instances, tried in turn: the main one answers 502 "at capacity" at busy times,
 * and the second mirrors the same database.
 */
const ENDPOINTS = Object.freeze(['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']);
// A generic client name; the public instance asks for a User-Agent but needs no project details.
const USER_AGENT = 'osm-extract-script/1.0';
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

/**
 * Overpass QL for a bbox: drivable ways plus the control and sign nodes the converter reads, and
 * the scenery the build imports: building footprints and parts, trees, street lamps, bus stops,
 * motorbike parking, benches, street cabinets, and fences, walls and gates.
 * @param {import('./lib/project.js').Bbox} bbox Bounding box.
 * @returns {string} Query.
 */
export function overpassQuery(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return [
    '[out:json][timeout:60];',
    '(',
    `  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$"](${b});`,
    `  node["highway"~"^(traffic_signals|crossing|stop|give_way)$"](${b});`,
    `  node["traffic_sign"](${b});`,
    `  way["building"](${b});`,
    `  way["building:part"](${b});`,
    `  relation["building"](${b});`,
    `  relation["building:part"](${b});`,
    `  node["natural"="tree"](${b});`,
    `  node["highway"~"^(street_lamp|bus_stop)$"](${b});`,
    `  node["amenity"~"^(motorcycle_parking|bench)$"](${b});`,
    `  node["man_made"="street_cabinet"](${b});`,
    `  way["amenity"="motorcycle_parking"](${b});`,
    `  node["barrier"~"^(fence|wall|gate)$"](${b});`,
    `  way["barrier"~"^(fence|wall|gate)$"](${b});`,
    ');',
    'out body geom;',
  ].join('\n');
}

/**
 * Tag coverage summary of an extract.
 * @param {{elements: Array<{type: string, id: number, tags?: Record<string, string>}>}} raw Extract.
 * @returns {string[]} Report lines.
 */
export function coverageReport(raw) {
  const ways = raw.elements.filter((e) => e.type === 'way' && e.tags?.highway);
  const nodes = raw.elements.filter((e) => e.type === 'node' && e.tags);
  /**
   * @param {string} key Tag key.
   * @returns {number} Ways carrying the tag.
   */
  const has = (key) => ways.filter((w) => w.tags?.[key] !== undefined).length;
  const signals = nodes.filter((n) => n.tags?.highway === 'traffic_signals');
  const crossings = nodes.filter((n) => n.tags?.highway === 'crossing');
  /** @type {Record<string, number>} */
  const crossingKinds = {};
  for (const n of crossings) {
    const k = n.tags?.crossing ?? n.tags?.['crossing:markings'] ?? '(untagged)';
    crossingKinds[k] = (crossingKinds[k] ?? 0) + 1;
  }
  /** @type {Record<string, number[]>} */
  const maxspeed = {};
  for (const w of ways) {
    const v = w.tags?.maxspeed;
    if (v !== undefined) (maxspeed[v] ??= []).push(w.id);
  }
  const lines = [
    `ways: ${ways.length}`,
    `  lanes: ${has('lanes')}/${ways.length}`,
    `  oneway: ${has('oneway')}/${ways.length}`,
    `  lit: ${has('lit')}/${ways.length}`,
    `signal nodes (highway=traffic_signals): ${signals.length}`,
    `crossing nodes (highway=crossing): ${crossings.length}`,
    ...Object.keys(crossingKinds)
      .sort()
      .map((k) => `  ${k}: ${crossingKinds[k]}`),
    `stop / give_way nodes: ${nodes.filter((n) => n.tags?.highway === 'stop' || n.tags?.highway === 'give_way').length}`,
    `traffic_sign nodes: ${nodes.filter((n) => n.tags?.traffic_sign !== undefined).length}`,
    'maxspeed hints (never a zone source; place a P.127 in overrides.yaml if a sign exists):',
    ...Object.keys(maxspeed)
      .sort()
      .map((v) => `  ${v}: ${maxspeed[v].length} ways`),
  ];
  return lines;
}

/**
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs the query with exponential backoff on overload responses, moving to the next public
 * instance on each retry.
 * @param {string} query Overpass QL.
 * @returns {Promise<unknown>} Parsed JSON.
 */
async function postQuery(query) {
  let wait = 10_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /** @type {Response | null} */
    let res = null;
    let failure = '';
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      failure = `${endpoint}: network error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (res) {
      const body = await res.text();
      if (res.ok && body.trimStart().startsWith('{')) return JSON.parse(body);
      failure = `${endpoint}: HTTP ${res.status}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`;
      if (!RETRY_STATUSES.has(res.status) && res.ok === false) throw new Error(`Overpass refused the query (${failure})`);
    }
    if (attempt === MAX_ATTEMPTS) throw new Error(`Overpass failed after ${attempt} attempts (${failure})`);
    console.error(`attempt ${attempt} failed (${failure}); retrying in ${wait / 1000} s`);
    await sleep(wait);
    wait *= 2;
  }
  throw new Error('unreachable');
}

/**
 * Entry point.
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<void>} Resolves when the extract is written.
 */
async function main(argv) {
  const id = argv[0];
  if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('usage: npm run fetch:osm -- <map-id>');
  const dir = path.join(ROOT, 'data/maps', id);
  const source = parse(await readFile(path.join(dir, 'source.yaml'), 'utf8'));
  if (source?.kind !== 'osm') throw new Error(`${id}: source.yaml is not an OSM map (kind: osm)`);
  bboxCentre(source.bbox);
  const raw = /** @type {{elements?: unknown}} */ (await postQuery(overpassQuery(source.bbox)));
  if (!Array.isArray(raw?.elements) || raw.elements.length === 0) throw new Error('Overpass returned no elements');
  const out = path.join(dir, 'raw.overpass.json');
  await writeFile(out, `${JSON.stringify(raw, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, out)}`);
  for (const line of coverageReport(/** @type {Parameters<typeof coverageReport>[0]} */ (raw))) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
