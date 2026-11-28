import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { distanceOutside, laneBounds, nearestLanePose } from './free-run.js';

/** @type {import('../contracts/index.js').GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-minimal.json', import.meta.url), 'utf8'));

describe('free-run placement', () => {
  it('bounds the lane polygons and measures the distance outside them', () => {
    const b = laneBounds(MAP);
    expect(b).toEqual({ minX: 0, minZ: -43.5, maxX: 200, maxZ: 43.5 });
    expect(distanceOutside(b, { x: 50, z: 0 })).toBe(0);
    expect(distanceOutside(b, { x: -30, z: 0 })).toBe(30);
    expect(distanceOutside(b, { x: 203, z: 47.5 })).toBeCloseTo(5);
  });

  it('finds the nearest centreline point with the lane travel heading', () => {
    expect(nearestLanePose(MAP, { x: 40, z: 1 })).toEqual({ pos: { x: 40, z: 1.75 }, heading: 0 });
    const west = nearestLanePose(MAP, { x: 40, z: -1 });
    expect(west.pos).toEqual({ x: 40, z: -1.75 });
    expect(Math.abs(west.heading)).toBeCloseTo(Math.PI);
  });

  it('rejects a map with no lanes', () => {
    const empty = { ...MAP, roads: [] };
    expect(() => laneBounds(empty)).toThrow(/no lanes/);
    expect(() => nearestLanePose(empty, { x: 0, z: 0 })).toThrow(/no lanes/);
  });
});
