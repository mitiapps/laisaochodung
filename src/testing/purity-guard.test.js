import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints in-memory sources at virtual paths, so the purity and direction guards in
// eslint.config.js are proven without writing files into the tree.
const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../', import.meta.url)) });

/**
 * @param {string} filePath Repo-relative path the code pretends to live at.
 * @param {string} code Source.
 * @returns {Promise<string[]>} Rule ids that fired.
 */
async function ruleIds(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId ?? 'fatal');
}

describe('purity guard', () => {
  it('rejects three in a pure module', async () => {
    expect(await ruleIds('src/scoring/probe.js', "import * as T from 'three';\nexport const a = T;\n")).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds('src/world/probe.js', "import * as T from 'three';\nexport const a = T;\n")).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects src/map-query from src/world and src/testing', async () => {
    const code = "import * as q from '../map-query/index.js';\nexport const a = q;\n";
    expect(await ruleIds('src/world/probe.js', code)).toContain('no-restricted-imports');
    expect(await ruleIds('src/testing/probe.js', code)).toContain('no-restricted-imports');
  });

  it('rejects Node built-ins and any outside import in src/geometry', async () => {
    expect(await ruleIds('src/geometry/probe.js', "import fs from 'node:fs';\nexport const a = fs;\n")).toContain(
      'no-restricted-imports',
    );
    expect(
      await ruleIds('src/geometry/probe.js', "import * as c from '../contracts/index.js';\nexport const a = c;\n"),
    ).toContain('no-restricted-imports');
  });

  it('rejects engine and UI paths from pure modules', async () => {
    for (const dir of ['physics', 'sim', 'render', 'ui', 'game']) {
      const code = `import * as x from '../${dir}/index.js';\nexport const a = x;\n`;
      expect(await ruleIds('src/rules/probe.js', code)).toContain('no-restricted-imports');
    }
  });

  it('rejects clocks, randomness and DOM globals', async () => {
    const ids = await ruleIds(
      'src/map-query/probe.js',
      'export const a = [Math.random(), Date.now(), performance.now(), window, document, requestAnimationFrame];\n',
    );
    expect(ids.filter((id) => id === 'no-restricted-properties')).toHaveLength(2);
    expect(ids.filter((id) => id === 'no-restricted-globals')).toHaveLength(4);
  });

  it('allows the declared dependency direction', async () => {
    expect(
      await ruleIds(
        'src/testing/probe.js',
        "import * as w from '../world/index.js';\nimport * as g from '../geometry/index.js';\nimport * as c from '../contracts/index.js';\nexport const a = [w, g, c];\n",
      ),
    ).toEqual([]);
    expect(
      await ruleIds(
        'src/world/probe.js',
        "import * as g from '../geometry/index.js';\nimport * as c from '../contracts/index.js';\nexport const a = [g, c];\n",
      ),
    ).toEqual([]);
  });

  it('exempts colocated tests', async () => {
    expect(
      await ruleIds(
        'src/scoring/probe.test.js',
        "import fs from 'node:fs';\nimport YAML from 'yaml';\nexport const a = [fs, YAML, Math.random()];\n",
      ),
    ).toEqual([]);
  });

  it('keeps the dependency direction in nested src/world directories', async () => {
    expect(
      await ruleIds(
        'src/world/traffic/probe.js',
        "import * as s from './state.js';\nimport * as r from '../random.js';\nimport * as g from '../../geometry/index.js';\nimport * as c from '../../contracts/index.js';\nexport const a = [s, r, g, c];\n",
      ),
    ).toEqual([]);
    for (const path of ['../../sim/index.js', '../../testing/index.js', '../../map-query/index.js', '../../rules/x.js']) {
      const code = `import * as x from '${path}';\nexport const a = x;\n`;
      expect(await ruleIds('src/world/traffic/probe.js', code), path).toContain('no-restricted-imports');
    }
    expect(await ruleIds('src/world/traffic/probe.js', 'export const a = Math.random();\n')).toContain(
      'no-restricted-properties',
    );
  });

  it('exempts colocated benches', async () => {
    expect(
      await ruleIds(
        'src/world/traffic/probe.bench.js',
        "import fs from 'node:fs';\nimport { test } from 'vitest';\nexport const a = [fs, test];\n",
      ),
    ).toEqual([]);
  });

  it('leaves non-pure modules free to import the engine', async () => {
    expect(await ruleIds('src/render/probe.js', "import * as T from 'three';\nexport const a = T;\n")).toEqual([]);
  });
});
