import { describe, expect, it } from 'vitest';
import {
  MULBERRY_INCREMENT,
  createStream,
  hash32,
  hashString,
  mulberry32,
  nextUint32,
  normalish,
  pick,
  range,
  splitmix32,
  streamFor,
  uniform,
} from './index.js';

/**
 * The published mulberry32 closure (Tommy Ettinger's generator, as commonly written in JS), kept
 * here only as an independent reference for the module's split state/output form.
 * @param {number} seed Seed.
 * @returns {() => number} Draws in [0, 1).
 */
function referenceMulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {import('./random.js').RandomStream} rng Stream.
 * @param {number} n Count.
 * @returns {number[]} Uniform draws.
 */
const draws = (rng, n) => Array.from({ length: n }, () => uniform(rng));

describe('mulberry32 streams', () => {
  it('match the reference generator for several seeds', () => {
    for (const seed of [0, 1, 42, 0x7fffffff, 0xdeadbeef]) {
      const ref = referenceMulberry32(seed | 0);
      const rng = { state: seed >>> 0 };
      for (let i = 0; i < 50; i += 1) expect(uniform(rng)).toBe(ref());
    }
  });

  it('pins a known sequence', () => {
    const rng = { state: 1 };
    expect([nextUint32(rng), nextUint32(rng), nextUint32(rng)]).toEqual([2693262067, 11749833, 2265367787]);
    expect(rng.state).toBe((1 + 3 * MULBERRY_INCREMENT) >>> 0);
    expect(mulberry32(1)).toBe(2693262067);
    expect(splitmix32(0)).toBe(1684164658);
    expect(hash32(1, 2, 3)).toBe(1958699624);
    expect(streamFor(42, 'map-junction', 0).state).toBe(597306473);
  });

  it('keeps the state a plain unsigned integer that round-trips through JSON', () => {
    const rng = createStream(7);
    draws(rng, 1000);
    expect(Number.isInteger(rng.state)).toBe(true);
    expect(rng.state).toBeGreaterThanOrEqual(0);
    expect(rng.state).toBeLessThan(2 ** 32);
    const copy = JSON.parse(JSON.stringify(rng));
    expect(draws(copy, 20)).toEqual(draws(rng, 20));
  });

  it('draws roughly uniformly in [0, 1)', () => {
    const values = draws(createStream(99), 100_000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeCloseTo(0.5, 2);
    const buckets = new Array(10).fill(0);
    for (const v of values) buckets[Math.floor(v * 10)] += 1;
    for (const b of buckets) expect(Math.abs(b - 10_000)).toBeLessThan(500);
  });
});

describe('seeding and hashing', () => {
  it('splitmix32 and hash32 are deterministic and order sensitive', () => {
    expect(splitmix32(5)).toBe(splitmix32(5));
    expect(splitmix32(5)).not.toBe(splitmix32(6));
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(3, 2, 1));
    expect(hash32(1, 2)).not.toBe(hash32(1, 2, 0));
    expect(hash32(-1)).toBe(hash32(0xffffffff));
  });

  it('rejects values that are not 32-bit integers', () => {
    expect(() => hash32(1.5)).toThrow(RangeError);
    expect(() => hash32(2 ** 32)).toThrow(RangeError);
    expect(() => splitmix32(Number.NaN)).toThrow(RangeError);
    expect(() => streamFor(1, 'm', -1)).toThrow(RangeError);
    expect(() => hashString(/** @type {string} */ (/** @type {unknown} */ (3)))).toThrow(TypeError);
  });

  it('hashes strings by code unit', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('osm-pasteur')).not.toBe(hashString('osm-pasteuR'));
  });
});

describe('streamFor', () => {
  it('gives the same stream for the same run seed, map and index', () => {
    expect(draws(streamFor(42, 'map-junction', 3), 10)).toEqual(draws(streamFor(42, 'map-junction', 3), 10));
  });

  it('separates indexes, maps and run seeds', () => {
    const first = (/** @type {number} */ seed, /** @type {string} */ map, /** @type {number} */ i) =>
      draws(streamFor(seed, map, i), 3).join(',');
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) seen.add(first(42, 'map-junction', i));
    expect(seen.size).toBe(500);
    expect(first(42, 'map-junction', 0)).not.toBe(first(43, 'map-junction', 0));
    expect(first(42, 'map-junction', 0)).not.toBe(first(42, 'map-minimal', 0));
  });

  it('keeps neighbouring streams uncorrelated', () => {
    const n = 20_000;
    const a = draws(streamFor(1, 'm', 0), n);
    const b = draws(streamFor(1, 'm', 1), n);
    const mean = (/** @type {number[]} */ v) => v.reduce((s, x) => s + x, 0) / v.length;
    const ma = mean(a);
    const mb = mean(b);
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i += 1) {
      cov += (a[i] - ma) * (b[i] - mb);
      va += (a[i] - ma) ** 2;
      vb += (b[i] - mb) ** 2;
    }
    expect(Math.abs(cov / Math.sqrt(va * vb))).toBeLessThan(0.03);
  });

  it('leaves one stream unchanged however many others draw', () => {
    const alone = draws(streamFor(9, 'm', 5), 5);
    const others = [0, 1, 2, 3, 4].map((i) => streamFor(9, 'm', i));
    for (const o of others) draws(o, 100);
    expect(draws(streamFor(9, 'm', 5), 5)).toEqual(alone);
  });
});

describe('draw helpers', () => {
  it('range stays inside its bounds', () => {
    const rng = createStream(3);
    for (let i = 0; i < 1000; i += 1) {
      const v = range(rng, 0.85, 0.95);
      expect(v).toBeGreaterThanOrEqual(0.85);
      expect(v).toBeLessThan(0.95);
    }
    expect(range(rng, 2, 2)).toBe(2);
    expect(() => range(rng, 2, 1)).toThrow(RangeError);
  });

  it('pick follows the weights and never picks a zero weight', () => {
    const rng = createStream(11);
    const counts = [0, 0, 0, 0];
    const weights = [0.7, 0, 0.15, 0.15];
    for (let i = 0; i < 50_000; i += 1) counts[pick(rng, weights)] += 1;
    expect(counts[1]).toBe(0);
    expect(counts[0] / 50_000).toBeCloseTo(0.7, 1);
    expect(counts[2] / 50_000).toBeCloseTo(0.15, 1);
    expect(() => pick(rng, [0, 0])).toThrow(RangeError);
    expect(() => pick(rng, [1, -1])).toThrow(RangeError);
  });

  it('pick and uniform consume exactly one draw, normalish four', () => {
    const a = createStream(5);
    const b = createStream(5);
    pick(a, [1, 2, 3]);
    uniform(b);
    expect(a.state).toBe(b.state);
    normalish(a);
    draws(b, 4);
    expect(a.state).toBe(b.state);
  });

  it('normalish has mean 0, variance 1 and bounded tails', () => {
    const rng = createStream(17);
    const n = 100_000;
    let sum = 0;
    let sq = 0;
    let maxAbs = 0;
    for (let i = 0; i < n; i += 1) {
      const v = normalish(rng);
      sum += v;
      sq += v * v;
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    expect(sum / n).toBeCloseTo(0, 1);
    expect(sq / n).toBeCloseTo(1, 1);
    expect(maxAbs).toBeLessThanOrEqual(2 * Math.sqrt(3));
  });
});
