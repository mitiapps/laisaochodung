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

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  // Licence texts of the bundled third-party code, linked from the credits page.
  build: {
    license: { fileName: 'third-party-licenses.md' },
  },
  preview: {
    headers: allPathHeaders(readFileSync(new URL('./public/_headers', import.meta.url), 'utf8')),
  },
});
