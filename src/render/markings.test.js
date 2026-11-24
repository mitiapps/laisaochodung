import { describe, expect, it } from 'vitest';
import map from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import {
  CENTRE_DASH,
  LANE_DASH,
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
    // 7 m across the road at 0.4 m stripe + 0.6 m gap: 7 stripes.
    expect(stripes).toHaveLength(7);
    for (const q of stripes) {
      const xs = q.map((p) => p[0]);
      expect(Math.min(...xs)).toBeCloseTo(90, 9);
      expect(Math.max(...xs)).toBeCloseTo(94, 9);
      for (const p of q) expect(Math.abs(p[1])).toBeLessThanOrEqual(3.5 + 1e-9);
    }
  });
});

/**
 * Length of a quad side.
 * @param {[number, number][]} q Quad.
 * @param {number} i Side from corner `i` to corner `i + 1`.
 * @returns {number} Length.
 */
function side(q, i) {
  const a = q[i];
  const b = q[(i + 1) % q.length];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

describe('QCVN 41:2024 Phụ lục G sizes, read from the built quads', () => {
  const lanes = lanesOf('rw');

  it('paints lane and centre lines 15 cm wide with 1–3 m dashes', () => {
    for (const type of /** @type {const} */ (['dashed', 'solid', 'double-solid'])) {
      for (const q of laneLineQuads(line({ type }), lanes).quads) expect(side(q, 1)).toBeCloseTo(0.15, 9);
    }
    const centre = laneLineQuads(line({}), lanes).quads;
    expect(side(centre[0], 0)).toBeGreaterThanOrEqual(1);
    expect(side(centre[0], 0)).toBeLessThanOrEqual(3);
    // Gap between the first two dashes: 2–6 m at 1:2 for vạch 1.1.
    const gap = centre[1][0][0] - centre[0][1][0];
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(gap).toBeLessThanOrEqual(6);
    expect(side(centre[0], 0) / gap).toBeCloseTo(1 / 2, 9);
    // Vạch 2.1: 3–9 m gaps at 1:3.
    expect(LANE_DASH.gap).toBeGreaterThanOrEqual(3);
    expect(LANE_DASH.gap).toBeLessThanOrEqual(9);
    expect(LANE_DASH.dash / LANE_DASH.gap).toBeCloseTo(1 / 3, 9);
  });

  it('separates the two yellow strands of vạch 1.3 by a 15–50 cm inner gap', () => {
    const { color, quads } = laneLineQuads(line({ type: 'double-solid' }), lanes);
    expect(color).toBe('yellow');
    const zs = quads.map((q) => (q[0][1] + q[3][1]) / 2).sort((a, b) => a - b);
    const inner = zs[1] - zs[0] - 0.15;
    expect(inner).toBeGreaterThanOrEqual(0.15 - 1e-9);
    expect(inner).toBeLessThanOrEqual(0.5);
  });

  it('draws the stop line 30 cm wide and zebra stripes 40 cm wide with 60 cm gaps', () => {
    const [stop] = stopLineQuads(fixture.stopLines[0]);
    expect(Math.min(side(stop, 0), side(stop, 1))).toBeCloseTo(0.3, 9);
    const heading = /** @type {number} */ (nearestLaneHeading(fixture, [92, 0]));
    const stripes = crosswalkStripes(fixture.crosswalks[0].polygon, heading);
    for (const q of stripes) expect(Math.min(side(q, 0), side(q, 1))).toBeCloseTo(0.4, 9);
    const across = stripes.map((q) => Math.min(...q.map((p) => p[1]))).sort((a, b) => a - b);
    expect(across[1] - across[0] - 0.4).toBeCloseTo(0.6, 9);
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
