import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { distance, polylineLength } from '../../../src/geometry/index.js';
import { buildOne, loadSignCodes, serializeMap } from '../build.js';
import {
  CONFLICT_CLEARANCE_M,
  bezierCenterline,
  buildConflicts,
  buildLaneGraph,
  classifyTurn,
  closeSpan,
  lanePairs,
} from './connectors.js';
import { compileMap } from './elements.js';
import {
  SOURCE_FREE_SPEED_KMH,
  TIME_MARGIN,
  TRAFFIC_MEAN_SPEED_KMH,
  lengthInDisc,
  mapSeed,
  maxAgentsFor,
  parseTrafficSource,
  routeThroughGraph,
  trafficConfig,
  trafficTimeLimit,
} from './traffic.js';

/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAPS = path.join(ROOT, 'data/maps');
const SHIPPED = ['osm-pasteur', 'tutorial-01-co-ban', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem'];
const TRAFFIC_MAPS = ['osm-pasteur', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem'];

/**
 * The hand-written junction fixture without its lane graph.
 * @returns {GameMap} Map.
 */
function junctionFixture() {
  const m = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/map-junction.json'), 'utf8'));
  delete m.connectors;
  delete m.conflicts;
  return m;
}

/** @type {string[]} */
let signCodes;
/** @type {Map<string, Awaited<ReturnType<typeof buildOne>>>} */
const built = new Map();

beforeAll(async () => {
  signCodes = await loadSignCodes(ROOT);
  for (const id of SHIPPED) built.set(id, await buildOne(MAPS, id, signCodes));
});

/**
 * @param {string} id Map id.
 * @returns {GameMap} Built map.
 */
function shipped(id) {
  return /** @type {NonNullable<ReturnType<typeof built.get>>} */ (built.get(id)).map;
}

describe('connector geometry', () => {
  it('classifies turns by the heading change, positive to the left', () => {
    expect(classifyTurn(0, 0.2)).toBe('straight');
    expect(classifyTurn(0, Math.PI / 2)).toBe('left');
    expect(classifyTurn(0, -Math.PI / 2)).toBe('right');
  });

  it('maps lanes kerb to kerb on the right, innermost to innermost on the left, by index straight on', () => {
    expect(lanePairs('right', 3, 2)).toEqual([[0, 0]]);
    expect(lanePairs('left', 3, 2)).toEqual([[2, 1]]);
    expect(lanePairs('straight', 3, 2)).toEqual([[0, 0], [1, 1], [2, 1]]);
    expect(lanePairs('straight', 1, 2)).toEqual([[0, 0], [0, 1]]);
  });

  it('draws a straight line for collinear ends and a near-circular arc for a right angle', () => {
    expect(bezierCenterline([0, 0], 0, [10, 0], 0)).toEqual([[0, 0], [10, 0]]);
    // A left turn of radius 7 about (0, −7): from heading east at the origin to heading north.
    const arc = bezierCenterline([0, 0], 0, [7, -7], Math.PI / 2);
    for (const p of arc) expect(Math.abs(distance(p, [0, -7]) - 7)).toBeLessThan(0.02);
    expect(() => bezierCenterline([1, 1], 0, [1, 1], 0)).toThrow(/coincide/);
  });

  it('measures the stretch of one path near another', () => {
    const span = closeSpan([[0, 0], [20, 0]], [[10, -10], [10, 10]], CONFLICT_CLEARANCE_M);
    // Within one 0.25 m sampling step of the exact 7.5..12.5 m.
    expect(Math.abs((span?.[0] ?? 0) - 7.5)).toBeLessThanOrEqual(0.25);
    expect(Math.abs((span?.[1] ?? 0) - 12.5)).toBeLessThanOrEqual(0.25);
    expect(closeSpan([[0, 0], [20, 0]], [[0, 10], [20, 10]], CONFLICT_CLEARANCE_M)).toBeNull();
  });
});

describe('lane graph of the junction fixture', () => {
  it('reproduces the fixture connectors and conflict pairs', () => {
    const m = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/map-junction.json'), 'utf8'));
    const g = buildLaneGraph(junctionFixture());
    const key = (/** @type {{id: string, turn: string, stopLineId: string | null}} */ c) => `${c.id} ${c.turn} ${c.stopLineId}`;
    expect(g.connectors.map(key).sort()).toEqual(m.connectors.map(key).sort());
    const pair = (/** @type {{a: string, b: string, kind: string}} */ c) => `${[c.a, c.b].sort().join(' ')} ${c.kind}`;
    expect(g.conflicts.map(pair).sort()).toEqual(m.conflicts.map(pair).sort());
  });

  it('yields 13 connectors at the four-way junction, each from a lane end to a lane start', () => {
    const map = junctionFixture();
    const g = buildLaneGraph(map);
    expect(g.connectors).toHaveLength(13);
    const lanes = new Map(map.roads.flatMap((r) => r.lanes.map((l) => [l.id, l])));
    for (const c of g.connectors) {
      const from = /** @type {import('../../../src/contracts/map.js').Lane} */ (lanes.get(c.fromLaneId)).centerline;
      const to = /** @type {import('../../../src/contracts/map.js').Lane} */ (lanes.get(c.toLaneId)).centerline;
      expect(distance(c.centerline[0], from[from.length - 1])).toBeLessThan(0.1);
      expect(distance(c.centerline[c.centerline.length - 1], to[0])).toBeLessThan(0.1);
    }
  });

  it('gives conflicts one entry per pair, the same spans either way round, inside each connector', () => {
    const g = buildLaneGraph(junctionFixture());
    const len = new Map(g.connectors.map((c) => [c.id, polylineLength(c.centerline)]));
    const swapped = buildConflicts([...g.connectors].reverse());
    const pairs = new Set();
    for (const c of g.conflicts) {
      const key = [c.a, c.b].sort().join(' ');
      expect(pairs.has(key)).toBe(false);
      pairs.add(key);
      for (const [from, to, id] of /** @type {const} */ ([[c.aFromS, c.aToS, c.a], [c.bFromS, c.bToS, c.b]])) {
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThanOrEqual(from);
        expect(to).toBeLessThanOrEqual(/** @type {number} */ (len.get(id)) + 1e-9);
      }
      const other = swapped.find((s) => s.a === c.a && s.b === c.b);
      expect(other && [other.aFromS, other.aToS, other.bFromS, other.bToS]).toEqual([c.aFromS, c.aToS, c.bFromS, c.bToS]);
    }
  });

  it('derives maxAgents and the time limit by their formulas', () => {
    const map = junctionFixture();
    const g = buildLaneGraph(map);
    const density = { rw: 40, re: 30, rn: 20, rs: 20 };
    // Every 150 m lane inside a huge ring: Σ density · lanes · 0.15 km = 18 + 9 + 6 + 6.
    expect(maxAgentsFor(map, density, 10_000)).toBe(39);
    // Around the route only part of each arm is inside 30 m; the cap counts the fullest position.
    expect(maxAgentsFor(map, density, 30)).toBeLessThan(39);

    // start x −150 on rw-e1 (s 7) to its end, the 14 m straight connector, re-e0 to x 145 (s 138).
    const route = routeThroughGraph(map, g);
    expect(route.lengthM).toBeCloseTo(143 + 14 + 138, 6);
    expect(route.connectorIds).toEqual(['c-rw-e1-re-e0']);
    const raw = TIME_MARGIN * (route.lengthM / (TRAFFIC_MEAN_SPEED_KMH / 3.6) + (27 + 3 + 30));
    expect(trafficTimeLimit(map, g)).toEqual({ timeLimitS: Math.ceil(raw / 10) * 10, formulaS: 170, routeM: route.lengthM });
    expect(trafficTimeLimit({ ...map, route: { ...map.route, timeLimitS: 400 } }, g).timeLimitS).toBe(400);
  });

  it('puts sources on boundary lane starts and sinks on boundary lane ends', () => {
    const map = junctionFixture();
    const src = parseTrafficSource(
      { densityPerKm: 20, spawnRingM: [60, 150], mix: [{ model: 'motorbike', share: 1 }], sourceRatePerH: { 'rn-s': 0 } },
      'test',
    );
    const t = trafficConfig(map, src, buildLaneGraph(map));
    expect(t.sources).toEqual([
      { laneId: 'rn-s', ratePerH: 0 },
      { laneId: 'rs-n', ratePerH: 20 * SOURCE_FREE_SPEED_KMH },
      { laneId: 're-w0', ratePerH: 20 * SOURCE_FREE_SPEED_KMH },
      { laneId: 'rw-e0', ratePerH: 20 * SOURCE_FREE_SPEED_KMH },
      { laneId: 'rw-e1', ratePerH: 20 * SOURCE_FREE_SPEED_KMH },
    ].sort((a, b) => (a.laneId < b.laneId ? -1 : 1)));
    expect(t.sinks).toEqual(['re-e0', 'rn-n', 'rs-s', 'rw-w0']);
    expect(t.densityPerKm).toEqual({ rw: 20, re: 20, rn: 20, rs: 20 });
    expect(t.seed).toBe(mapSeed(map.id));
    expect(() => trafficConfig(map, { ...src, sourceRatePerH: { 're-e0': 1 } }, buildLaneGraph(map))).toThrow(/not a source/);
    expect(() => trafficConfig(map, { ...src, roadDensityPerKm: { nope: 1 } }, buildLaneGraph(map))).toThrow(/unknown road/);
  });
});

describe('traffic source parsing', () => {
  it('rejects bad shares, rings and unknown keys', () => {
    const ok = { densityPerKm: 10, spawnRingM: [60, 150], mix: [{ model: 'car', share: 1 }] };
    expect(parseTrafficSource(ok, 'f').seed).toBeNull();
    expect(() => parseTrafficSource({ ...ok, mix: [{ model: 'car', share: 0.5 }] }, 'f')).toThrow(/sum to/);
    expect(() => parseTrafficSource({ ...ok, spawnRingM: [150, 60] }, 'f')).toThrow(/outer/);
    expect(() => parseTrafficSource({ ...ok, maxAgents: 3 }, 'f')).toThrow(/unknown key maxAgents/);
  });

  it('hashes map ids to stable 32-bit seeds and measures lengths inside a disc', () => {
    expect(mapSeed('')).toBe(0x811c9dc5);
    expect(mapSeed('a')).toBe(0xe40c292c);
    expect(lengthInDisc([[-20, 0], [20, 0]], [0, 0], 10)).toBeCloseTo(20, 9);
    expect(lengthInDisc([[-20, 0], [0, 0], [0, 20]], [0, 0], 10)).toBeCloseTo(20, 9);
    expect(lengthInDisc([[-20, 15], [20, 15]], [0, 0], 10)).toBe(0);
  });
});

describe('lane graph of the shipped maps', () => {
  it('adds only the lane graph to tutorial 01, which has no traffic', () => {
    const { spec, json } = /** @type {NonNullable<ReturnType<typeof built.get>>} */ (built.get('tutorial-01-co-ban'));
    const map = JSON.parse(json);
    expect(map.traffic).toBeUndefined();
    expect(map.connectors.length).toBeGreaterThan(0);
    delete map.connectors;
    delete map.conflicts;
    delete map.laneJoins;
    expect(`${JSON.stringify(map, null, 2)}\n`).toBe(serializeMap(compileMap(spec)));
  });

  it.each(TRAFFIC_MAPS)('%s changes only the lane graph, traffic and time limit', (id) => {
    const { spec, map } = /** @type {NonNullable<ReturnType<typeof built.get>>} */ (built.get(id));
    const base = JSON.parse(serializeMap(compileMap(spec)));
    const copy = structuredClone(map);
    expect(copy.route.timeLimitS).toBeGreaterThanOrEqual(base.route.timeLimitS);
    delete copy.connectors;
    delete copy.conflicts;
    delete copy.laneJoins;
    delete copy.traffic;
    copy.route.timeLimitS = base.route.timeLimitS;
    expect(copy).toEqual(base);
  });

  it('respects one-way roads, banned turns and no-entry lines on tutorial 02', () => {
    const t2 = shipped('tutorial-02-nga-tu');
    const conns = t2.connectors ?? [];
    const lanes = new Map(t2.roads.flatMap((r) => r.lanes.map((l) => [l.id, { road: r, lane: l }])));
    for (const c of conns) {
      const to = lanes.get(c.toLaneId);
      if (to?.road.oneway) expect(to.lane.dir).toBe('forward');
    }
    // P.101 closes `cam` from j3: nothing drives into its forward lane.
    expect(conns.some((c) => c.toLaneId === 'cam-f0')).toBe(false);
    expect(conns.some((c) => c.fromLaneId === 'cam-b0')).toBe(true);
    // P.123a on `tay`: no left turn from the western approach at j1; straight and right remain.
    const fromTay = conns.filter((c) => c.fromLaneId === 'tay-f0').map((c) => c.turn).sort();
    expect(fromTay).toEqual(['right', 'straight']);
    expect(conns.every((c) => c.turn !== 'uturn')).toBe(true);
    // The signalled approach links its stop line.
    expect(conns.filter((c) => c.fromLaneId === 'tay-f0').every((c) => c.stopLineId === 'sl-tay-f')).toBe(true);
  });

  it.each(TRAFFIC_MAPS)('%s makes every boundary lane end a source or a sink', (id) => {
    const map = shipped(id);
    const g = buildLaneGraph(map);
    const t = /** @type {import('../../../src/contracts/map.js').TrafficConfig} */ (map.traffic);
    const sources = t.sources.map((s) => s.laneId);
    for (const [laneId, e] of g.starts) if (e.kind === 'boundary') expect(sources).toContain(laneId);
    for (const [laneId, e] of g.ends) if (e.kind === 'boundary') expect(t.sinks).toContain(laneId);
    expect(t.maxAgents).toBe(maxAgentsFor(map, t.densityPerKm, t.spawnRingM[1]));
    expect(t.mix.find((m) => m.model === 'motorbike')?.share).toBeGreaterThanOrEqual(0.7);
  });

  it.each(SHIPPED)('%s gives every lane ending at a junction a way on, with spans inside each connector', (id) => {
    const map = shipped(id);
    const g = buildLaneGraph(map);
    const outs = new Set((map.connectors ?? []).map((c) => c.fromLaneId));
    for (const [laneId, e] of g.ends) if (e.kind === 'junction') expect(outs.has(laneId)).toBe(true);
    // Serialised values are rounded to millimetres.
    const len = new Map((map.connectors ?? []).map((c) => [c.id, polylineLength(c.centerline)]));
    for (const c of map.conflicts ?? []) {
      expect(c.aToS).toBeLessThanOrEqual(/** @type {number} */ (len.get(c.a)) + 0.002);
      expect(c.bToS).toBeLessThanOrEqual(/** @type {number} */ (len.get(c.b)) + 0.002);
    }
  });

  it('treats the unpaired lanes beside the tutorial-03 widening as tapers, not ways in or out', () => {
    const map = shipped('tutorial-03-ban-dem');
    const g = buildLaneGraph(map);
    expect(g.joins).toEqual([
      { fromLaneId: 'hep-f0', toLaneId: 'rong-f1' },
      { fromLaneId: 'rong-b1', toLaneId: 'hep-b0' },
    ]);
    expect(map.laneJoins).toEqual(g.joins);
    expect(g.starts.get('rong-f0')).toEqual({ kind: 'taper' });
    expect(g.ends.get('rong-b0')).toEqual({ kind: 'taper' });
    const t = /** @type {import('../../../src/contracts/map.js').TrafficConfig} */ (map.traffic);
    expect(t.sources.map((x) => x.laneId)).not.toContain('rong-f0');
    expect(t.sinks).not.toContain('rong-b0');
  });

  it('keeps traffic off the closed road on tutorial 02', () => {
    const t = /** @type {import('../../../src/contracts/map.js').TrafficConfig} */ (shipped('tutorial-02-nga-tu').traffic);
    expect(t.densityPerKm.cam).toBe(0);
    expect(t.sources.find((x) => x.laneId === 'cam-b0')?.ratePerH).toBe(0);
  });

  it('runs every osm-pasteur street feeding a signalled junction 120 m out, or says why not', () => {
    const { map, spec, notes } = /** @type {NonNullable<ReturnType<typeof built.get>>} */ (built.get('osm-pasteur'));
    const signalled = new Set(map.junctions.filter((j) => j.signalized).map((j) => j.id.slice(2)));
    const stubs = spec.network.ways.filter((w) => /-(in|out)$/u.test(w.id));
    let feeders = 0;
    for (const w of stubs) {
      const node = w.id.split('-')[1];
      const inbound = w.id.endsWith('-in') || !w.oneway;
      if (!signalled.has(`n${node}`) || !inbound) continue;
      feeders += 1;
      const pts = w.nodeIds.map((n) => /** @type {{pos: [number, number]}} */ (spec.network.nodes.get(n)).pos);
      const len = polylineLength(pts);
      if (len < 120 - 1e-6) expect(notes.some((n) => n.includes(`way ${w.osmWayId} at n${node}`))).toBe(true);
    }
    expect(feeders).toBeGreaterThanOrEqual(4);
    expect(map.traffic?.maxAgents).toBeLessThan(120);
  });
});
