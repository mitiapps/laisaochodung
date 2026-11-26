import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/**
 * Headers of the `/*` block in `public/_headers` (Cloudflare's format), so `vite preview` serves
 * the build under the same policy as production. The dev server does not apply them.
 * @param {string} text File contents.
 * @returns {Record<string, string>} Header name to value.
 * @throws {Error} When the file has no `/*` block or a malformed header line.
 */
function allPathHeaders(text) {
  /** @type {Record<string, string>} */
  const headers = {};
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/u.test(line)) {
      inBlock = line.trim() === '/*';
      continue;
    }
    if (!inBlock) continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`public/_headers: malformed line "${line.trim()}"`);
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (Object.keys(headers).length === 0) throw new Error('public/_headers: no "/*" block');
  return headers;
}

/** Size budget of every output chunk, in kB of minified code (1 kB = 1000 bytes). */
const DEFAULT_CHUNK_BUDGET_KB = 500;
/**
 * Budgets of the two large chunks, by chunk name. Both load only when a run starts (the session
 * awaits them with the map), so the home page stays at the entry chunk. `render` is three.js plus
 * the scene code; three.js alone stays over 500 kB however it is split. `rapier` is the compat
 * build of Rapier, whose JavaScript carries its wasm inlined as base64.
 * @type {Record<string, number>}
 */
const CHUNK_BUDGET_KB = { render: 900, rapier: 4600 };

/**
 * Fails the build when a chunk grows past its budget, in place of the generic size warning that
 * the two large lazy chunks would always raise.
 * @returns {import('vite').Plugin} Plugin.
 */
function chunkBudget() {
  return {
    name: 'chunk-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const over = [];
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        const kb = Buffer.byteLength(file.code, 'utf8') / 1000;
        const budget = CHUNK_BUDGET_KB[file.name] ?? DEFAULT_CHUNK_BUDGET_KB;
        if (kb > budget) over.push(`${file.fileName} (chunk "${file.name}") is ${kb.toFixed(1)} kB, budget ${budget} kB`);
      }
      if (over.length > 0) this.error(`Chunk size budget exceeded:\n${over.join('\n')}`);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // Cloudflare Pages serves the site at `/`. The GitHub Pages job sets SITE_BASE to the repo's
  // subpath (`/laisaochodung/`); the code builds every asset URL from `import.meta.env.BASE_URL`.
  base: process.env.SITE_BASE ?? '/',
  plugins: [tailwindcss(), svelte(), chunkBudget()],
  build: {
    // Licence texts of the bundled third-party code, linked from the credits page.
    license: { fileName: 'third-party-licenses.md' },
    // The per-chunk budgets of `chunkBudget` replace the generic warning; this only silences it.
    chunkSizeWarningLimit: Math.max(DEFAULT_CHUNK_BUDGET_KB, ...Object.values(CHUNK_BUDGET_KB)),
  },
  preview: {
    headers: allPathHeaders(readFileSync(new URL('./public/_headers', import.meta.url), 'utf8')),
  },
});
