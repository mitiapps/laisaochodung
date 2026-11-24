import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkMap } from '../../../src/contracts/assert-map.js';
import { polygonsIntersect } from '../../../src/geometry/index.js';
import { buildOne, loadSignCodes, loadSpec } from '../build.js';
import { overpassQuery } from '../fetch.js';
import { topologyOf } from './elements.js';
import {
  Blockers,
  CLEAR_STRIP_M,
  PROP_SPECS,
  PropSet,
  clearWidthAt,
  fillPavements,
  parsePropList,
  placePropList,
  propFootprint,
  roadSides,
  sideCoords,
  sidePoint,
} from './props.js';
import { splitNetwork } from './graph.js';
import { LANE_WIDTH_M, band, parseLineSpec } from './lanes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAPS = path.join(ROOT, 'data/maps');
const SHIPPED = ['osm-pasteur', 'tutorial-01-co-ban', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem'];

/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('./props.js').RoadSide} RoadSide */

/**
 * Topology of one straight two-way road, 100 m along +x, with 3 m pavements.
 * @returns {import('./graph.js').Topology} Topology.
 */
function straightTopo() {
  const way = {
    id: 'w',
    nodeIds: ['a', 'b'],
    cls: 'tertiary',
    oneway: false,
    divided: false,
    priority: false,
    forward: 1,
    backward: 1,
    centerLine: parseLineSpec('dashed', 'c'),
    laneLine: parseLineSpec('dashed', 'l'),
    pavement: { left: 3, right: 3 },
  };
  const network = {
    nodes: new Map([
      ['a', { id: 'a', pos: /** @type {[number, number]} */ ([0, 0]) }],
      ['b', { id: 'b', pos: /** @type {[number, number]} */ ([100, 0]) }],
    ]),
    ways: [way],
  };
  return splitNetwork(network, { laneWidth: LANE_WIDTH_M });
}

describe('OSM fetch', () => {
  it('asks for the buildings and furniture the scenery imports', () => {
    const q = overpassQuery({ south: 1, west: 2, north: 3, east: 4 });
    for (const clause of [
      'way["building"](1,2,3,4);',
      'way["building:part"](1,2,3,4);',
      'node["natural"="tree"](1,2,3,4);',
      'node["highway"~"^(street_lamp|bus_stop)$"](1,2,3,4);',
      'node["amenity"~"^(motorcycle_parking|bench)$"](1,2,3,4);',
      'node["man_made"="street_cabinet"](1,2,3,4);',
      'way["barrier"~"^(fence|wall|gate)$"](1,2,3,4);',
    ]) {
      expect(q).toContain(clause);
    }
  });
});

describe('road sides and the clear strip', () => {
  it('measures stations and kerb distances outward on both sides', () => {
    const sides = roadSides(straightTopo());
    expect(sides.map((s) => s.id)).toEqual(['w-r', 'w-l']);
    for (const side of sides) {
      const at = sidePoint(side, 40, 1);
      const c = sideCoords(side, at.point);
      expect(c.s).toBeCloseTo(40);
      expect(c.d).toBeCloseTo(1);
    }
  });

  it('finds the widest free stretch across the pavement', () => {
    const [side] = roadSides(straightTopo());
    expect(clearWidthAt(side, [], 10)).toBe(3);
    expect(clearWidthAt(side, [{ s0: 9, s1: 11, d0: 0.3, d1: 1.5 }], 10)).toBeCloseTo(1.5);
    expect(clearWidthAt(side, [{ s0: 9, s1: 11, d0: 1, d1: 2 }], 10)).toBeCloseTo(1);
    expect(clearWidthAt(side, [{ s0: 9, s1: 11, d0: 1, d1: 2 }], 12)).toBe(3);
  });

  it('rejects a prop that narrows the pavement below the strip, touches a lane or another prop', () => {
    const sides = roadSides(straightTopo());
    const [right] = sides;
    const lanes = new Blockers();
    lanes.add(band(right.road.points, 0, 100, -LANE_WIDTH_M, LANE_WIDTH_M), 'lane w-f0');
    const set = new PropSet(sides, lanes);
    const at = (/** @type {number} */ s, /** @type {number} */ d) => sidePoint(right, s, d);
    /**
     * @param {string} id Id.
     * @param {import('../../../src/contracts/map.js').Prop['kind']} kind Kind.
     * @param {number} s Station.
     * @param {number} d Kerb distance.
     * @returns {import('../../../src/contracts/map.js').Prop} Prop.
     */
    const prop = (id, kind, s, d) => {
      const p = at(s, d);
      return { id, kind, pos: { x: p.point[0], z: p.point[1] }, heading: p.heading, solid: PROP_SPECS[kind].solid };
    };
    expect(set.problem(prop('a', 'tree', 20, 0.9))).toBeNull();
    expect(set.problem(prop('b', 'tree', 20, 1.6))).toMatch(/leaves 1\.00 m/);
    expect(set.problem(prop('c', 'tree', 20, 0.2))).toMatch(/touches lane w-f0/);
    set.add(prop('a', 'tree', 20, 0.9));
    expect(set.problem(prop('d', 'lamp', 20.5, 0.5))).toMatch(/touches prop a/);
    // A cabinet behind the tree pit leaves less than the strip between them and the back edge.
    expect(set.problem(prop('e', 'cabinet', 20, 2.2))).toMatch(/leaves/);
  });
});

