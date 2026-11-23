/**
 * `npm run build:rules`: loads and validates the rules data and writes
 * `src/generated/rules.json` (one byte-stable `RulesBundle`). Exits non-zero on any problem.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRules } from '../../src/rules/index.js';
import { loadRules, stableStringify } from './lib/load.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Builds the bundle.
 * @param {{dataDir?: string, outFile?: string}} [options] Paths, defaulting to the repo's.
 * @returns {Promise<{rules: number, outFile: string}>} What was written.
 * @throws {Error} With every validation problem when the data is invalid.
 */
export async function buildRules(options = {}) {
  const dataDir = options.dataDir ?? path.join(ROOT, 'data');
  const outFile = options.outFile ?? path.join(ROOT, 'src', 'generated', 'rules.json');
  const bundle = await loadRules(dataDir);
  const problems = validateRules(bundle);
  if (problems.length > 0) {
    throw new Error(`Rules data has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, stableStringify(bundle));
  return { rules: bundle.rules.length, outFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRules().then(
    ({ rules, outFile }) => console.log(`Wrote ${rules} rules to ${path.relative(ROOT, outFile)}`),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
