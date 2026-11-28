import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkMap } from '../../src/contracts/assert-map.js';
import { pointInPolygon, projectOntoPolyline } from '../../src/geometry/index.js';
import { MAX_OSM_ROUTE_M, buildAll, buildOne, canonical, loadSignCodes, serializeIndex } from './build.js';
import { routeLength } from './lib/elements.js';
import { coverageReport, overpassQuery, overpassRuntimeError } from './fetch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS = path.join(ROOT, 'data/maps');
const FIXTURES = path.join(ROOT, 'scripts/maps/fixtures/maps');
const SHIPPED = ['osm-pasteur', 'tutorial-01-co-ban', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem'];

/** @typedef {import('../../src/contracts/map.js').GameMap} GameMap */

/** @type {string[]} */
let signCodes;
/** @type {Awaited<ReturnType<typeof buildAll>>} */
let shipped;

beforeAll(async () => {
  signCodes = await loadSignCodes(ROOT);
  shipped = await buildAll(MAPS, signCodes);
});

/**
 * @param {string} id Map id.
 * @returns {GameMap} Built map.
 */
function shippedMap(id) {
  return JSON.parse(/** @type {string} */ (shipped.files.get(id)));
}

describe('canonical output', () => {
  it('rounds to millimetres, keeps the origin precise, sorts keys and drops −0', () => {
    expect(JSON.stringify(canonical({ b: 1.23456, a: -0.0001, origin: { lat: 10.12345678 } }))).toBe(
      '{"a":0,"b":1.235,"origin":{"lat":10.1234568}}',
    );
    expect(() => canonical({ x: Number.NaN })).toThrow(/non-finite/);
  });

  it('keeps traffic mix shares precise enough to still sum to 1', () => {
    const mix = /** @type {{share: number}[]} */ (canonical([{ share: 0.0625 }, { share: 0.9375 }]));
    expect(mix.map((m) => m.share)).toEqual([0.0625, 0.9375]);
  });

  it('builds a map whose mix shares have more than three decimals', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'maps-mix-'));
    try {
      await cp(path.join(MAPS, 'tutorial-01-co-ban'), path.join(dir, 'tutorial-01-co-ban'), { recursive: true });
      await mkdir(path.join(dir, 'tutorial-03-ban-dem'));
      const source = await readFile(path.join(MAPS, 'tutorial-03-ban-dem/source.yaml'), 'utf8');
      const edited = source
        .replace('{ model: motorbike, share: 0.75 }', '{ model: motorbike, share: 0.6875 }')
        .replace('{ model: car, share: 0.12 }', '{ model: car, share: 0.1825 }');
      expect(edited).not.toBe(source);
      await writeFile(path.join(dir, 'tutorial-03-ban-dem/source.yaml'), edited);
      const { map } = await buildOne(dir, 'tutorial-03-ban-dem', signCodes);
      expect(map.traffic?.mix.find((m) => m.model === 'motorbike')?.share).toBe(0.6875);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fixture builds', () => {
  it('matches the snapshot for the synthetic OSM extract', async () => {
    const { json } = await buildOne(FIXTURES, 'fixture-osm', signCodes);
    expect(json).toMatchSnapshot();
  });

  it('matches the snapshot for tutorial 01', () => {
    expect(shipped.files.get('tutorial-01-co-ban')).toMatchSnapshot();
  });

  it('is byte-identical across builds', async () => {
    const again = await buildAll(MAPS, signCodes);
    expect([...again.files.keys()]).toEqual([...shipped.files.keys()]);
    for (const [id, json] of again.files) expect(json).toBe(shipped.files.get(id));
    expect(serializeIndex(again.entries)).toBe(serializeIndex(shipped.entries));
  });
});

describe('shipped maps', () => {
  it('builds exactly the four MVP maps and indexes them', () => {
    expect([...shipped.files.keys()]).toEqual(SHIPPED);
    expect(shipped.entries.map((e) => e.id)).toEqual(SHIPPED);
    for (const e of shipped.entries) expect(e.lengthM).toBeGreaterThan(100);
    expect(shipped.entries.find((e) => e.id === 'osm-pasteur')?.attribution).toBe('© OpenStreetMap contributors, ODbL');
  });

  it.each(SHIPPED)('%s passes assertMap with the sign table', (id) => {
    expect(checkMap(shippedMap(id), { signCodes })).toEqual([]);
  });

  it.each(SHIPPED)('%s has sourced, lane-bound zones and a built-up zone over its route', (id) => {
    const map = shippedMap(id);
    for (const z of map.zones) {
      expect(z.laneIds.length).toBeGreaterThan(0);
      expect(['override', 'default', 'tutorial']).toContain(z.source);
    }
    const builtUp = map.zones.filter((z) => z.type === 'built-up');
    expect(builtUp).toHaveLength(1);
    const pts = [map.route.start.pos, ...map.route.checkpoints.map((c) => c.pos)];
    for (const p of pts) expect(pointInPolygon([p.x, p.z], builtUp[0].polygon)).toBe(true);
    for (const p of map.route.finish.polygon) expect(pointInPolygon(p, builtUp[0].polygon)).toBe(true);
    for (const s of map.signs) expect(signCodes).toContain(s.code);
  });

  it.each(SHIPPED)('%s keeps every checkpoint off the lane lines between same-direction lanes', (id) => {
    const map = shippedMap(id);
    const dirOf = new Map(map.roads.flatMap((r) => r.lanes.map((l) => [l.id, l.dir])));
    for (const cp of map.route.checkpoints) {
      for (const road of map.roads) {
        for (const line of road.laneLines) {
          if (!line.left || !line.right || dirOf.get(line.left) !== dirOf.get(line.right)) continue;
          expect(projectOntoPolyline([cp.pos.x, cp.pos.z], line.polyline).distance).toBeGreaterThan(1);
        }
      }
    }
  });

  it('keeps the OSM corridor within the D1 constraint', () => {
    const map = shippedMap('osm-pasteur');
    expect(map.kind).toBe('osm');
    expect(map.attribution).toBe('© OpenStreetMap contributors, ODbL');
    expect(routeLength(map)).toBeLessThanOrEqual(MAX_OSM_ROUTE_M);
    expect(map.junctions.some((j) => j.signalized)).toBe(true);
    expect(map.crosswalks.length).toBeGreaterThan(0);
    expect(map.roads.some((r) => r.oneway && r.osmWayId !== undefined)).toBe(true);
    expect(map.zones.some((z) => z.type === 'speed-limit')).toBe(false);
  });

  it('teaches the elements each tutorial promises', () => {
    const t1 = shippedMap('tutorial-01-co-ban');
    expect(t1.zones.map((z) => z.type)).toEqual(expect.arrayContaining(['speed-limit', 'no-stopping', 'built-up']));
    expect(t1.crosswalks).toHaveLength(1);
    expect(t1.actors.map((a) => a.kind)).toEqual(['pedestrian']);
    expect(t1.obstacles.some((o) => o.kind === 'barrier')).toBe(true);
    expect(t1.roads.flatMap((r) => r.laneLines.map((l) => l.type))).toEqual(expect.arrayContaining(['dashed', 'solid']));

    const t2 = shippedMap('tutorial-02-nga-tu');
    expect(new Set(t2.stopLines.map((s) => s.control))).toEqual(new Set(['signal', 'stop-sign', 'give-way']));
    expect(t2.restrictions.flatMap((r) => r.banned).sort()).toEqual(['left', 'uturn']);
    expect(t2.entries.map((e) => e.signId).sort()).toEqual(['s-p101', 's-p102']);
    expect(t2.roads.some((r) => r.oneway)).toBe(true);

    const t3 = shippedMap('tutorial-03-ban-dem');
    expect(t3.environment).toEqual({ startClockMin: 1350, weather: 'rain', surfaceGrip: 0.7 });
    expect(t3.zones.some((z) => z.type === 'lit')).toBe(true);
    expect(t3.actors.filter((a) => a.kind === 'car')).toHaveLength(4);
    expect(t3.roads).toEqual(t1.roads);
  });

  it('puts the road works in the inner lane on tutorial 01 and in the kerb lane on tutorial 03', () => {
    const barrierZ = (/** @type {string} */ id) => {
      const ob = shippedMap(id).obstacles.find((o) => o.id === 'ob-barrier');
      if (!ob) throw new Error(`No barrier on ${id}`);
      return ob.footprint.reduce((acc, p) => acc + p[1], 0) / ob.footprint.length;
    };
    expect(barrierZ('tutorial-01-co-ban')).toBeCloseTo(1.75);
    expect(barrierZ('tutorial-03-ban-dem')).toBeCloseTo(5.25);
  });

  it('paves the corners a wide junction trim leaves between two pavement ends', () => {
    const t2 = shippedMap('tutorial-02-nga-tu');
    const paved = (/** @type {[number, number]} */ p) => t2.pavements.some((pv) => pointInPolygon(p, pv.polygon));
    // Inside the triangle between the uu-tien and mot-chieu pavement ends and the j3 chamfer, and
    // its mirror at j4 between mot-chieu and cuoi.
    expect(paved([256, -244])).toBe(true);
    expect(paved([494, -244])).toBe(true);
    const inJunction = (/** @type {[number, number]} */ p) => t2.junctions.some((j) => pointInPolygon(p, j.polygon));
    expect(inJunction([252, -248])).toBe(true);
    expect(paved([252, -248])).toBe(false);
    const corners = (/** @type {string} */ id) => shippedMap(id).pavements.filter((p) => /-c\d+$/u.test(p.id)).map((p) => p.id);
    expect(corners('tutorial-02-nga-tu')).toEqual(['pv-j-j3-c1', 'pv-j-j3-c2', 'pv-j-j3-c3', 'pv-j-j3-c4', 'pv-j-j4-c1', 'pv-j-j4-c2']);
    // Default trims leave no gap, so no corner pavement is added there.
    expect(corners('tutorial-01-co-ban')).toEqual([]);
    // The straight side of a T-junction between two nearly aligned arms is not a corner.
    expect(corners('osm-pasteur').filter((c) => c.startsWith('pv-j-n2408528251-'))).toEqual([]);
  });
});

describe('fetch helpers', () => {
  it('treats an Overpass answer with a runtime error remark as truncated', () => {
    const remark = 'runtime error: Query timed out in "print" at line 21 after 61 seconds.';
    expect(overpassRuntimeError({ elements: [{ type: 'node', id: 1 }], remark })).toBe(remark);
    expect(overpassRuntimeError({ elements: [{ type: 'node', id: 1 }] })).toBeNull();
  });

  it('queries the bbox in south,west,north,east order', () => {
    const q = overpassQuery({ south: 1, west: 2, north: 3, east: 4 });
    expect(q).toContain('(1,2,3,4)');
    expect(q).toContain('out body geom;');
  });

  it('reports tag coverage and maxspeed hints', () => {
    const lines = coverageReport({
      elements: [
        { type: 'way', id: 1, tags: { highway: 'secondary', lanes: '3', oneway: 'yes', maxspeed: '60' } },
        { type: 'way', id: 2, tags: { highway: 'residential' } },
        { type: 'node', id: 3, tags: { highway: 'traffic_signals' } },
        { type: 'node', id: 4, tags: { highway: 'crossing', crossing: 'zebra' } },
      ],
    });
    expect(lines).toContain('  lanes: 1/2');
    expect(lines).toContain('signal nodes (highway=traffic_signals): 1');
    expect(lines).toContain('  zebra: 1');
    expect(lines).toContain('  60: 1 ways');
  });
});
