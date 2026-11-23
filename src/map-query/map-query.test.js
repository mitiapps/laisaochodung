import { describe, expect, it } from 'vitest';
import { mapVariant, minimalMap } from '../../scripts/rules/lib/test-support.js';
import {
  crossedLines,
  crosswalksAt,
  crosswalksOverlapping,
  distanceToPolygon,
  junctionsNear,
  laneHeadingAt,
  locate,
  mapIndex,
  pavementsAt,
  zonesAt,
} from './index.js';

const MAP = minimalMap();

describe('locate', () => {
  it('finds road, lane and direction in each lane', () => {
    expect(locate(MAP, { x: 50, z: 1.75 }, 0)).toEqual({ roadId: 'rw', laneId: 'rw-e', laneDir: 'forward', junctionId: null });
    expect(locate(MAP, [50, -1.75], Math.PI)).toEqual({ roadId: 'rw', laneId: 'rw-w', laneDir: 'backward', junctionId: null });
    expect(locate(MAP, [100, 20], Math.PI / 2).laneId).toBe('rs-n');
  });

  it('reports the junction with no lane inside it, and nothing off the map', () => {
    expect(locate(MAP, [100, 0], 0)).toEqual({ roadId: null, laneId: null, laneDir: null, junctionId: 'j1' });
    expect(locate(MAP, [500, 500], 0)).toEqual({ roadId: null, laneId: null, laneDir: null, junctionId: null });
  });

  it('gives lane travel headings from the centrelines', () => {
    expect(laneHeadingAt(MAP, 'rw-e', [40, 1.75])).toBeCloseTo(0, 12);
    expect(Math.abs(laneHeadingAt(MAP, 'rw-w', [40, -1.75]))).toBeCloseTo(Math.PI, 12);
    expect(laneHeadingAt(MAP, 'rs-n', [100, 20])).toBeCloseTo(Math.PI / 2, 12);
    expect(() => laneHeadingAt(MAP, 'nope', [0, 0])).toThrow(/Unknown lane/);
  });

  it('builds the index once per map object', () => {
    expect(mapIndex(MAP)).toBe(mapIndex(MAP));
    expect(mapIndex(minimalMap())).not.toBe(mapIndex(MAP));
  });
});

describe('zonesAt', () => {
  it('binds the P.127 zone to the eastbound lane only', () => {
    expect(zonesAt(MAP, [50, 1.75], 'rw-e').map((z) => z.id)).toEqual(['z-built-up', 'z-p127-50']);
    expect(zonesAt(MAP, [50, 1.75], 'rw-w').map((z) => z.id)).toEqual(['z-built-up']);
  });

  it('returns every containing zone when no lane is given', () => {
    expect(zonesAt(MAP, [100, 0], null).map((z) => z.id)).toEqual(['z-built-up']);
    expect(zonesAt(MAP, [300, 0], null)).toEqual([]);
  });
});

describe('crossedLines', () => {
  it('finds the stop line crossed by a move, with the side it came from', () => {
    const c = crossedLines(MAP, [87.5, 1.75], [88.5, 1.75]);
    expect(c.stopLines.map((s) => s.item.id)).toEqual(['sl-w']);
    expect(c.stopLines[0].point).toEqual([88, 1.75]);
    expect(c.laneLines).toEqual([]);
  });

  it('finds lane lines and entries, sorted along the move', () => {
    const lane = crossedLines(MAP, [50, 1], [50.5, -1]);
    expect(lane.laneLines.map((l) => [l.item.id, l.roadId, l.fromSide])).toEqual([['rw-c', 'rw', 'right']]);
    const entry = crossedLines(MAP, [100, 3], [100, 4]);
    expect(entry.entries.map((e) => e.item.id)).toEqual(['en-s']);
  });

  it('reports nothing for a standing vehicle', () => {
    expect(crossedLines(MAP, [88, 1.75], [88, 1.75])).toEqual({ laneLines: [], stopLines: [], entries: [] });
  });
});

describe('area lookups', () => {
  it('finds crosswalks and pavements', () => {
    expect(crosswalksAt(MAP, [92, 0]).map((c) => c.id)).toEqual(['cw-w']);
    expect(pavementsAt(MAP, [40, 4.5]).map((p) => p.id)).toEqual(['pv-w-south']);
    expect(pavementsAt(MAP, [40, 1.75])).toEqual([]);
    /** @type {[number, number][]} */
    const fp = [[91, 1], [91, 2.5], [86.5, 2.5], [86.5, 1]];
    expect(crosswalksOverlapping(MAP, fp).map((c) => c.id)).toEqual(['cw-w']);
    expect(crosswalksOverlapping(MAP, fp.map(([x, z]) => /** @type {[number, number]} */ ([x - 2, z])))).toEqual([]);
  });

  it('measures the 5 m junction range from the polygon edge', () => {
    const j = MAP.junctions[0].polygon;
    expect(distanceToPolygon([91.5, 1], j)).toBeCloseTo(5, 12);
    expect(distanceToPolygon([100, 0], j)).toBe(0);
    expect(junctionsNear(MAP, [[91.4, 1]], 5)).toEqual([]);
    expect(junctionsNear(MAP, [[91.5, 1]], 5).map((x) => x.id)).toEqual(['j1']);
  });

  it('works on a variant map with extra elements', () => {
    const map = mapVariant((m) => {
      m.zones.push({ id: 'z-p130', type: 'no-stopping', polygon: [[20, 0], [30, 0], [30, 3.5], [20, 3.5]], laneIds: ['rw-e'], signIds: [], source: 'tutorial' });
    });
    expect(zonesAt(map, [25, 1], 'rw-e').map((z) => z.type)).toEqual(['built-up', 'speed-limit', 'no-stopping']);
  });
});
