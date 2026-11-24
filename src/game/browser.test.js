import { describe, expect, it } from 'vitest';
import { parseDevRunQuery } from './browser.js';

describe('parseDevRunQuery', () => {
  it('reads nothing from a hash without a query', () => {
    expect(parseDevRunQuery('#/play')).toEqual({});
  });

  it('reads traffic, seed and agentScale', () => {
    expect(parseDevRunQuery('#/play?map=osm-pasteur&vehicle=car-sedan&seed=42&traffic=off&agentScale=0.5')).toEqual({ traffic: 'off', seed: 42, agentScale: 0.5 });
    expect(parseDevRunQuery('#/play?traffic=map')).toEqual({ traffic: 'map' });
  });

  it.each([
    ['1', 1],
    ['1.0', 1],
    ['0.25', 0.25],
    ['.6', 0.6],
  ])('accepts agentScale=%s', (text, value) => {
    expect(parseDevRunQuery(`#/play?agentScale=${text}`).agentScale).toBe(value);
  });

  it.each(['0', '0.0', '1.5', '2', '-0.5', '', 'half', '1e-1', '0x1', ' 0.5', 'Infinity', 'NaN', '0.5.1'])('rejects agentScale=%j', (text) => {
    expect(() => parseDevRunQuery(`#/play?agentScale=${encodeURIComponent(text)}`)).toThrow(/agentScale must be a decimal in \(0, 1\]/u);
  });

  it('rejects a seed or traffic value it does not understand', () => {
    expect(() => parseDevRunQuery('#/play?seed=abc')).toThrow(RangeError);
    expect(() => parseDevRunQuery('#/play?traffic=on')).toThrow(RangeError);
  });
});