describe('tutorial prop lists', () => {
  it('resolves way positions with default kerb offsets and frontage kinds behind the pavement', () => {
    const topo = straightTopo();
    const sides = roadSides(topo);
    const specs = parsePropList(
      [
        { kind: 'bus-stop', way: 'w', side: 'right', s: 30 },
        { id: 'pr-xe', kind: 'parked-motorbikes', way: 'w', side: 'left', s: 60 },
        { kind: 'tree', way: 'w', side: 'left', s: 80, offsetM: 0.8 },
      ],
      topo,
      sides,
      'f',
    );
    expect(specs.map((p) => [p.id, p.side.id, p.d])).toEqual([
      ['pr-1', 'w-r', PROP_SPECS['bus-stop'].kerbOffsetM],
      ['pr-xe', 'w-l', 3 + 0.25 + 1],
      ['pr-3', 'w-l', 0.8],
    ]);
    const set = new PropSet(sides, new Blockers());
    placePropList(set, specs, 'f');
    expect(set.props.map((p) => p.solid)).toEqual([true, true, true]);
  });

  it('fails loudly on a bad entry or one that does not fit', () => {
    const topo = straightTopo();
    const sides = roadSides(topo);
    expect(() => parsePropList([{ kind: 'bench', way: 'w', side: 'right', s: 1 }], topo, sides, 'f')).toThrow(/kind/);
    expect(() => parsePropList([{ kind: 'tree', way: 'x', side: 'right', s: 1 }], topo, sides, 'f')).toThrow(/unknown way/);
    expect(() => parsePropList([{ kind: 'tree', way: 'w', side: 'up', s: 1 }], topo, sides, 'f')).toThrow(/side/);
    expect(() => parsePropList([{ kind: 'tree', way: 'w', side: 'left', s: 1 }, { id: 'pr-1', kind: 'tree', way: 'w', side: 'left', s: 9 }], topo, sides, 'f')).toThrow(
      /duplicate id/,
    );
    const crowded = parsePropList([{ kind: 'stall', way: 'w', side: 'right', s: 10, offsetM: 1.5 }], topo, sides, 'f');
    expect(() => placePropList(new PropSet(sides, new Blockers()), crowded, 'f')).toThrow(/prop pr-1 \(stall\) leaves/);
  });

  it('fills pavements at design spacing, the same way every time', () => {
    const topo = straightTopo();
    const run = () => {
      const set = new PropSet(roadSides(topo), new Blockers());
      fillPavements(set, 'some-map', true);
      return set.props;
    };
    const a = run();
    expect(run()).toEqual(a);
    const trees = a.filter((p) => p.kind === 'tree' && p.id.includes('-w-r-')).map((p) => p.pos.x).sort((x, y) => x - y);
    expect(trees.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < trees.length; i += 1) expect(trees[i] - trees[i - 1]).toBeGreaterThanOrEqual(12 - 1e-9);
    expect(a.some((p) => p.kind === 'power-pole')).toBe(true);
    const osmLike = new PropSet(roadSides(topo), new Blockers());
    fillPavements(osmLike, 'some-map', false);
    expect(osmLike.props.some((p) => p.kind === 'power-pole')).toBe(false);
  });
});

