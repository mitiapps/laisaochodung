import { describe, expect, it } from 'vitest';
import { pointInPolygon, polylineLength } from '../../../src/geometry/index.js';
import { compileMap } from './elements.js';
import { carriageway, continuation, laneSpan, locateOnWay, splitNetwork } from './graph.js';
import { buildRoad, convexHull, growPolygon, parseLineSpec } from './lanes.js';
import { bboxCentre, createProjection } from './project.js';
import { isMarkedCrossing, tutorialSpec } from './source.js';

/** @typedef {import('./graph.js').NetWay} NetWay */
/** @typedef {import('./graph.js').Network} Network */

/**
 * @param {Partial<NetWay> & {id: string, nodeIds: string[]}} w Way fields.
 * @returns {NetWay} Way with defaults.
 */
function way(w) {
  return {
    cls: 'tertiary',
    oneway: false,
    divided: false,
    priority: false,
    forward: 1,
    backward: 1,
    centerLine: parseLineSpec('dashed', 'c'),
    laneLine: parseLineSpec('dashed', 'l'),
    pavement: { left: 3, right: 3 },
    ...w,
  };
}

/**
 * Network from node coordinates and ways.
 * @param {Record<string, [number, number]>} nodes Nodes.
 * @param {NetWay[]} ways Ways.
 * @returns {Network} Network.
 */
function net(nodes, ways) {
  return { nodes: new Map(Object.entries(nodes).map(([id, pos]) => [id, { id, pos }])), ways };
}

/**
 * A four-way crossing at the origin: west, east, north and south arms of 100 m.
 * @returns {Network} Network.
 */
function crossing() {
  return net(
    { w: [-100, 0], o: [0, 0], e: [100, 0], n: [0, -100], s: [0, 100] },
    [
      way({ id: 'we', nodeIds: ['w', 'o', 'e'] }),
      way({ id: 'ns', nodeIds: ['n', 'o', 's'] }),
    ],
  );
}

describe('projection', () => {
  it('maps the origin to zero and north to −z, east to +x', () => {
    const p = createProjection({ lat: 10, lon: 106 });
    expect(p.toXZ(10, 106)).toEqual([0, 0]);
    const [, zNorth] = p.toXZ(10.001, 106);
    expect(zNorth).toBeCloseTo(-111.2, 0);
    const [xEast] = p.toXZ(10, 106.001);
    expect(xEast).toBeCloseTo(109.5, 0);
    const back = p.toLatLon(...p.toXZ(10.0123, 106.0456));
    expect(back.lat).toBeCloseTo(10.0123, 9);
    expect(back.lon).toBeCloseTo(106.0456, 9);
  });

  it('rejects a bad bbox', () => {
    expect(bboxCentre({ south: 1, west: 2, north: 3, east: 4 })).toEqual({ lat: 2, lon: 3 });
    expect(() => bboxCentre({ south: 3, west: 2, north: 1, east: 4 })).toThrow(/south < north/);
    expect(() => bboxCentre(/** @type {never} */ ({ south: 1 }))).toThrow(/bbox.west/);
  });
});

