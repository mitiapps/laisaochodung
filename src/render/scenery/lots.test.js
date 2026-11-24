import { describe, expect, it } from 'vitest';
import map from '../../../tests/fixtures/map-minimal.json' with { type: 'json' };
import { polygonSignedArea } from '../../geometry/index.js';
import { createStream } from '../../world/random.js';
import {
  CIVIC_COLORS,
  LANDMARK_RENDER,
  LOT_WIDTH_M,
  SHOPHOUSE_STOREYS,
  clipToStrip,
  facadeFrame,
  frontEdgeIndex,
  layoutBuilding,
  splitFrontage,
  toFrame,
} from './lots.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/map.js').Obstacle} Obstacle */
/** @typedef {import('./lots.js').ShophouseLayout} ShophouseLayout */

const fixture = /** @type {GameMap} */ (/** @type {unknown} */ (map));
const building = /** @type {Obstacle} */ (fixture.obstacles.find((o) => o.kind === 'building'));

/**
 * Shophouse layout of a building, failing the test for any other use.
 * @param {Obstacle} b Building.
 * @param {number} [index] Stream index.
 * @returns {ShophouseLayout} Layout.
 */
function rowOf(b, index = 0) {
  const layout = layoutBuilding(fixture, b, index);
  if (layout.use !== 'shophouse') throw new Error(`expected a shophouse row, got ${layout.use}`);
  return layout;
}

describe('frontage split', () => {
  it('keeps every lot within 3.5–5 m and tiles the edge with no gap or overlap', () => {
    for (const length of [7, 12, 14.2, 37.7, 50, 96.5, 160]) {
      for (let seed = 0; seed < 20; seed += 1) {
        const lots = splitFrontage(length, createStream(seed));
        expect(lots[0][0]).toBe(0);
        expect(lots.at(-1)?.[1]).toBe(length);
        for (let i = 0; i < lots.length; i += 1) {
          const w = lots[i][1] - lots[i][0];
          expect(w).toBeGreaterThanOrEqual(LOT_WIDTH_M.min - 1e-9);
          expect(w).toBeLessThanOrEqual(LOT_WIDTH_M.max + 1e-9);
          if (i > 0) expect(lots[i][0]).toBe(lots[i - 1][1]);
        }
      }
    }
  });

  it('gives one lot to a frontage too short to split', () => {
    expect(splitFrontage(3, createStream(1))).toEqual([[0, 3]]);
    expect(() => splitFrontage(0, createStream(1))).toThrow(RangeError);
  });
});

describe('front edge and frame', () => {
  it('picks the footprint edge nearest a lane when the map sets none', () => {
    // Fixture building 10..60 × 8..20 beside the east–west road at z = 0: the z = 8 edge.
    const edge = frontEdgeIndex(building, fixture);
    const a = building.footprint[edge];
    const b = building.footprint[(edge + 1) % building.footprint.length];
    expect(a[1]).toBe(8);
    expect(b[1]).toBe(8);
  });

  it('uses the map front edge and rejects one outside the footprint', () => {
    expect(frontEdgeIndex({ ...building, frontEdge: 2 }, fixture)).toBe(2);
    expect(() => frontEdgeIndex({ ...building, frontEdge: 4 }, fixture)).toThrow(RangeError);
  });

  it('points the frame outwards towards the street and measures the depth', () => {
    const f = facadeFrame(building.footprint, frontEdgeIndex(building, fixture));
    expect(f.out[0]).toBeCloseTo(0, 9);
    expect(f.out[1]).toBeCloseTo(-1, 9);
    expect(f.length).toBeCloseTo(50, 9);
    expect(f.depth).toBeCloseTo(12, 9);
    // local +Z of a frame turned by yaw is (sin yaw, cos yaw)
    expect(Math.sin(f.yaw)).toBeCloseTo(f.out[0], 9);
    expect(Math.cos(f.yaw)).toBeCloseTo(f.out[1], 9);
  });

  it('cuts a footprint into lot polygons whose areas add up', () => {
    const f = facadeFrame(building.footprint, 0);
    const parts = [
      [0, 20],
      [20, 33.5],
      [33.5, 50],
    ].map(([s0, s1]) => clipToStrip(building.footprint, f, s0, s1));
    const total = parts.reduce((sum, p) => sum + Math.abs(polygonSignedArea(p)), 0);
    expect(total).toBeCloseTo(50 * 12, 6);
    for (const p of parts[1]) expect(toFrame(f, p)[0]).toBeGreaterThanOrEqual(20 - 1e-9);
  });
});

