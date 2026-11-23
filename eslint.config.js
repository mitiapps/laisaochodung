import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { jsdoc } from 'eslint-plugin-jsdoc';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelteConfig from './svelte.config.js';

// Purity guard. The pure modules run identically in the browser, in Node tests and in build
// scripts, so they must not reach the engine, the UI, the file system or any clock or RNG.
// `no-restricted-imports` options do not merge between config blocks, so every directory's
// pattern list starts from BASE_BANS.
const BASE_BANS = [
  { regex: '^three(/|$)', message: 'Pure modules must not import three.' },
  { regex: '^@dimforge/', message: 'Pure modules must not import Rapier.' },
  { regex: '^svelte(/|$)', message: 'Pure modules must not import svelte.' },
  { regex: '^yaml$', message: 'Only build scripts and tests parse YAML.' },
  { regex: '^node:', message: 'Pure modules must not import Node built-ins.' },
  { regex: '^fs(/|$)', message: 'Pure modules must not touch the file system.' },
  {
    regex: '(^|/)(physics|sim|render|ui|game)(/|$)',
    message: 'Pure modules must not import src/physics, src/sim, src/render, src/ui or src/game.',
  },
];

/**
 * Builds a `no-restricted-imports` rule entry from the base bans plus an optional allow-list.
 * @param {string | null} allowRegex Imports that do NOT match this regex are rejected; null allows all.
 * @param {string} [allowMessage] Message for an import outside the allow-list.
 * @returns {import('eslint').Linter.RuleEntry} Rule entry.
 */
function importRule(allowRegex, allowMessage) {
  const patterns = [...BASE_BANS];
  if (allowRegex) patterns.push({ regex: `^(?!${allowRegex})`, message: allowMessage });
  return ['error', { patterns }];
}

const PURE_RUNTIME_RULES = {
  'no-restricted-globals': [
    'error',
    { name: 'window', message: 'Pure modules have no window.' },
    { name: 'document', message: 'Pure modules have no document.' },
    { name: 'performance', message: 'Pure modules must not read a clock; use frame time.' },
    { name: 'requestAnimationFrame', message: 'Pure modules must not schedule frames.' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Pure modules must be deterministic.' },
    { object: 'Date', property: 'now', message: 'Pure modules must not read a clock; use frame time.' },
  ],
};

const TESTS = ['**/*.test.js'];

/**
 * One config block per pure directory.
 * @param {string} dir Directory glob root, e.g. `src/world`.
 * @param {import('eslint').Linter.RuleEntry} imports The `no-restricted-imports` entry.
 * @returns {import('eslint').Linter.Config} Config block.
 */
function pureBlock(dir, imports) {
  return {
    name: `purity/${dir}`,
    files: [`${dir}/**/*.js`],
    ignores: TESTS,
    rules: { ...PURE_RUNTIME_RULES, 'no-restricted-imports': imports },
  };
}

export default defineConfig([
  globalIgnores([
    'dist/',
    'node_modules/',
    'src/generated/',
    'public/maps/',
    'test-results/',
    'playwright-report/',
    'coverage/',
    '.wrangler/',
  ]),
  js.configs.recommended,
  ...svelte.configs.recommended,
  jsdoc({ config: 'flat/recommended-typescript-flavor' }),
  {
    rules: {
      // Contracts are typedef-only; long unions and import() types read better unwrapped.
      'jsdoc/require-jsdoc': ['warn', { publicOnly: true }],
      'jsdoc/tag-lines': 'off',
    },
  },
  { languageOptions: { globals: { ...globals.browser } } },
  {
    files: ['scripts/**/*.js', '*.config.js', 'tests/**/*.js', '**/*.test.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  { files: ['**/*.svelte', '**/*.svelte.js'], languageOptions: { parserOptions: { svelteConfig } } },

  pureBlock('src/contracts', importRule(null)),
  pureBlock('src/rules', importRule(null)),
  pureBlock('src/scoring', importRule(null)),
  pureBlock('src/map-query', importRule(null)),
  pureBlock('src/geometry', importRule('\\./', 'src/geometry imports nothing outside itself.')),
  pureBlock(
    'src/world',
    importRule('\\./|\\.\\./(contracts|geometry)/', 'src/world imports only src/contracts and src/geometry.'),
  ),
  pureBlock(
    'src/testing',
    importRule(
      '\\./|\\.\\./(contracts|geometry|world)/',
      'src/testing imports only src/contracts, src/geometry and src/world.',
    ),
  ),
]);