describe('graph', () => {
  it('splits ways at junction nodes and trims roads back from them', () => {
    const topo = splitNetwork(crossing(), { laneWidth: 3.5 });
    expect(topo.junctions.map((j) => j.id)).toEqual(['j-o']);
    expect(topo.junctions[0].trimM).toBeCloseTo(4.5);
    expect(topo.roads.map((r) => r.id)).toEqual(['we-1', 'we-2', 'ns-1', 'ns-2']);
    const west = topo.roads[0];
    expect(west.s1).toBeCloseTo(95.5);
    expect(west.endJunction).toBe('j-o');
    expect(locateOnWay(topo, 'we', 50).road.id).toBe('we-1');
    expect(() => locateOnWay(topo, 'we', 100)).toThrow(/inside a junction/);
  });

  it('merges junction nodes closer than the cluster distance and drops the road between', () => {
    const n = net(
      { w: [-100, 0], a: [0, 0], b: [10, 0], e: [100, 0], an: [0, -50], bs: [10, 50] },
      [way({ id: 'main', nodeIds: ['w', 'a', 'b', 'e'] }), way({ id: 'na', nodeIds: ['an', 'a'] }), way({ id: 'sb', nodeIds: ['b', 'bs'] })],
    );
    const topo = splitNetwork(n, { laneWidth: 3.5 });
    expect(topo.junctions).toHaveLength(1);
    expect(topo.junctions[0].nodeIds).toEqual(['a', 'b']);
    expect(topo.roads.map((r) => r.id)).toEqual(['main-1', 'main-2', 'na', 'sb']);
  });

  it('fails loudly on a road shorter than its trims', () => {
    const n = net(
      { w: [-100, 0], a: [0, 0], b: [18, 0], e: [100, 0], an: [0, -50], bs: [18, 50] },
      [
        way({ id: 'main', nodeIds: ['w', 'a', 'b', 'e'], forward: 3, backward: 3 }),
        way({ id: 'na', nodeIds: ['an', 'a'] }),
        way({ id: 'sb', nodeIds: ['b', 'bs'] }),
      ],
    );
    expect(() => splitNetwork(n, { laneWidth: 3.5 })).toThrow(/way main: road main-2 is 18.0 m long/);
  });

  it('continues across a plain join but not through a junction or against a one-way road', () => {
    const n = net(
      { e: [-100, 0], a: [0, 0], b: [100, 0], c: [200, 0], d: [300, 0] },
      [
        way({ id: 'p', nodeIds: ['a', 'b'] }),
        way({ id: 'q', nodeIds: ['c', 'b'] }),
        way({ id: 'r', nodeIds: ['c', 'd'], oneway: true, backward: 0 }),
        way({ id: 't', nodeIds: ['e', 'a'], oneway: true, backward: 0 }),
      ],
    );
    const topo = splitNetwork(n, { laneWidth: 3.5 });
    const [p, q, r] = topo.roads;
    expect(continuation(topo, p, 'forward')).toEqual({ road: q, dir: 'backward' });
    expect(continuation(topo, q, 'forward')).toEqual({ road: p, dir: 'backward' });
    expect(continuation(topo, q, 'backward')).toEqual({ road: r, dir: 'forward' });
    expect(continuation(topo, r, 'forward')).toBeNull();
    expect(continuation(topo, p, 'backward')).toBeNull();
  });

  it('places lanes right of the reference line on two-way roads and centred on one-way roads', () => {
    const two = way({ id: 't', nodeIds: [], forward: 2, backward: 1 });
    expect(carriageway(two, 3.5)).toEqual({ lo: -7, hi: 3.5 });
    expect(laneSpan(two, 'forward', 0, 3.5)).toEqual({ lo: -7, hi: -3.5 });
    expect(laneSpan(two, 'backward', 0, 3.5)).toEqual({ lo: 0, hi: 3.5 });
    const one = way({ id: 'o', nodeIds: [], oneway: true, forward: 2, backward: 0 });
    expect(carriageway(one, 3.5)).toEqual({ lo: -3.5, hi: 3.5 });
    expect(() => laneSpan(one, 'backward', 0, 3.5)).toThrow(/no backward lane/);
  });
});

describe('lanes', () => {
  it('parses line specs and rejects bad ones', () => {
    expect(parseLineSpec([{ toS: 50, type: 'dashed' }, { type: 'solid' }], 'x')).toEqual([
      { fromS: 0, toS: 50, type: 'dashed', crossable: 'both' },
      { fromS: 50, toS: Infinity, type: 'solid', crossable: 'none' },
    ]);
    expect(() => parseLineSpec('zigzag', 'x')).toThrow(/unknown line type/);
    expect(() => parseLineSpec('mixed', 'x')).toThrow(/needs crossable/);
    expect(() => parseLineSpec([{ type: 'dashed' }, { type: 'solid' }], 'x')).toThrow(/increasing toS/);
  });

  it('builds lanes in travel direction and lane lines with their sides', () => {
    const n = net({ a: [0, 0], b: [100, 0] }, [
      way({ id: 'r', nodeIds: ['a', 'b'], forward: 2, backward: 1, centerLine: parseLineSpec([{ toS: 60, type: 'dashed' }, { type: 'solid' }], 'c') }),
    ]);
    const road = buildRoad(splitNetwork(n, { laneWidth: 3.5 }).roads[0]);
    const f0 = /** @type {NonNullable<ReturnType<typeof road.lanes.find>>} */ (road.lanes.find((l) => l.id === 'r-f0'));
    const b0 = /** @type {NonNullable<ReturnType<typeof road.lanes.find>>} */ (road.lanes.find((l) => l.id === 'r-b0'));
    expect(f0.centerline).toEqual([[0, 5.25], [100, 5.25]]);
    expect(b0.centerline).toEqual([[100, -1.75], [0, -1.75]]);
    expect(pointInPolygon([50, 5], f0.polygon)).toBe(true);
    expect(road.laneLines.map((l) => [l.id, l.type, l.left, l.right])).toEqual([
      ['r-lf1', 'dashed', 'r-f1', 'r-f0'],
      ['r-lc-1', 'dashed', 'r-b0', 'r-f1'],
      ['r-lc-2', 'solid', 'r-b0', 'r-f1'],
    ]);
    expect(polylineLength(road.laneLines[1].polyline)).toBeCloseTo(60);
  });

  it('computes hulls and grows polygons', () => {
    const hull = convexHull([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10], [5, 0]]);
    expect(hull).toHaveLength(4);
    const grown = growPolygon(hull, 5);
    expect(pointInPolygon([-4.5, 5], grown)).toBe(true);
    expect(pointInPolygon([-5.5, 5], grown)).toBe(false);
  });

  it('recognises marked OSM crossings only', () => {
    expect(isMarkedCrossing({ crossing: 'uncontrolled' })).toBe(true);
    expect(isMarkedCrossing({ crossing: 'traffic_signals', 'crossing:markings': 'yes' })).toBe(true);
    expect(isMarkedCrossing({ crossing: 'unmarked' })).toBe(false);
    expect(isMarkedCrossing({ crossing: 'marked', 'crossing:markings': 'no' })).toBe(false);
    expect(isMarkedCrossing({})).toBe(false);
  });
});

