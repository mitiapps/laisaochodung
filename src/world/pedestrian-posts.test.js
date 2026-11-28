import { describe, expect, it } from 'vitest';
import junction from '../../tests/fixtures/map-junction.json' with { type: 'json' };
import { pointInPolygon } from '../geometry/index.js';
import { pedestrianPostPlacements } from './pedestrian-posts.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */

const MAP = /** @type {GameMap} */ (/** @type {unknown} */ (junction));

describe('pedestrianPostPlacements', () => {
  it('places two posts off the carriageway at the crosswalk with a walk signal and drops none', () => {
    const { posts, dropped } = pedestrianPostPlacements(MAP);
    expect(dropped).toEqual([]);
    expect(posts.map((p) => p.crosswalkId)).toEqual(['cw-w', 'cw-w']);
    for (const p of posts) {
      expect(MAP.junctions.some((j) => pointInPolygon([p.pos.x, p.pos.z], j.polygon))).toBe(false);
      expect(MAP.roads.some((r) => r.lanes.some((l) => pointInPolygon([p.pos.x, p.pos.z], l.polygon)))).toBe(false);
    }
  });

  it('drops and reports a post that stays on the carriageway, never placing it on the road', () => {
    const map = /** @type {GameMap} */ (structuredClone(MAP));
    // A junction surface far wider than the outward stepping covers every landing.
    map.junctions[0].polygon = [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ];
    const { posts, dropped } = pedestrianPostPlacements(map);
    expect(posts).toEqual([]);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toMatch(/crosswalk cw-w .*dropped/);
  });
});