describe('shipped map scenery', () => {
  /** @type {string[]} */
  let signCodes;
  /** @type {Map<string, GameMap>} */
  const maps = new Map();
  /** @type {Map<string, RoadSide[]>} */
  const sides = new Map();

  beforeAll(async () => {
    signCodes = await loadSignCodes(ROOT);
    for (const id of SHIPPED) {
      maps.set(id, (await buildOne(MAPS, id, signCodes)).map);
      sides.set(id, roadSides(topologyOf(await loadSpec(MAPS, id))));
    }
  });

  it.each(SHIPPED)('%s passes assertMap with its buildings and props', (id) => {
    expect(checkMap(maps.get(id), { signCodes })).toEqual([]);
  });

  it.each(SHIPPED)('%s keeps every other key byte-identical: only building fields, buildings and props are added', async (id) => {
    const bare = (await buildOne(MAPS, id, signCodes, { scenery: false })).map;
    const full = structuredClone(/** @type {GameMap} */ (maps.get(id)));
    expect(full.props?.length).toBeGreaterThan(0);
    delete full.props;
    const added = full.obstacles.filter((o) => /^bd-(osm|row)-/.test(o.id));
    expect(added.length).toBeGreaterThan(0);
    full.obstacles = full.obstacles
      .filter((o) => !added.includes(o))
      .map((o) => {
        const { use, floors, frontEdge, ...rest } = o;
        void use;
        void floors;
        void frontEdge;
        return rest;
      });
    expect(JSON.stringify(full)).toBe(JSON.stringify(bare));
  });

  it.each(SHIPPED)('%s has no prop or building on a lane or junction', (id) => {
    const map = /** @type {GameMap} */ (maps.get(id));
    const blocked = [...map.roads.flatMap((r) => r.lanes.map((l) => l.polygon)), ...map.junctions.map((j) => j.polygon)];
    for (const p of map.props ?? []) {
      const ring = propFootprint(p);
      expect(blocked.some((q) => polygonsIntersect(ring, q)), p.id).toBe(false);
    }
    for (const o of map.obstacles) {
      if (o.kind !== 'building') continue;
      expect(blocked.some((q) => polygonsIntersect(o.footprint, q)), o.id).toBe(false);
    }
  });

  it.each(SHIPPED)('%s keeps a clear walking strip on every pavement and sets solid by kind', (id) => {
    const map = /** @type {GameMap} */ (maps.get(id));
    for (const side of /** @type {RoadSide[]} */ (sides.get(id))) {
      const spans = (map.props ?? [])
        .map((p) => propFootprint(p).map((q) => sideCoords(side, q)))
        .filter((cs) => !cs.every((c) => c.s <= 1e-6) && !cs.every((c) => c.s >= side.lengthM - 1e-6))
        .map((cs) => ({
          s0: Math.min(...cs.map((c) => c.s)),
          s1: Math.max(...cs.map((c) => c.s)),
          d0: Math.min(...cs.map((c) => c.d)),
          d1: Math.max(...cs.map((c) => c.d)),
        }))
        .filter((sp) => sp.d1 > 0 && sp.d0 < side.widthM);
      for (const sp of spans) {
        for (let s = sp.s0; s <= sp.s1; s += 0.25) expect(clearWidthAt(side, spans, s)).toBeGreaterThanOrEqual(CLEAR_STRIP_M - 1e-6);
      }
    }
    for (const p of map.props ?? []) expect(p.solid).toBe(PROP_SPECS[p.kind].solid);
    expect(new Set((map.props ?? []).map((p) => p.kind))).toEqual(
      new Set(id === 'osm-pasteur' ? ['tree', 'lamp', 'bus-stop', 'cabinet', 'parked-motorbikes'] : ['tree', 'lamp', 'power-pole', 'bus-stop', 'parked-motorbikes', 'cabinet', 'bin', 'stall']),
    );
  });

  it.each(SHIPPED)('%s types every building with a use and storeys', (id) => {
    const map = /** @type {GameMap} */ (maps.get(id));
    for (const o of map.obstacles.filter((x) => x.kind === 'building')) {
      expect(o.use, o.id).toBeDefined();
      expect(Number.isInteger(o.floors) && /** @type {number} */ (o.floors) >= 1, o.id).toBe(true);
    }
  });

  it('imports the OSM buildings, landmarks, and every OSM tree and bus stop', async () => {
    const map = /** @type {GameMap} */ (maps.get('osm-pasteur'));
    const imported = map.obstacles.filter((o) => o.id.startsWith('bd-osm-'));
    expect(imported.length).toBeGreaterThanOrEqual(150);
    expect(imported.filter((o) => o.use === 'landmark').map((o) => o.id).sort()).toEqual([
      'bd-osm-w341504305',
      'bd-osm-w39514793',
      'bd-osm-w39598493',
      'bd-osm-w801950766',
    ]);
    expect(imported.some((o) => o.use === 'tower')).toBe(true);
    expect(imported.some((o) => o.use === 'civic')).toBe(true);
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(path.join(MAPS, 'osm-pasteur/raw.overpass.json'), 'utf8'));
    const ids = new Set((map.props ?? []).map((p) => p.id));
    /** @type {Array<{type: string, id: number, tags?: Record<string, string>}>} */
    const els = raw.elements;
    const trees = els.filter((e) => e.type === 'node' && e.tags?.natural === 'tree');
    const stops = els.filter((e) => e.type === 'node' && e.tags?.highway === 'bus_stop');
    expect(trees.length).toBeGreaterThan(0);
    expect(stops.length).toBeGreaterThan(0);
    for (const e of [...trees, ...stops]) expect(ids.has(`pr-osm-n${e.id}`), String(e.id)).toBe(true);
    // The OSM district has its cables underground: no power poles there.
    expect((map.props ?? []).some((p) => p.kind === 'power-pole')).toBe(false);
  });

  it('gives tutorial 03 the props of its layout, and generated rows on every tutorial', () => {
    const t1 = /** @type {GameMap} */ (maps.get('tutorial-01-co-ban'));
    const t3 = /** @type {GameMap} */ (maps.get('tutorial-03-ban-dem'));
    expect(t3.props?.some((p) => p.id === 'pr-bus-hep')).toBe(true);
    for (const id of ['tutorial-01-co-ban', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem']) {
      const rows = /** @type {GameMap} */ (maps.get(id)).obstacles.filter((o) => o.id.startsWith('bd-row-'));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.use).toBe('shophouse');
        expect(r.frontEdge).toBeDefined();
      }
    }
    expect(t1.obstacles.find((o) => o.id === 'bd-1')?.use).toBe('shophouse');
  });
});
