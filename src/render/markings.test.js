import { describe, expect, it } from 'vitest';
import map from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import {
  CENTRE_DASH,
  LINE_WIDTH_M,
  crosswalkStripes,
  dashIntervals,
  laneLineQuads,
  laneLineStyle,
  stopLineQuads,
} from './markings.js';
import { finishArchPose, nearestLaneHeading } from './layout.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').LaneLine} LaneLine */
/** @typedef {import('../contracts/map.js').Lane} Lane */

const fixture = /** @type {GameMap} */ (/** @type {unknown} */ (map));

/**
 * Lanes of a fixture road by id.
 * @param {string} roadId Road id.
 * @returns {Map<string, Lane>} Lanes.
 */
function lanesOf(roadId) {
  const road = fixture.roads.find((r) => r.id === roadId);
  if (!road) throw new Error(roadId);
  return new Map(road.lanes.map((l) => [l.id, l]));
}

/**
 * @param {Partial<LaneLine>} over Fields to override.
 * @returns {LaneLine} Line.
 */
function line(over) {
  return {
    id: 'l',
    left: 'rw-w',
    right: 'rw-e',
    type: 'dashed',
    polyline: [
      [0, 0],
      [96.5, 0],
    ],
    crossable: 'both',
    ...over,
  };
}

describe('lane line styles', () => {
  it('paints a line between opposing lanes yellow and one between same-direction lanes white', () => {
    expect(laneLineStyle(line({}), lanesOf('rw')).color).toBe('yellow');
    const same = new Map([
      ['a', { id: 'a', dir: /** @type {const} */ ('forward'), index: 0, polygon: [], centerline: [] }],
      ['b', { id: 'b', dir: /** @type {const} */ ('forward'), index: 1, polygon: [], centerline: [] }],
    ]);
    expect(laneLineStyle(line({ left: 'b', right: 'a' }), same).color).toBe('white');
    expect(laneLineStyle(line({ left: null }), lanesOf('rw')).color).toBe('white');
  });

  it('maps types to strands', () => {
    const lanes = lanesOf('rw');
    expect(laneLineStyle(line({ type: 'solid' }), lanes).strands).toEqual([{ offset: 0, dashed: false }]);
    expect(laneLineStyle(line({ type: 'double-solid' }), lanes).strands.map((s) => s.dashed)).toEqual([false, false]);
    const mixed = laneLineStyle(line({ type: 'mixed', crossable: 'left-to-right' }), lanes).strands;
    // The left strand borders the left lane, which may cross: dashed there, solid on the right.
    expect(mixed.find((s) => s.offset > 0)?.dashed).toBe(true);
    expect(mixed.find((s) => s.offset < 0)?.dashed).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(() => laneLineStyle(line({ type: /** @type {LaneLine['type']} */ (/** @type {unknown} */ ('zigzag')) }), lanesOf('rw'))).toThrow(RangeError);
  });
});

describe('marking geometry', () => {
  it('cuts dashes at the 1:2 centre-line ratio and clips the last one', () => {
    expect(dashIntervals(20, 3, 6)).toEqual([
      [0, 3],
      [9, 12],
      [18, 20],
    ]);
    expect(dashIntervals(9.02, 3, 6)).toEqual([[0, 3]]);
    expect(() => dashIntervals(10, 0, 1)).toThrow(RangeError);
  });

  it('builds a dashed centre line of the fixture west arm', () => {
    const road = fixture.roads[0];
    const { color, quads } = laneLineQuads(road.laneLines[0], lanesOf('rw'));
    expect(color).toBe('yellow');
    expect(quads).toHaveLength(dashIntervals(96.5, CENTRE_DASH.dash, CENTRE_DASH.gap).length);
    const [a, , , d] = quads[0];
    expect(Math.hypot(a[0] - d[0], a[1] - d[1])).toBeCloseTo(LINE_WIDTH_M, 9);
  });

  it('builds two strands for the double solid north arm', () => {
    const road = fixture.roads.find((r) => r.id === 'rn');
    if (!road) throw new Error('rn');
    const { quads } = laneLineQuads(road.laneLines[0], new Map(road.lanes.map((l) => [l.id, l])));
    expect(quads).toHaveLength(2);
  });

  it('draws a give-way line dashed and a stop line solid', () => {
    const sl = fixture.stopLines[0];
    expect(stopLineQuads(sl)).toHaveLength(1);
    expect(stopLineQuads({ ...sl, control: 'give-way' }).length).toBeGreaterThan(2);
  });

  it('fills the fixture crosswalk with stripes along the travel direction', () => {
    const cw = fixture.crosswalks[0];
    const heading = nearestLaneHeading(fixture, [92, 0]);
    expect(heading).not.toBeNull();
    const stripes = crosswalkStripes(cw.polygon, /** @type {number} */ (heading));
    // 7 m across the road at 0.5 m stripe + 0.5 m gap: 7 stripes.
    expect(stripes).toHaveLength(7);
    for (const q of stripes) {
      const xs = q.map((p) => p[0]);
      expect(Math.min(...xs)).toBeCloseTo(90, 9);
      expect(Math.max(...xs)).toBeCloseTo(94, 9);
      for (const p of q) expect(Math.abs(p[1])).toBeLessThanOrEqual(3.5 + 1e-9);
    }
  });
});

describe('layout', () => {
  it('centres the finish arch across the travel heading', () => {
    const pose = finishArchPose(fixture.route.finish.polygon, 0);
    expect(pose.x).toBeCloseTo(190, 9);
    expect(pose.z).toBeCloseTo(1.75, 9);
    expect(pose.width).toBeCloseTo(3.5, 9);
  });
});
