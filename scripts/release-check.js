/**
 * Release gate, run by `npm run deploy` (its `predeploy`) or by hand after `npm run build`. It is
 * not part of the CI build or test job: a failing gate blocks a deploy, never the build.
 *
 * It fails while any of these holds:
 * - the built rules bundle has an unverified clause, speed default or sign meaning, or a sign
 *   whose drawing was not compared with the official QCVN 41 figure (`figureChecked: null`);
 * - `src/config/site.js` has no contact channel or donate QR, a malformed one, or a donate QR
 *   whose image is missing from `public/`;
 * - a file under `public/models/` or `public/signs/` has no entry in `data/credits/credits.json`;
 * - an OSM map has no attribution, or `data/maps/LICENSE-ODbL.md` is missing;
 * - a traffic model key of `data/traffic/params.yaml` or of a map's `traffic.mix` draws with neither
 *   a credited model file nor a procedural builder (a mix key must also be a traffic model).
 */

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSiteConfig, SITE } from '../src/config/site.js';
import { countUnverified } from '../src/rules/index.js';
import { KENNEY_BODIES, resolveLook } from '../src/render/vehicles/index.js';
import { MOTORBIKE_TYPES } from '../src/render/vehicles/motorbike.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Folders under `public/` whose every file needs a credit entry. */
export const CREDITED_DIRS = Object.freeze(['models', 'signs']);

/** Variants tried per traffic model: more than any model's `variants`, so every look is reached. */
const LOOK_VARIANTS = 8;

/**
 * @typedef {object} ReleaseInput
 * @property {import('../src/contracts/index.js').RulesBundle} bundle Built rules bundle.
 * @property {import('../src/config/site.js').SiteConfig} site Site settings.
 * @property {string[]} assetFiles Files under the credited folders, relative to `public/`.
 * @property {import('../src/contracts/catalog.js').Credit[]} credits Credit entries.
 * @property {{id: string, kind: string, attribution?: string, mix: string[]}[]} maps Built maps, with the
 *   model keys of their `traffic.mix` (empty without traffic).
 * @property {Record<string, {kind: 'car' | 'motorbike'}>} trafficModels Models of the compiled traffic
 *   parameters, by key.
 * @property {boolean} odblLicence `data/maps/LICENSE-ODbL.md` exists.
 * @property {boolean} donateQrExists The donate QR image exists under `public/`.
 */

/**
 * Lists every release blocker; pure, so tests can feed it fixtures.
 * @param {ReleaseInput} input What the gate checks.
 * @returns {string[]} Blockers, empty when the release may go ahead.
 */
export function releaseProblems(input) {
  /** @type {string[]} */
  const problems = [];
  const unverified = countUnverified(input.bundle);
  if (unverified.clauses.length > 0) problems.push(`unverified clauses: ${unverified.clauses.join(', ')}`);
  if (unverified.speedDefaults > 0) problems.push(`unverified TT 38 speed defaults: ${unverified.speedDefaults}`);
  if (unverified.signs.length > 0) problems.push(`unverified sign meanings: ${unverified.signs.join(', ')}`);
  if (unverified.figures.length > 0) {
    problems.push(`sign drawings not compared with the QCVN 41 figure (figureChecked: null): ${unverified.figures.join(', ')}`);
  }

  for (const p of checkSiteConfig(input.site)) problems.push(`src/config/site.js: ${p}`);
  if (input.site.contacts.length === 0) problems.push('src/config/site.js: no contact channel is set');
  if (input.site.donateQr === null) problems.push('src/config/site.js: donateQr is not set');
  else if (!input.donateQrExists) problems.push(`public${input.site.donateQr.src} is missing`);

  const credited = new Set(input.credits.map((c) => c.file));
  for (const file of input.assetFiles) {
    if (!credited.has(file)) problems.push(`public/${file} has no entry in data/credits/credits.json`);
  }

  for (const m of input.maps) {
    if (m.kind === 'osm' && !(typeof m.attribution === 'string' && m.attribution.includes('OpenStreetMap'))) {
      problems.push(`map ${m.id}: OSM map without an OpenStreetMap attribution`);
    }
  }
  if (!input.odblLicence) problems.push('data/maps/LICENSE-ODbL.md is missing');

  const keys = new Set(Object.keys(input.trafficModels));
  for (const m of input.maps) {
    for (const model of m.mix) {
      if (Object.hasOwn(input.trafficModels, model)) continue;
      problems.push(`map ${m.id}: traffic mix model ${model} is not in data/traffic/params.yaml`);
    }
  }
  for (const model of keys) {
    const missing = modelProblem(model, input.trafficModels[model].kind, credited);
    if (missing) problems.push(`traffic model ${model}: ${missing}`);
  }
  return problems;
}