describe('tube-house rows', () => {
  it('gives the same layout for the same map and building', () => {
    expect(rowOf(building)).toEqual(rowOf(building));
    expect(rowOf(building, 1)).not.toEqual(rowOf(building, 0));
  });

  it('never depends on the traffic seed', () => {
    const withTraffic = /** @type {GameMap} */ ({ ...fixture, traffic: { ...(fixture.traffic ?? {}), seed: 99 } });
    expect(layoutBuilding(withTraffic, building, 0)).toEqual(layoutBuilding(fixture, building, 0));
  });

  it('keeps storeys and floor heights within range', () => {
    for (let i = 0; i < 10; i += 1) {
      for (const lot of rowOf(building, i).lots) {
        expect(lot.storeys).toBeGreaterThanOrEqual(SHOPHOUSE_STOREYS.min);
        expect(lot.storeys).toBeLessThanOrEqual(SHOPHOUSE_STOREYS.max);
        expect(lot.groundM).toBeGreaterThanOrEqual(3.6);
        expect(lot.groundM).toBeLessThanOrEqual(4.2);
        expect(lot.balconyM).toBeGreaterThanOrEqual(0.6);
        expect(lot.balconyM).toBeLessThanOrEqual(1.2);
        expect(lot.ac).toHaveLength(lot.storeys - 1);
        expect(lot.heightM).toBeCloseTo(lot.groundM + (lot.storeys - 1) * lot.upperM, 9);
      }
    }
  });

  it('follows the map floor count when it is set', () => {
    for (const lot of rowOf({ ...building, floors: 2 }).lots) {
      expect(lot.storeys).toBeGreaterThanOrEqual(1);
      expect(lot.storeys).toBeLessThanOrEqual(3);
    }
  });
});

describe('lot coverage', () => {
  it('covers the whole footprint with lots, also beyond the ends of a short front edge', () => {
    /** @type {[number, number][]} */
    const outline = [[10, 8], [30, 8], [34, 10], [60, 10], [62, 24], [20, 30], [8, 20]];
    for (const frontEdge of [0, 1, 2, 3]) {
      const row = rowOf({ ...building, footprint: outline, frontEdge });
      const total = row.lots.reduce((sum, l) => sum + Math.abs(polygonSignedArea(l.polygon)), 0);
      expect(total).toBeCloseTo(Math.abs(polygonSignedArea(outline)), 6);
    }
  });
});

describe('other uses', () => {
  it('lays out civic, landmark, compound and tower buildings', () => {
    const civic = layoutBuilding(fixture, { ...building, use: 'civic', floors: 3 }, 0);
    expect(civic.use).toBe('civic');
    if (civic.use !== 'civic') throw new Error('civic');
    expect(civic.heightM).toBeCloseTo(13.5, 9);
    expect(civic.render).toBe(CIVIC_COLORS.render);
    const landmark = layoutBuilding(fixture, { ...building, use: 'landmark' }, 0);
    if (landmark.use !== 'landmark') throw new Error('landmark');
    expect(landmark.render).toBe(LANDMARK_RENDER);
    const painted = layoutBuilding(fixture, { ...building, use: 'landmark', colour: '#b5543c' }, 0);
    if (painted.use !== 'landmark') throw new Error('landmark');
    expect(painted.render).toBe(0xb5543c);
    const compound = layoutBuilding(fixture, { ...building, use: 'compound' }, 0);
    // The facade sits 8 m from the road centre: too close for a fenced forecourt.
    if (compound.use !== 'compound') throw new Error('compound');
    expect(compound.fenceM).toBeNull();
    const far = { ...building, use: /** @type {const} */ ('compound'), footprint: building.footprint.map(([x, z]) => /** @type {[number, number]} */ ([x, z + 10])) };
    const fenced = layoutBuilding(fixture, far, 0);
    if (fenced.use !== 'compound') throw new Error('compound');
    expect(fenced.fenceM).toBeGreaterThanOrEqual(1.5);
    const tower = layoutBuilding(fixture, { ...building, use: 'tower', floors: 20 }, 0);
    if (tower.use !== 'tower') throw new Error('tower');
    expect(tower.heightM).toBeGreaterThan(60);
    expect(tower.podiumM).toBeLessThan(tower.heightM);
    expect(() => layoutBuilding(fixture, { ...building, kind: 'barrier' }, 0)).toThrow(RangeError);
  });
});
