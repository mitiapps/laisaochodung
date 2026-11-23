import { describe, expect, it } from 'vitest';
import {
  angleDiff,
  footprint,
  headingOf,
  headingVector,
  leftVector,
  normalizeAngle,
  offsetPolyline,
  pointAtDistance,
  pointInPolygon,
  polygonCentroid,
  polygonSignedArea,
  polygonsIntersect,
  polylineLength,
  projectOntoPolyline,
  segmentCrossesPolyline,
  segmentIntersection,
  sideOf,
  slicePolyline,
} from './index.js';

/** @typedef {[number, number]} Vec2 */

/**
 * @param {Vec2} a Actual.
 * @param {Vec2} b Expected.
 */
function expectPoint(a, b) {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
}

describe('heading convention', () => {
  it('0 faces east and π/2 faces north (−z)', () => {
    expectPoint(headingVector(0), [1, 0]);
    expectPoint(headingVector(Math.PI / 2), [0, -1]);
    expect(headingOf(0, -1)).toBeCloseTo(Math.PI / 2);
    expect(headingOf(-1, 0)).toBeCloseTo(Math.PI);
  });

  it('left of east is north, left of north is west', () => {
    expectPoint(leftVector(0), [0, -1]);
    expectPoint(leftVector(Math.PI / 2), [-1, 0]);
  });

  it('wraps angles and takes the short way round', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDiff(0, -0.5)).toBeCloseTo(-0.5);
  });
});

describe('footprint', () => {
  it('orders corners front-left, front-right, rear-right, rear-left', () => {
    const fp = footprint({ x: 10, z: 0 }, 0, 4, 2);
    expectPoint(fp[0], [12, -1]);
    expectPoint(fp[1], [12, 1]);
    expectPoint(fp[2], [8, 1]);
    expectPoint(fp[3], [8, -1]);
  });
});

describe('segments', () => {
  it('reports sides with left negative-cross in this frame', () => {
    expect(sideOf([5, -1], [0, 0], [10, 0])).toBe('left');
    expect(sideOf([5, 1], [0, 0], [10, 0])).toBe('right');
    expect(sideOf([5, 0], [0, 0], [10, 0])).toBe('on');
  });

  it('intersects crossing segments and rejects disjoint ones', () => {
    const hit = segmentIntersection([0, 0], [10, 0], [5, -5], [5, 5]);
    expect(hit).not.toBeNull();
    expectPoint(/** @type {NonNullable<typeof hit>} */ (hit).point, [5, 0]);
    expect(segmentIntersection([0, 0], [10, 0], [11, -5], [11, 5])).toBeNull();
    expect(segmentIntersection([0, 0], [10, 0], [0, 1], [10, 1])).toBeNull();
  });

  it('handles collinear overlap and endpoint touch', () => {
    expect(segmentIntersection([0, 0], [10, 0], [5, 0], [15, 0])?.point).toEqual([5, 0]);
    expect(segmentIntersection([0, 0], [10, 0], [10, 0], [10, 5])).not.toBeNull();
  });

  it('detects a move crossing a polyline with the side it came from', () => {
    const line = /** @type {Vec2[]} */ ([[0, 0], [10, 0], [20, 5]]);
    const fromLeft = segmentCrossesPolyline([5, -1], [5, 1], line);
    expect(fromLeft?.fromSide).toBe('left');
    expect(fromLeft?.segmentIndex).toBe(0);
    expect(segmentCrossesPolyline([5, 1], [5, -1], line)?.fromSide).toBe('right');
    expect(segmentCrossesPolyline([5, -1], [6, -1], line)).toBeNull();
  });

  it('reports a crossing split over a point exactly on the line once', () => {
    const stopLine = /** @type {Vec2[]} */ ([[88, 0], [88, 3.5]]);
    // Southward line: east (+x) is its left side.
    const first = segmentCrossesPolyline([87.75, 1.75], [88, 1.75], stopLine);
    const second = segmentCrossesPolyline([88, 1.75], [88.25, 1.75], stopLine);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const back = [segmentCrossesPolyline([88.25, 1.75], [88, 1.75], stopLine), segmentCrossesPolyline([88, 1.75], [87.75, 1.75], stopLine)];
    expect(back.filter(Boolean)).toHaveLength(1);
    // Ending on the line from the right side reports nothing.
    expect(segmentCrossesPolyline([5, 1], [5, 0], [[0, 0], [10, 0]])).toBeNull();
  });
});

describe('polygons', () => {
  const square = /** @type {Vec2[]} */ ([[0, 0], [10, 0], [10, 10], [0, 10]]);

  it('tests containment', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true);
    expect(pointInPolygon([15, 5], square)).toBe(false);
  });

  it('computes area sign and centroid', () => {
    // [0,0] → [10,0] → [10,10] runs east then south: clockwise seen from above.
    expect(polygonSignedArea(square)).toBeCloseTo(-100);
    expect(polygonSignedArea([...square].reverse())).toBeCloseTo(100);
    expectPoint(polygonCentroid(square), [5, 5]);
  });

  it('detects overlap, containment and separation', () => {
    expect(polygonsIntersect(square, [[8, 8], [12, 8], [12, 12], [8, 12]])).toBe(true);
    expect(polygonsIntersect(square, [[2, 2], [3, 2], [3, 3], [2, 3]])).toBe(true);
    expect(polygonsIntersect([[2, 2], [3, 2], [3, 3], [2, 3]], square)).toBe(true);
    expect(polygonsIntersect(square, [[11, 0], [12, 0], [12, 1]])).toBe(false);
  });
});

describe('polylines', () => {
  const line = /** @type {Vec2[]} */ ([[0, 0], [10, 0], [10, -10]]);

  it('measures length and samples points with headings', () => {
    expect(polylineLength(line)).toBeCloseTo(20);
    const mid = pointAtDistance(line, 15);
    expectPoint(mid.point, [10, -5]);
    expect(mid.heading).toBeCloseTo(Math.PI / 2);
    expectPoint(pointAtDistance(line, -3).point, [0, 0]);
    expectPoint(pointAtDistance(line, 99).point, [10, -10]);
    expect(() => pointAtDistance([[0, 0]], 1)).toThrow(RangeError);
  });

  it('slices between distances', () => {
    const part = slicePolyline(line, 5, 15);
    expect(part).toHaveLength(3);
    expectPoint(part[0], [5, 0]);
    expectPoint(part[1], [10, 0]);
    expectPoint(part[2], [10, -5]);
  });

  it('offsets to the left with mitred joints', () => {
    const left = offsetPolyline(line, 1);
    expectPoint(left[0], [0, -1]);
    expectPoint(left[1], [9, -1]);
    expectPoint(left[2], [9, -10]);
    const right = offsetPolyline(line, -1);
    expectPoint(right[1], [11, 1]);
  });

  it('projects a point with signed lateral offset', () => {
    const p = projectOntoPolyline([4, -2], line);
    expect(p.s).toBeCloseTo(4);
    expect(p.lateral).toBeCloseTo(2);
    expect(projectOntoPolyline([4, 3], line).lateral).toBeCloseTo(-3);
    const q = projectOntoPolyline([12, -6], line);
    expect(q.s).toBeCloseTo(16);
    expect(q.heading).toBeCloseTo(Math.PI / 2);
  });
});
