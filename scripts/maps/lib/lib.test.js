import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pointInPolygon, polylineLength } from '../../../src/geometry/index.js';
import { polygonSignedArea, polygonsIntersect } from '../../../src/geometry/index.js';
import { addScenery } from '../build.js';
import {
  MAX_DROPPED_SHARE,
  cleanRing,
  frontEdgeOf,
  frontageRows,
  importOsmBuildings,
  parseLandmarks,
  shophouseFloors,
  shophouseHeight,
  typeOsmBuilding,
} from './buildings.js';
import { REPEATER_MAX_ARM_M, compileMap, topologyOf, withSolidStretches } from './elements.js';
import { Blockers, mapBlockers, roadSides } from './props.js';
import { STUB_M, carriageway, continuation, laneSpan, locateOnWay, osmCorridor, splitNetwork } from './graph.js';
import { buildRoad, convexHull, growPolygon, parseLineSpec } from './lanes.js';
import { bboxCentre, createProjection } from './project.js';
import { DEFAULT_CYCLE, isMarkedCrossing, tutorialSpec } from './source.js';

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

  it('ends a P.127 zone at the next P.127 facing the same traffic', () => {
    const map = compileTutorial({
      signs: [
        { id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } },
        { id: 'l40', code: 'P.127', value: 40, at: { way: 'w1', s: 20 } },
        { id: 'l60', code: 'P.127', value: 60, at: { way: 'w1', s: 150 } },
      ],
    });
    const z40 = /** @type {import('../../../src/contracts/map.js').Zone} */ (map.zones.find((x) => x.id === 'z-l40'));
    const z60 = /** @type {import('../../../src/contracts/map.js').Zone} */ (map.zones.find((x) => x.id === 'z-l60'));
    expect(Math.max(...z40.polygon.map((p) => p[0]))).toBeCloseTo(150);
    expect(Math.min(...z60.polygon.map((p) => p[0]))).toBeCloseTo(150);
    expect(Math.max(...z60.polygon.map((p) => p[0]))).toBeCloseTo(195.5);
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
    // An authored crosswalk stays where it is written, even 5.5 m out: it spans x 186–190 and the
    // line keeps STOP_LINE_CROSSWALK_GAP_M (2 m) before it.
    expect(sl?.segment[0][0]).toBeCloseTo(184);
    expect(map.crosswalks[0].signalId).toBe('sig-w1-f');
  });

  it('draws an OSM crossing near a junction end at the junction edge, and leaves a farther one where surveyed', () => {
    /**
     * Compiles the signalised tutorial with one OSM crossing node on w1.
     * @param {number} at Way distance of the crossing node.
     * @returns {import('../../../src/contracts/map.js').GameMap} Map.
     */
    const withOsmCrossing = (at) => {
      const spec = tutorialSpec('t', tutorialSource({ junctions: [{ node: 'j', signals: true }] }), () => ({}));
      spec.crosswalks.push({ id: 'cw-osm', at: { way: 'w1', s: at }, widthM: 4, clamp: true });
      return compileMap(spec);
    };
    const xSpan = (/** @type {import('../../../src/contracts/map.js').GameMap} */ map, /** @type {string} */ id) => {
      const cw = /** @type {import('../../../src/contracts/map.js').Crosswalk} */ (map.crosswalks.find((c) => c.id === id));
      return [Math.min(...cw.polygon.map((p) => p[0])), Math.max(...cw.polygon.map((p) => p[0]))];
    };
    // w1 ends at the junction edge x 195.5. A node at 183 (span 181–185, 10.5 m out) is the
    // junction's crosswalk: drawn at 191–195, with no derived zebra and the stop line at 189.
    const near = withOsmCrossing(183);
    const [lo, hi] = xSpan(near, 'cw-osm');
    expect(lo).toBeCloseTo(191);
    expect(hi).toBeCloseTo(195);
    expect(near.crosswalks.some((c) => c.id === 'cw-w1-e')).toBe(false);
    expect(near.stopLines.find((l) => l.id === 'sl-w1-f')?.segment[0][0]).toBeCloseTo(189);
    expect(near.crosswalks.find((c) => c.id === 'cw-osm')?.signalId).toBe('sig-w1-f');
    // A node at 170 (span 168–172, 23.5 m out) stays a mid-block crossing; the arm gets its
    // derived zebra and the stop line keeps to it.
    const far = withOsmCrossing(170);
    const [flo, fhi] = xSpan(far, 'cw-osm');
    expect(flo).toBeCloseTo(168);
    expect(fhi).toBeCloseTo(172);
    expect(far.crosswalks.find((c) => c.id === 'cw-osm')?.signalId).toBeUndefined();
    expect(far.stopLines.find((l) => l.id === 'sl-w1-f')?.segment[0][0]).toBeCloseTo(189);
  });

  it('runs the cross axis half a period later and rejects a cycle without the all-red clearance', () => {
    const map = compileTutorial({ junctions: [{ node: 'j', signals: true }] });
    const period = DEFAULT_CYCLE.green + DEFAULT_CYCLE.yellow + DEFAULT_CYCLE.red;
    expect(period).toBe(60);
    const offsets = Object.fromEntries(map.signals.map((s) => [s.id, s.cycle.offset]));
    // The first approach in id order (cross-1) sets the axis at offset 0.
    expect(offsets).toEqual({ 'sig-cross-1-f': 0, 'sig-cross-2-b': 0, 'sig-w1-f': 30, 'sig-w2-b': 30 });
    expect(map.signals[0].cycle).toMatchObject({ green: 25, yellow: 3, red: 32 });
    expect(() => compileTutorial({ junctions: [{ node: 'j', signals: { green: 27, yellow: 3, red: 30 } }] })).toThrow(/all-red/);
  });

  it('adds a 4 m crosswalk on every arm of a signalised junction with the stop line 2 m before it', () => {
    const map = compileTutorial({ junctions: [{ node: 'j', signals: true }] });
    expect(map.crosswalks.map((c) => c.id).sort()).toEqual(['cw-cross-1-e', 'cw-cross-2-s', 'cw-w1-e', 'cw-w2-s']);
    // w1 ends at the junction edge x 195.5: the crosswalk spans 191–195 and the stop line sits at 189.
    const cw = /** @type {import('../../../src/contracts/map.js').Crosswalk} */ (map.crosswalks.find((c) => c.id === 'cw-w1-e'));
    expect(Math.min(...cw.polygon.map((p) => p[0]))).toBeCloseTo(191);
    expect(Math.max(...cw.polygon.map((p) => p[0]))).toBeCloseTo(195);
    expect(map.stopLines.find((l) => l.id === 'sl-w1-f')?.segment[0][0]).toBeCloseTo(189);
    expect(cw.signalId).toBe('sig-w1-f');
    // Unsignalised, no crosswalk is derived and the stop-sign line keeps 1 m to the road end.
    const plain = compileTutorial({ signs: [{ id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } }, { id: 'stop', code: 'R.122', at: { way: 'w1', s: 180 } }] });
    expect(plain.crosswalks).toEqual([]);
    expect(plain.stopLines[0].segment[0][0]).toBeCloseTo(194.5);
  });

  it('derives no crosswalk where a written one is near or the arm is short, and logs the short arm', () => {
    const notes = /** @type {string[]} */ ([]);
    const src = tutorialSource({ junctions: [{ node: 'j', signals: true }], crosswalks: [{ id: 'cw', at: { way: 'w1', s: 188 } }] });
    src.nodes.n = [200, -18];
    const map = compileMap(tutorialSpec('t', src, () => ({})), notes);
    expect(map.crosswalks.map((c) => c.id).sort()).toEqual(['cw', 'cw-cross-2-s', 'cw-w2-s']);
    expect(notes).toEqual([expect.stringMatching(/^no derived crosswalk on road cross-1 at j-j: the road is 13\.5 m, under 20 m$/)]);
  });

  it('times the pedestrian heads of each crosswalk by a signal of the other axis', () => {
    const map = compileTutorial({ junctions: [{ node: 'j', signals: true }] });
    const walk = Object.fromEntries(map.crosswalks.map((c) => [c.id, c.walkSignalId]));
    expect(walk).toEqual({ 'cw-w1-e': 'sig-cross-1-f', 'cw-w2-s': 'sig-cross-1-f', 'cw-cross-1-e': 'sig-w1-f', 'cw-cross-2-s': 'sig-w1-f' });
  });

  it('makes the lines solid on the last 30 m before a stop line, for the approaching direction only', () => {
    const map = compileTutorial({
      junctions: [{ node: 'j', signals: true }],
      ways: [
        { id: 'w1', nodes: ['a', 'j'], lanes: { forward: 2, backward: 2 } },
        { id: 'w2', nodes: ['j', 'b'], centerLine: 'dashed' },
        { id: 'cross', nodes: ['n', 'j', 's'] },
      ],
    });
    const lines = (/** @type {string} */ id) => map.roads.find((r) => r.id === id)?.laneLines.map((l) => [l.id, l.type, l.polyline[0][0], l.polyline[l.polyline.length - 1][0]]);
    // w1 ends at x 192 at the wider junction: stop line at 185.5, solid from 155.5.
    expect(lines('w1')).toEqual([
      ['w1-lf1-1', 'dashed', 0, 155.5],
      ['w1-lf1-2', 'solid', 155.5, 192],
      ['w1-lb1', 'dashed', 0, 192],
      ['w1-lc-1', 'dashed', 0, 155.5],
      ['w1-lc-2', 'solid', 155.5, 192],
    ]);
    expect(map.roads.find((r) => r.id === 'w1')?.laneLines.find((l) => l.id === 'w1-lf1-2')?.crossable).toBe('none');
    // A written centre line is kept as written.
    expect(lines('w2')).toEqual([['w2-lc', 'dashed', 208, 400]]);
  });

  it('clamps the solid approach to 40 % of a short road', () => {
    const src = tutorialSource({ junctions: [{ node: 'j', signals: true }] });
    src.nodes.n = [200, -40];
    const map = compileTutorial({ ...src });
    // cross-1 runs 35.5 m to the junction edge: the stop line at 29 (6.5 m back), solid from 29 − 14.2.
    const solid = map.roads.find((r) => r.id === 'cross-1')?.laneLines.find((l) => l.type === 'solid');
    expect(solid?.polyline[0][1]).toBeCloseTo(-40 + 29 - 0.4 * 35.5);
  });

  it('stands a far-side repeater post across the junction, off every lane and junction', () => {
    const map = compileTutorial({ junctions: [{ node: 'j', signals: true }] });
    const sig = /** @type {import('../../../src/contracts/map.js').Signal} */ (map.signals.find((s) => s.id === 'sig-w1-f'));
    // 1.5 m past the junction edge (x 204.5), 1 m right of the eastbound lane (z 3.5).
    expect(sig.repeaters).toEqual([{ pos: { x: 206, z: 4.5 }, mount: 'post' }]);
    const blocked = [...map.roads.flatMap((r) => r.lanes.map((l) => l.polygon)), ...map.junctions.map((j) => j.polygon)];
    for (const s of map.signals) {
      expect(s.repeaters).toHaveLength(1);
      const h = /** @type {import('../../../src/contracts/map.js').SignalHead} */ (s.repeaters?.[0]);
      expect(blocked.some((poly) => pointInPolygon([h.pos.x, h.pos.z], poly))).toBe(false);
    }
  });

  it('hangs the repeater of two or more lanes from a mast arm over the lanes, at most 7 m long', () => {
    const map = compileTutorial({
      junctions: [{ node: 'j', signals: true }],
      ways: [
        { id: 'w1', nodes: ['a', 'j'], oneway: true, lanes: { forward: 4 } },
        { id: 'w2', nodes: ['j', 'b'], oneway: true, lanes: { forward: 4 } },
        { id: 'cross', nodes: ['n', 'j', 's'], oneway: true, lanes: { forward: 2 } },
      ],
    });
    const head = (/** @type {string} */ id) => /** @type {import('../../../src/contracts/map.js').SignalHead} */ (map.signals.find((s) => s.id === id)?.repeaters?.[0]);
    const two = head('sig-cross-1-f');
    expect(two.mount).toBe('mast-arm');
    // Two lanes: the head over their middle line, 4.5 m from the mast 1 m off the kerb.
    expect(two.pos.x).toBeCloseTo(200);
    expect(Math.hypot(two.pos.x - (two.mastPos?.x ?? NaN), two.pos.z - (two.mastPos?.z ?? NaN))).toBeCloseTo(4.5);
    const four = head('sig-w1-f');
    expect(four.mount).toBe('mast-arm');
    expect(Math.hypot(four.pos.x - (four.mastPos?.x ?? NaN), four.pos.z - (four.mastPos?.z ?? NaN))).toBeCloseTo(REPEATER_MAX_ARM_M);
  });

  it('drops a repeater whose base stays on a lane for 6 m and logs it', () => {
    const notes = /** @type {string[]} */ ([]);
    const src = tutorialSource({
      junctions: [{ node: 'j', signals: true }],
      ways: [
        { id: 'w1', nodes: ['a', 'j'] },
        { id: 'w2', nodes: ['j', 'b'], lanes: { forward: 3, backward: 1 } },
        { id: 'cross', nodes: ['n', 'j', 's'] },
      ],
    });
    const map = compileMap(tutorialSpec('t', src, () => ({})), notes);
    expect(map.signals.find((s) => s.id === 'sig-w1-f')?.repeaters).toBeUndefined();
    expect(notes).toContainEqual(expect.stringMatching(/^no far-side repeater for sig-w1-f at j-j: its base stays on a lane or junction/));
  });

  it('lays solid stretches over a line spec and merges equal neighbours', () => {
    const dashed = parseLineSpec('dashed', 't');
    expect(withSolidStretches(dashed, [[10, 20]])).toEqual([
      { fromS: 0, toS: 10, type: 'dashed', crossable: 'both' },
      { fromS: 10, toS: 20, type: 'solid', crossable: 'none' },
      { fromS: 20, toS: Infinity, type: 'dashed', crossable: 'both' },
    ]);
    expect(withSolidStretches(parseLineSpec('solid', 't'), [[10, 20]])).toEqual(parseLineSpec('solid', 't'));
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

  it('centres a checkpoint on its lane and requires a lane on a multi-lane direction', () => {
    const ways = [
      { id: 'w1', nodes: ['a', 'j'], lanes: { forward: 2, backward: 1 } },
      { id: 'w2', nodes: ['j', 'b'] },
      { id: 'cross', nodes: ['n', 'j', 's'] },
    ];
    const route = (/** @type {Record<string, unknown>} */ cp) => ({ start: { way: 'w1', s: 20 }, checkpoints: [cp], finish: { way: 'w2', s: 100 } });
    // Forward lanes of w1 span z 0 to 7 (+z is right of eastbound); lane 0 is next to the kerb.
    const kerb = compileTutorial({ ways, route: route({ way: 'w1', s: 100, lane: 0 }) });
    expect(kerb.route.checkpoints[0].pos).toEqual({ x: 100, z: 5.25 });
    const inner = compileTutorial({ ways, route: route({ way: 'w1', s: 100, lane: 1 }) });
    expect(inner.route.checkpoints[0].pos).toEqual({ x: 100, z: 1.75 });
    expect(() => compileTutorial({ ways, route: route({ way: 'w1', s: 100 }) })).toThrow(/checkpoint 0 needs a lane \(2 lanes\)/);
    expect(() => compileTutorial({ ways, route: route({ way: 'w1', s: 100, lane: 2 }) })).toThrow(/no forward lane 2/);
    expect(compileTutorial({ route: route({ way: 'w1', s: 100 }) }).route.checkpoints[0].pos).toEqual({ x: 100, z: 1.75 });
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

describe('scripted motorbikes and declared violations', () => {
  const lane = { way: 'w2', dir: 'backward', fromS: 200, toS: 0 };
  const runner = { id: 'runner', kind: 'motorbike', model: 'motorbike', lengthM: 1.9, widthM: 0.8, speed: 6, path: { lanes: [lane] }, trigger: { atS: 0 } };

  it('writes a motorbike and its declared violations through, and omits the list when absent', () => {
    const map = compileTutorial({
      actors: [{ ...runner, violations: ['red-light', 'unsafe-lane-change'] }, { ...runner, id: 'quiet' }],
    });
    expect(map.actors[0]).toMatchObject({ kind: 'motorbike', violations: ['red-light', 'unsafe-lane-change'] });
    expect(map.actors[1]).not.toHaveProperty('violations');
  });

  it('rejects a flag the contract does not know, and a value that is not a list', () => {
    expect(() => compileTutorial({ actors: [{ ...runner, violations: ['inattentive'] }] })).toThrow(/actors\[0\]\.violations\[0\]/);
    expect(() => compileTutorial({ actors: [{ ...runner, violations: 'red-light' }] })).toThrow(/actors\[0\]\.violations: expected a list/);
    expect(() => compileTutorial({ actors: [{ ...runner, violations: null }] })).toThrow(/expected a list/);
  });
});

describe('side-road stubs', () => {
  const proj = createProjection({ lat: 10, lon: 106 });
  /**
   * OSM way element from x/z points.
   * @param {number} id Way id.
   * @param {Array<[number, [number, number]]>} nodes Node id and position pairs.
   * @param {Record<string, string>} tags Tags.
   * @returns {import('./graph.js').OsmElement} Way.
   */
  const osmWay = (id, nodes, tags) => ({
    type: 'way',
    id,
    nodes: nodes.map(([n]) => n),
    geometry: nodes.map(([, p]) => proj.toLatLon(p[0], p[1])),
    tags,
  });
  // Route way 1 runs east through nodes 2 and 3. "Phố A" leaves node 2 northwards as way 10 and
  // continues as way 11; an unnamed lane (way 20) leaves it southwards for 40 m; "Phố B" (way 30)
  // leaves node 3 north-westwards and would cross "Phố A" about 110 m out.
  const raw = {
    elements: [
      osmWay(1, [[1, [-200, 0]], [2, [0, 0]], [3, [80, 0]], [4, [200, 0]]], { highway: 'secondary' }),
      osmWay(10, [[2, [0, 0]], [11, [0, -50]]], { highway: 'residential', name: 'Phố A' }),
      osmWay(11, [[11, [0, -50]], [12, [0, -200]]], { highway: 'residential', name: 'Phố A' }),
      osmWay(20, [[2, [0, 0]], [21, [0, 40]]], { highway: 'residential' }),
      osmWay(30, [[3, [80, 0]], [31, [-40, -110]]], { highway: 'residential', name: 'Phố B' }),
    ],
  };
  /** @type {import('./graph.js').WayAttributes} */
  const attributes = (_w, oneway) => ({
    divided: false,
    priority: false,
    forward: 1,
    backward: oneway ? 0 : 1,
    centerLine: parseLineSpec('dashed', 'c'),
    laneLine: parseLineSpec('dashed', 'l'),
    pavement: { left: 3, right: 3 },
  });
  /**
   * @param {import('./graph.js').Network} network Network.
   * @param {string} id Way id.
   * @returns {number} Way length.
   */
  const length = (network, id) => {
    const w = network.ways.find((x) => x.id === id);
    if (!w) throw new Error(`no way ${id}`);
    return polylineLength(w.nodeIds.map((n) => /** @type {{pos: [number, number]}} */ (network.nodes.get(n)).pos));
  };

  it('keeps today\'s 30 m stubs by default', () => {
    const { network, stubNotes } = osmCorridor(raw, [1], proj, attributes);
    expect(length(network, 'w10-2-out')).toBeCloseTo(STUB_M, 6);
    expect(length(network, 'w20-2-out')).toBeCloseTo(STUB_M, 6);
    expect(stubNotes).toEqual([]);
  });

  it('follows the same street to the asked length, keeps its bends, and logs short or clipped stubs', () => {
    const { network, stubNotes, stubNodeSources } = osmCorridor(raw, [1], proj, attributes, { stubM: 120, laneWidth: 3.5 });
    // Way 10 ends at 50 m; way 11 of the same name carries it on to 120 m.
    expect(length(network, 'w10-2-out')).toBeCloseTo(120, 6);
    const w10 = network.ways.find((w) => w.id === 'w10-2-out');
    expect(w10?.nodeIds).toEqual(['n2', 'n10@2-out-p1', 'n10@2-out']);
    expect(network.nodes.get('n11')).toBeUndefined();
    // A stub vertex remembers its OSM node (for tagged crossings); the cut point has none.
    expect(stubNodeSources.get('n10@2-out-p1')).toBe('n11');
    expect(stubNodeSources.has('n10@2-out')).toBe(false);
    // The unnamed lane ends at 40 m; Phố B is cut back where it would overlap Phố A.
    expect(length(network, 'w20-2-out')).toBeCloseTo(40, 6);
    const w30 = length(network, 'w30-3-out');
    expect(w30).toBeGreaterThanOrEqual(STUB_M);
    expect(w30).toBeLessThan(110);
    expect(stubNotes.map((n) => [n.osmWayId, n.side])).toEqual([[20, 'out'], [30, 'out']]);
    expect(stubNotes[0].reason).toMatch(/ends after 40 m/);
    expect(stubNotes[1].reason).toMatch(/overlaps w10-2-out/);
  });
});

describe('buildings', () => {
  it('follows the height rule: height, then levels times the storey of the type, then a type default', () => {
    expect(typeOsmBuilding({ building: 'yes', height: '13.5', heritage: 'yes' }, 800, 1, null)).toEqual({ use: 'civic', floors: 3, height: 13.5 });
    expect(typeOsmBuilding({ building: 'yes', 'building:levels': '22' }, 900, 1, null)).toEqual({ use: 'tower', floors: 22, height: 22 * 3.4 });
    expect(typeOsmBuilding({ building: 'apartments', 'building:levels': '5' }, 300, 1, null)).toEqual({ use: 'compound', floors: 5, height: 19 });
    expect(typeOsmBuilding({ building: 'civic', 'building:levels': '3' }, 3000, 1, null)).toEqual({ use: 'civic', floors: 3, height: 13.5 });
    expect(typeOsmBuilding({ building: 'roof' }, 200, 1, null)).toEqual({ use: 'compound', floors: 1, height: 4.5 });
    expect(typeOsmBuilding({ building: 'house' }, 80, 1, null)).toEqual({ use: 'shophouse', floors: 4, height: 4 * 3.4 });
    // An untagged building gets 3–5 storeys from its seed; a large one is a compound.
    for (const seed of [0, 1, 2, 3]) expect(typeOsmBuilding({ building: 'yes' }, 100, seed, null).floors).toBe(3 + (seed % 3));
    expect(typeOsmBuilding({ building: 'yes' }, 2000, 0, null).use).toBe('compound');
    // A building:part inside lifts an outline with no height of its own.
    expect(typeOsmBuilding({ building: 'church' }, 1000, 0, 18.5)).toEqual({ use: 'civic', floors: 4, height: 18.5 });
  });

  it('cleans rings to points listed once in the converter winding, and finds the street-facing edge', () => {
    const ring = cleanRing([
      [0, 0],
      [10, 0],
      [10, 0],
      [10, 8],
      [0, 8],
      [0, 0],
    ]);
    expect(ring).toHaveLength(4);
    expect(polygonSignedArea(ring)).toBeLessThan(0);
    const road = /** @type {[number, number][]} */ ([
      [-50, -5],
      [50, -5],
    ]);
    const front = /** @type {number} */ (frontEdgeOf(ring, [road]));
    const a = ring[front];
    const b = ring[(front + 1) % ring.length];
    expect(a[1]).toBe(0);
    expect(b[1]).toBe(0);
    expect(frontEdgeOf(ring, [[[-50, -500], [50, -500]]])).toBeUndefined();
    expect(shophouseHeight(4)).toBeCloseTo(13.8);
    expect(shophouseFloors(shophouseHeight(4))).toBe(4);
    expect(shophouseFloors(2)).toBe(1);
  });

  it('parses landmark overrides with a reason each', () => {
    expect(parseLandmarks([{ osm: 'way/12', heightM: 21, reason: 'r' }], 'o')).toEqual(new Map([['way/12', { heightM: 21 }]]));
    expect(parseLandmarks([{ osm: 'way/12', colour: '#b5543c', reason: 'r' }], 'o')).toEqual(new Map([['way/12', { colour: '#b5543c' }]]));
    expect(() => parseLandmarks([{ osm: 'way/12', colour: 'red', reason: 'r' }], 'o')).toThrow(/#rrggbb/);
    expect(() => parseLandmarks([{ osm: 'way/12' }], 'o')).toThrow(/reason/);
    expect(() => parseLandmarks([{ osm: 'node/12', reason: 'r' }], 'o')).toThrow(/way\/<id>/);
    expect(() => parseLandmarks([{ osm: 'way/1', reason: 'r' }, { osm: 'way/1', reason: 'r' }], 'o')).toThrow(/twice/);
  });

  it('imports OSM outlines, drops and logs those on a lane, and stops above the drop cap', () => {
    const proj = createProjection({ lat: 10, lon: 106 });
    const square = (/** @type {number} */ x, /** @type {number} */ z, /** @type {number} */ size) => {
      const pts = [
        [x, z],
        [x + size, z],
        [x + size, z + size],
        [x, z + size],
        [x, z],
      ];
      // Inverse of the projection near the origin, good to well under a millimetre here.
      return pts.map(([px, pz]) => ({ lat: 10 - pz / 111194.93, lon: 106 + px / (111194.93 * Math.cos((10 * Math.PI) / 180)) }));
    };
    const lanes = new Blockers();
    lanes.add(
      [
        [-100, -2],
        [100, -2],
        [100, 2],
        [-100, 2],
      ],
      'lane x',
    );
    /**
     * @param {number} count Buildings clear of the lane.
     * @returns {Parameters<typeof importOsmBuildings>[0]} Extract.
     */
    const raw = (count) => /** @type {Parameters<typeof importOsmBuildings>[0]} */ ({
      elements: [
        { type: 'way', id: 1, tags: { building: 'yes', name: 'On the road' }, geometry: square(0, -1, 4) },
        ...Array.from({ length: count }, (_, i) => ({ type: 'way', id: 10 + i, tags: { building: 'yes' }, geometry: square(i * 10, 10, 8) })),
        { type: 'way', id: 9, tags: { 'building:part': 'yes', height: '30' }, geometry: square(1, 11, 3) },
        { type: 'relation', id: 5, tags: { building: 'yes', height: '9' }, members: [{ type: 'way', role: 'outer', geometry: square(-30, 10, 8) }] },
      ],
    });
    /** @type {Parameters<typeof importOsmBuildings>[2]} */
    const context = { mapId: 'm', lanes, landmarks: parseLandmarks([{ osm: 'relation/5', colour: '#b5543c', reason: 'r' }], 'o'), roadLines: [[[-100, 0], [100, 0]]] };
    const { obstacles, notes } = importOsmBuildings(raw(12), proj.toXZ, context);
    expect(obstacles.map((o) => o.id)).toContain('bd-osm-r5');
    expect(obstacles.map((o) => o.id)).not.toContain('bd-osm-w1');
    expect(notes).toContain('building way/1 (On the road) overlaps lane x: dropped');
    const first = /** @type {import('../../../src/contracts/map.js').Obstacle} */ (obstacles.find((o) => o.id === 'bd-osm-w10'));
    expect(first.height).toBe(30);
    expect(first.footprint).toHaveLength(4);
    expect(first.frontEdge).toBeDefined();
    expect(obstacles.find((o) => o.id === 'bd-osm-r5')).toMatchObject({ use: 'landmark', height: 9, colour: '#b5543c' });
    expect(first.colour).toBeUndefined();
    expect(() => importOsmBuildings(raw(12), proj.toXZ, ({ ...context, landmarks: parseLandmarks([{ osm: 'way/999', reason: 'r' }], 'o') }))).toThrow(
      /landmark way\/999/,
    );
    // One dropped of seven is over the cap.
    const few = 5;
    expect(1 / (few + 2)).toBeGreaterThan(MAX_DROPPED_SHARE);
    expect(() => importOsmBuildings(raw(few), proj.toXZ, context)).toThrow(/overlap a lane or junction, over 10%/);
  });

  it('fills every free pavement edge of a tutorial with seeded shophouse rows clear of the road', () => {
    const spec = tutorialSpec('t', tutorialSource({ buildings: [{ way: 'w1', side: 'right', fromS: 10, toS: 90 }] }), () => ({}));
    const map = compileMap(spec);
    const sides = roadSides(topologyOf(spec));
    const blockers = new Blockers();
    for (const r of map.roads) for (const l of r.lanes) blockers.add(l.polygon, 'lane');
    for (const j of map.junctions) blockers.add(j.polygon, 'junction');
    for (const pv of map.pavements) blockers.add(pv.polygon, 'pavement');
    for (const o of map.obstacles) blockers.add(o.footprint, o.id);
    const { rows, forecourts } = frontageRows('t', sides, blockers, []);
    expect(rows.length).toBeGreaterThan(4);
    const again = frontageRows('t', sides, (() => {
      const b = new Blockers();
      for (const r of map.roads) for (const l of r.lanes) b.add(l.polygon, 'lane');
      for (const j of map.junctions) b.add(j.polygon, 'junction');
      for (const pv of map.pavements) b.add(pv.polygon, 'pavement');
      for (const o of map.obstacles) b.add(o.footprint, o.id);
      return b;
    })(), []);
    expect(again.rows).toEqual(rows);
    const road = [...map.roads.flatMap((r) => r.lanes.map((l) => l.polygon)), ...map.junctions.map((j) => j.polygon), ...map.pavements.map((p) => p.polygon)];
    for (const r of rows) {
      expect(road.some((q) => polygonsIntersect(r.footprint, q)), r.id).toBe(false);
      expect(r.floors).toBeGreaterThanOrEqual(3);
      expect(r.floors).toBeLessThanOrEqual(5);
      expect(r.height).toBeCloseTo(shophouseHeight(/** @type {number} */ (r.floors)));
    }
    // The written row on w1 keeps its stretch: no generated row overlaps it.
    const written = /** @type {import('../../../src/contracts/map.js').Obstacle} */ (map.obstacles.find((o) => o.kind === 'building'));
    for (const r of rows) expect(polygonsIntersect(r.footprint, written.footprint)).toBe(false);
    for (const f of forecourts) expect(rows.some((r) => r.id === f.rowId)).toBe(true);
  });

  it('types written rows and adds rows and props only through the scenery pass', () => {
    const spec = tutorialSpec('t', tutorialSource({ buildings: [{ way: 'w1', side: 'right', fromS: 10, toS: 90, heightM: 18 }] }), () => ({}));
    const map = compileMap(spec);
    const notes = addScenery(map, spec, { file: 't/source.yaml', props: [{ kind: 'bus-stop', way: 'w1', side: 'left', s: 50 }], osm: null });
    expect(map.obstacles.find((o) => o.id === 'bd-1')).toMatchObject({ use: 'shophouse', floors: 5 });
    expect(map.props?.find((p) => p.id === 'pr-1')).toMatchObject({ kind: 'bus-stop', solid: true });
    expect(notes.some((n) => n.startsWith('buildings: '))).toBe(true);
    expect(() => addScenery(compileMap(spec), spec, { file: 't/source.yaml', props: [{ kind: 'bus-stop', way: 'w1', side: 'left', s: 50, offsetM: 0 }], osm: null })).toThrow(
      /touches lane/,
    );
  });
});

describe('mapBlockers pedestrian posts', () => {
  /** @type {import('../../../src/contracts/map.js').GameMap} */
  const junction = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));

  it('blocks scenery at every pedestrian post and reports none dropped on the junction fixture', () => {
    /** @type {string[]} */
    const notes = [];
    const blockers = mapBlockers(junction, notes);
    expect(blockers.items.filter((it) => it.what === 'pedestrian post at cw-w')).toHaveLength(2);
    expect(notes).toEqual([]);
  });

  it('notes a pedestrian post dropped for standing on the carriageway', () => {
    const map = structuredClone(junction);
    map.junctions[0].polygon = [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ];
    /** @type {string[]} */
    const notes = [];
    const blockers = mapBlockers(map, notes);
    expect(blockers.items.some((it) => it.what.startsWith('pedestrian post'))).toBe(false);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/pedestrian post of crosswalk cw-w .*dropped/);
  });
});