/**
 * Why a traffic model cannot be drawn, if it cannot: every look it resolves to must be a procedural
 * builder (a motorbike type or the bus) or a Car Kit body whose model file is credited.
 * @param {string} model Model key.
 * @param {'car' | 'motorbike'} kind Actor kind of the model.
 * @param {Set<string>} credited Credited files.
 * @returns {string | null} Problem, or null when every look draws.
 */
function modelProblem(model, kind, credited) {
  for (let variant = 0; variant < LOOK_VARIANTS; variant += 1) {
    const look = resolveLook({ id: `npc-${variant}`, kind, model, variant });
    if (look.family === 'bike' && MOTORBIKE_TYPES.includes(look.body)) continue;
    if (look.family === 'bus') continue;
    const body = look.family === 'kenney' ? KENNEY_BODIES[look.body] : undefined;
    if (!body) return `look ${look.family}/${look.body} has no builder`;
    if (!credited.has(body.glb)) return `${body.glb} has no entry in data/credits/credits.json`;
  }
  return null;
}

/**
 * Every file under a directory, relative to `base`, with forward slashes.
 * @param {string} dir Directory to walk.
 * @param {string} base Path the results are relative to.
 * @returns {Promise<string[]>} Files, sorted.
 */
async function listFiles(dir, base) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(base, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/**
 * Parses a JSON file, naming the file in the error.
 * @param {string} file Absolute path.
 * @returns {Promise<unknown>} Parsed value.
 * @throws {Error} When the file is missing or not JSON.
 */
async function readJson(file) {
  const rel = path.relative(ROOT, file);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${rel}; run \`npm run build\` first (${err instanceof Error ? err.message : String(err)})`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${rel} is not valid JSON`, { cause: err });
  }
}

/**
 * Reads the gate's inputs from the repo: the built bundle and maps, credits, site settings.
 * @param {string} [root] Repo root.
 * @returns {Promise<ReleaseInput>} Input.
 */
export async function loadReleaseInput(root = ROOT) {
  const publicDir = path.join(root, 'public');
  const bundle = /** @type {import('../src/contracts/index.js').RulesBundle} */ (await readJson(path.join(root, 'src', 'generated', 'rules.json')));
  const credits = /** @type {import('../src/contracts/catalog.js').Credit[]} */ (await readJson(path.join(root, 'data', 'credits', 'credits.json')));
  const index = /** @type {{id: string}[]} */ (await readJson(path.join(publicDir, 'maps', 'index.json')));
  const maps = [];
  for (const entry of index) {
    const map = /** @type {{kind: string, attribution?: string, traffic?: {mix: {model: string}[]}}} */ (
      await readJson(path.join(publicDir, 'maps', `${entry.id}.json`))
    );
    maps.push({ id: entry.id, kind: map.kind, attribution: map.attribution, mix: (map.traffic?.mix ?? []).map((x) => x.model) });
  }
  const params = /** @type {{models: Record<string, {kind: 'car' | 'motorbike'}>}} */ (
    await readJson(path.join(root, 'src', 'generated', 'traffic-params.json'))
  );
  const assetFiles = [];
  for (const dir of CREDITED_DIRS) assetFiles.push(...(await listFiles(path.join(publicDir, dir), publicDir)));
  const odblLicence = await access(path.join(root, 'data', 'maps', 'LICENSE-ODbL.md')).then(
    () => true,
    () => false,
  );
  const donateQrExists =
    SITE.donateQr !== null &&
    (await access(path.join(publicDir, SITE.donateQr.src)).then(
      () => true,
      () => false,
    ));
  return { bundle, site: SITE, assetFiles, credits, maps, odblLicence, donateQrExists, trafficModels: params.models };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadReleaseInput().then(
    (input) => {
      const problems = releaseProblems(input);
      if (problems.length === 0) {
        console.log('Release check passed.');
        return;
      }
      console.error(`Release check failed with ${problems.length} blocker(s):\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
