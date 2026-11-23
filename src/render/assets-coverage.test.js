import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SIGN_ART, signArtPath } from './sign-art.js';
import { ACTOR_MODELS, VEHICLE_MODELS } from './vehicles/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = join(ROOT, 'public');

/**
 * Files under a directory, relative to `public/`, with forward slashes.
 * @param {string} dir Absolute directory.
 * @returns {string[]} Paths.
 */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(relative(PUBLIC, full).split('\\').join('/'));
  }
  return out;
}

const signCodes = /** @type {{code: string}[]} */ (parse(readFileSync(join(ROOT, 'data/signs/signs.yaml'), 'utf8'))).map(
  (s) => s.code,
);
const credits = /** @type {import('../contracts/catalog.js').Credit[]} */ (
  JSON.parse(readFileSync(join(ROOT, 'data/credits/credits.json'), 'utf8'))
);

describe('sign art', () => {
  it('ships exactly one SVG per code of data/signs/signs.yaml', () => {
    const shipped = filesUnder(join(PUBLIC, 'signs')).sort();
    expect(shipped).toEqual(signCodes.map(signArtPath).sort());
  });

  it('has drawing data for exactly the sign table codes', () => {
    expect(Object.keys(SIGN_ART).sort()).toEqual([...signCodes].sort());
  });

  it('gives every SVG an explicit pixel size so it rasterises on a canvas', () => {
    for (const code of signCodes) {
      const svg = readFileSync(join(PUBLIC, signArtPath(code)), 'utf8');
      expect(svg).toMatch(/<svg[^>]*\swidth="\d+"[^>]*\sheight="\d+"/);
      expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    }
  });
});

describe('credits', () => {
  it('credits every shipped model and sign file', () => {
    const files = [...filesUnder(join(PUBLIC, 'models')), ...filesUnder(join(PUBLIC, 'signs'))];
    const credited = new Set(credits.map((c) => c.file));
    expect(files.filter((f) => !credited.has(f))).toEqual([]);
  });

  it('lists no credit for a file that is not shipped', () => {
    for (const c of credits) expect(() => statSync(join(PUBLIC, c.file))).not.toThrow();
  });

  it('records the fields of every credit and the exact line of CC BY works', () => {
    for (const c of credits) {
      for (const key of ['file', 'title', 'author', 'sourceUrl', 'licence', 'licenceUrl']) {
        expect(typeof c[/** @type {keyof typeof c} */ (key)]).toBe('string');
      }
      expect(typeof c.ownWork).toBe('boolean');
      expect(c.sourceUrl).toMatch(/^https:\/\//);
      expect(c.licenceUrl).toMatch(/^https:\/\//);
      if (c.licence.startsWith('CC BY')) expect(c.creditLine).toBeTruthy();
    }
  });

  it('ships every GLB a model config points at', () => {
    for (const cfg of [...Object.values(VEHICLE_MODELS), ...Object.values(ACTOR_MODELS)]) {
      if (cfg.glb) expect(credits.some((c) => c.file === cfg.glb)).toBe(true);
    }
  });

  it('keeps the model payload under 5 MB', () => {
    const total = filesUnder(join(PUBLIC, 'models')).reduce((sum, f) => sum + statSync(join(PUBLIC, f)).size, 0);
    expect(total).toBeLessThan(5 * 1024 * 1024);
  });
});