/**
 * Minimal tutorial source around a crossing at x = 200, with overridable parts.
 * @param {Record<string, unknown>} extra Extra or replaced keys.
 * @returns {Record<string, unknown>} Source.
 */
function tutorialSource(extra = {}) {
  return {
    kind: 'tutorial',
    name: { vi: 'Thử' },
    environment: { startClockMin: 600, weather: 'clear', surfaceGrip: 1 },
    timeLimitS: 100,
    nodes: { a: [0, 0], j: [200, 0], b: [400, 0], n: [200, -100], s: [200, 100] },
    ways: [
      { id: 'w1', nodes: ['a', 'j'] },
      { id: 'w2', nodes: ['j', 'b'] },
      { id: 'cross', nodes: ['n', 'j', 's'] },
    ],
    signs: [{ id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } }],
    route: { start: { way: 'w1', s: 20 }, finish: { way: 'w2', s: 100 } },
    ...extra,
  };
}

/**
 * @param {Record<string, unknown>} extra Source keys.
 * @returns {import('../../../src/contracts/map.js').GameMap} Built map.
 */
function compileTutorial(extra) {
  return compileMap(tutorialSpec('t', tutorialSource(extra), () => ({})));
}

describe('zones and elements', () => {
  it('ends a P.127 zone at DP.134 and at the next junction, bound to the facing lanes', () => {
    const map = compileTutorial({
      signs: [
        { id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } },
        { id: 'lim', code: 'P.127', value: 40, at: { way: 'w1', s: 50 } },
        { id: 'end', code: 'DP.134', at: { way: 'w1', s: 120 } },
        { id: 'lim2', code: 'P.127', value: 30, at: { way: 'w1', s: 150 } },
      ],
    });
    const z = /** @type {import('../../../src/contracts/map.js').Zone} */ (map.zones.find((x) => x.id === 'z-lim'));
    expect(z).toMatchObject({ type: 'speed-limit', valueKmh: 40, laneIds: ['w1-f0'], signIds: ['lim'], source: 'tutorial' });
    expect(Math.max(...z.polygon.map((p) => p[0]))).toBeCloseTo(120);
    const z2 = /** @type {import('../../../src/contracts/map.js').Zone} */ (map.zones.find((x) => x.id === 'z-lim2'));
    expect(Math.max(...z2.polygon.map((p) => p[0]))).toBeCloseTo(195.5);
    expect(map.zones.find((x) => x.type === 'built-up')?.laneIds).toHaveLength(8);
    expect(map.zones.find((x) => x.type === 'junction-buffer')?.source).toBe('default');
    expect(map.zones.some((x) => /** @type {string} */ (x.source) === 'osm')).toBe(false);
  });

  it('resolves one control per approach: lights over STOP over give-way', () => {
    const signs = [
      { id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } },
      { id: 'stop', code: 'R.122', at: { way: 'w1', s: 180 } },
      { id: 'gw', code: 'W.208', at: { way: 'w1', s: 170 } },
    ];
    const plain = compileTutorial({ signs });
    expect(plain.stopLines.map((s) => [s.id, s.control])).toEqual([['sl-w1-f', 'stop-sign']]);
    expect(plain.junctions[0].priorityRoadIds).toEqual(['cross-1', 'cross-2', 'w2']);
    const lit = compileTutorial({ signs, junctions: [{ node: 'j', signals: true }] });
    expect(lit.stopLines.every((s) => s.control === 'signal')).toBe(true);
    expect(lit.stopLines).toHaveLength(4);
    expect(lit.junctions[0]).toMatchObject({ signalized: true, priorityRoadIds: [] });
    const offsets = Object.fromEntries(lit.signals.map((s) => [s.id, s.cycle.offset]));
    expect(offsets['sig-w1-f']).toBe(offsets['sig-w2-b']);
    expect(offsets['sig-cross-1-f']).not.toBe(offsets['sig-w1-f']);
  });

  it('places the stop line before a crosswalk near the junction and ties the crosswalk to the signal', () => {
    const map = compileTutorial({ junctions: [{ node: 'j', signals: true }], crosswalks: [{ id: 'cw', at: { way: 'w1', s: 188 } }] });
    const sl = map.stopLines.find((s) => s.id === 'sl-w1-f');
    expect(sl?.segment[0][0]).toBeCloseTo(185);
    expect(map.crosswalks[0].signalId).toBe('sig-w1-f');
  });

  it('turns P.123a, P.124a, P.101 and P.102 into restrictions and entries', () => {
    const map = compileTutorial({
      signs: [
        { id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } },
        { id: 'nl', code: 'P.123a', at: { way: 'w1', s: 150 } },
        { id: 'nu', code: 'P.124a', at: { way: 'w1', s: 160 } },
        { id: 'closed', code: 'P.101', at: { way: 'w2', s: 10 } },
      ],
    });
    expect(map.restrictions).toEqual([
      { id: 'rx-nl', junctionId: 'j-j', fromLaneIds: ['w1-f0'], banned: ['left'], signId: 'nl' },
      { id: 'rx-nu', junctionId: 'j-j', fromLaneIds: ['w1-f0'], banned: ['uturn'], signId: 'nu' },
    ]);
    expect(map.entries[0]).toMatchObject({ id: 'en-closed', heading: 0, bannedClasses: ['all'], signId: 'closed' });
  });

  it('rejects maps without R.420, a start in a junction buffer and a restriction with no junction', () => {
    expect(() => compileTutorial({ signs: [] })).toThrow(/R\.420/);
    expect(() => compileTutorial({ route: { start: { way: 'w1', s: 193 }, finish: { way: 'w2', s: 100 } } })).toThrow(/junction-buffer/);
    expect(() =>
      compileTutorial({
        signs: [
          { id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } },
          { id: 'nl', code: 'P.123a', at: { way: 'w2', s: 50 } },
        ],
      }),
    ).toThrow(/not followed by a junction/);
  });

  it('builds actor paths along lanes and across crosswalks, and building rows off the road', () => {
    const map = compileTutorial({
      crosswalks: [{ id: 'cw', at: { way: 'w1', s: 100 } }],
      buildings: [{ way: 'w1', side: 'right', fromS: 10, toS: 90 }],
      actors: [
        { id: 'ped', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, speed: 1.4, path: { crosswalk: 'cw', from: 'right' }, trigger: { atS: 0 } },
        {
          id: 'car',
          kind: 'car',
          model: 'npc-sedan',
          lengthM: 4.5,
          widthM: 1.8,
          speed: 8,
          path: { lanes: [{ way: 'w2', dir: 'backward', fromS: 200, toS: 0 }, { way: 'w1', dir: 'backward', fromS: 200, toS: 0 }] },
          trigger: { way: 'w1', fromS: 30, toS: 40 },
        },
      ],
    });
    const ped = map.actors[0];
    expect(ped.path).toEqual([[100, 5.5], [100, -5.5]]);
    const car = map.actors[1];
    expect(car.path[0]).toEqual([400, -1.75]);
    expect(car.path[car.path.length - 1]).toEqual([0, -1.75]);
    expect('polygon' in car.trigger).toBe(true);
    const building = map.obstacles.find((o) => o.kind === 'building');
    expect(Math.min(...(building?.footprint ?? []).map((p) => p[1]))).toBeCloseTo(7);
    expect(() => compileTutorial({ buildings: [{ way: 'w1', side: 'right', fromS: 150, toS: 250 }] })).toThrow(/runs off way|overlaps/);
  });
});
