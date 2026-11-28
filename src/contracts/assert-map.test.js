import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertMap, checkMap, ContractError } from './index.js';

/** @typedef {import('./check.js').UntrustedJson} UntrustedJson Parsed fixture JSON. */

/** @type {UntrustedJson} */
const MAP = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-minimal.json', import.meta.url), 'utf8'));

describe('checkMap on malformed road lane lists', () => {
  it.each([
    ['lanes', /roads\[0\]\.lanes/u],
    ['laneLines', /roads\[0\]\.laneLines/u],
  ])('lists a problem, not a TypeError, when road %s is an object', (key, pattern) => {
    const m = structuredClone(MAP);
    m.roads[0][key] = {};
    expect(checkMap(m).join('\n')).toMatch(pattern);
    expect(() => assertMap(m)).toThrow(ContractError);
  });
});
