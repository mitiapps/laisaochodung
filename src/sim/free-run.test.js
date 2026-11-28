import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { footprint, polygonsIntersect } from '../geometry/index.js';
import { RESET_CLEARANCE_M, distanceOutside, laneBounds, nearestLanePose } from './free-run.js';

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

  /**
   * A built map.
   * @param {string} id Map id.
   * @returns {import('../contracts/index.js').GameMap} Map.
   */
  const built = (id) => JSON.parse(readFileSync(new URL(`../../public/maps/${id}.json`, import.meta.url), 'utf8'));
  const SCOOTER = { lengthM: 1.85, widthM: 0.7 };
  /**
   * Whether the grown ego footprint at a pose overlaps a ring.
   * @param {{pos: {x: number, z: number}, heading: number}} pose Pose.
   * @param {[number, number][]} ring Ring.
   * @returns {boolean} Overlap.
   */
  const hits = (pose, ring) =>
    polygonsIntersect(footprint(pose.pos, pose.heading, SCOOTER.lengthM + 2 * RESET_CLEARANCE_M, SCOOTER.widthM + 2 * RESET_CLEARANCE_M), ring);

  it('slides a reset pose out of the road-works barrier along its lane, and stays clear when reset again', () => {
    for (const id of ['tutorial-01-co-ban', 'tutorial-03-ban-dem']) {
      const map = built(id);
      const barrier = map.obstacles.find((o) => o.id === 'ob-barrier');
      if (!barrier) throw new Error(`${id} has no ob-barrier`);
      const ring = /** @type {[number, number][]} */ (barrier.footprint);
      const centre = { x: ring.reduce((a, p) => a + p[0], 0) / 4, z: ring.reduce((a, p) => a + p[1], 0) / 4 };
      // Without clearance the pose lands inside the barrier.
      expect(hits(nearestLanePose(map, centre), ring)).toBe(true);
      const pose = nearestLanePose(map, centre, { ...SCOOTER, actors: [] });
      for (const o of map.obstacles) expect(hits(pose, /** @type {[number, number][]} */ (o.footprint))).toBe(false);
      // Same lane, slid along it, not across to the kerb lane.
      expect(pose.pos.z).toBeCloseTo(centre.z, 1);
      expect(Math.abs(pose.pos.x - centre.x)).toBeLessThan(5);
      expect(nearestLanePose(map, pose.pos, { ...SCOOTER, actors: [] })).toEqual(pose);
    }
  });

  it('keeps a reset pose clear of a scripted actor', () => {
    const actor = { pos: { x: 40, z: 1.75 }, heading: 0, lengthM: 4.5, widthM: 1.8 };
    const pose = nearestLanePose(MAP, { x: 40, z: 1 }, { ...SCOOTER, actors: [actor] });
    expect(hits(pose, footprint(actor.pos, actor.heading, actor.lengthM, actor.widthM))).toBe(false);
    expect(pose.pos.z).toBe(1.75);
    expect(Math.abs(pose.pos.x - 40)).toBeLessThan(6);
  });

  it('falls back to the route start when no lane point is clear', () => {
    const wall = { pos: { x: 100, z: 0 }, heading: 0, lengthM: 400, widthM: 100 };
    expect(nearestLanePose(MAP, { x: 40, z: 1 }, { ...SCOOTER, actors: [wall] })).toEqual({ pos: MAP.route.start.pos, heading: MAP.route.start.heading });
  });

  it('rejects a map with no lanes', () => {
    const empty = { ...MAP, roads: [] };
    expect(() => laneBounds(empty)).toThrow(/no lanes/);
    expect(() => nearestLanePose(empty, { x: 0, z: 0 })).toThrow(/no lanes/);
  });
});
