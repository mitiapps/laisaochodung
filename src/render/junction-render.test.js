import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';
import junction from '../../tests/fixtures/map-junction.json' with { type: 'json' };
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import minimal from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import { headingVector, leftVector, pointInPolygon } from '../geometry/index.js';
import { signalState } from '../world/index.js';
import {
  GIVE_WAY,
  GIVE_WAY_TRIANGLE,
  LANE_ARROW,
  LANE_DASH,
  LINE_WIDTH_M,
  STOP_LINE_WIDTH_M,
  STOP_WORD,
  giveWayTriangleQuads,
  keptIntervals,
  laneArrowRings,
  laneLineQuads,
  laneStations,
  lineCuts,
  nearEdgeM,
  stopLineQuads,
  stopWordQuads,
} from './markings.js';
import { buildRoadMeshes } from './road-mesh.js';
import { LOWEST_LAMP_Y_M, REPEATER_COUNTDOWN_SCALE, buildTrafficLights, headPlacements } from './traffic-lights.js';
import { buildRouteMarkers, markedCheckpoint } from './route-markers.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {import('../contracts/map.js').StopLine} StopLine */
/** @typedef {import('../contracts/map.js').LaneArrow} LaneArrow */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').LightState} LightState */
/** @typedef {[number, number]} Vec2 */

const MAP = /** @type {GameMap} */ (/** @type {unknown} */ (junction));
const MINIMAL = /** @type {GameMap} */ (/** @type {unknown} */ (minimal));
const FRAMES = /** @type {Frame[]} */ (/** @type {unknown} */ (frames));

/**
 * Deep copy of the junction fixture.
 * @returns {GameMap} Map.
 */
const clone = () => /** @type {GameMap} */ (structuredClone(MAP));

/**
 * Every lane of a map by id.
 * @param {GameMap} map Map.
 * @returns {Map<string, Lane>} Lanes.
 */
const lanesOf = (map) => new Map(map.roads.flatMap((r) => r.lanes.map((l) => /** @type {[string, Lane]} */ ([l.id, l]))));

/**
 * A stop line of a map by id.
 * @param {GameMap} map Map.
 * @param {string} id Id.
 * @returns {StopLine} Stop line.
 */
function stopLine(map, id) {
  const sl = map.stopLines.find((s) => s.id === id);
  if (!sl) throw new Error(id);
  return sl;
}

/**
 * Lane-line quads of every line of a road, drawn with the map's cuts.
 * @param {GameMap} map Map.
 * @param {string} roadId Road id.
 * @returns {Vec2[][]} Quads.
 */
function roadLineQuads(map, roadId) {
  const cuts = lineCuts(map);
  const road = map.roads.find((r) => r.id === roadId);
  if (!road) throw new Error(roadId);
  const lanes = new Map(road.lanes.map((l) => [l.id, l]));
  return road.laneLines.flatMap((line) => laneLineQuads(line, lanes, cuts.get(roadId)).quads);
}

/**
 * Lane-local coordinates of a point: metres ahead of `origin` along `heading`, and to its left.
 * @param {Vec2} p Point.
 * @param {Vec2} origin Origin.
 * @param {number} heading Heading.
 * @returns {Vec2} `[u, v]`.
 */
function local(p, origin, heading) {
  const f = headingVector(heading);
  const l = leftVector(heading);
  const d = [p[0] - origin[0], p[1] - origin[1]];
  return [d[0] * f[0] + d[1] * f[1], d[0] * l[0] + d[1] * l[1]];
}

/**
 * The junction fixture with every lane line solid, so line ends are exact.
 * @returns {GameMap} Map.
 */
function solidLines() {
  const map = clone();
  for (const road of map.roads) for (const line of road.laneLines) line.type = 'solid';
  return map;
}

describe('lane and centre lines at stop lines and zebras', () => {
  it('ends every line of an approach at the stop line, with nothing painted through the zebra', () => {
    for (const road of MAP.roads) {
      const quads = roadLineQuads(MAP, road.id);
      expect(quads.length, road.id).toBeGreaterThan(0);
      for (const q of quads) {
        for (const cw of MAP.crosswalks) {
          const centre = /** @type {Vec2} */ ([(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2]);
          expect(pointInPolygon(centre, /** @type {Vec2[]} */ (cw.polygon)), road.id).toBe(false);
        }
      }
    }
    // West approach: the stop line's near edge is at x = −9.15; both lines (the lane divider and
    // the centre line touching the stop line's end) stop there.
    const solid = solidLines();
    const west = roadLineQuads(solid, 'rw').flat();
    for (const z of [0, 3.5]) {
      const xs = west.filter((p) => Math.abs(p[1] - z) <= LINE_WIDTH_M / 2 + 1e-9).map((p) => p[0]);
      expect(Math.max(...xs), `line at z ${z}`).toBeCloseTo(-9 - STOP_LINE_WIDTH_M / 2, 6);
    }
    // North approach (no zebra): its centre line also ends at the stop line.
    const north = roadLineQuads(solid, 'rn').flat();
    expect(Math.max(...north.map((p) => p[1]))).toBeCloseTo(-9 - STOP_LINE_WIDTH_M / 2, 6);
    // East road: its centre line ends at its own westbound stop line (x 9 + 0.15); the west
    // approach's cut, which reaches x 10.85 along z 0, belongs to another road and is not applied.
    const east = roadLineQuads(solid, 're').flat();
    expect(Math.min(...east.map((p) => p[0]))).toBeCloseTo(9 + STOP_LINE_WIDTH_M / 2, 6);
  });

  it('ends the lines at the zebra edge where there is no stop line, leaving no stub by the junction', () => {
    const map = solidLines();
    map.stopLines = map.stopLines.filter((s) => s.id !== 'sl-w');
    const west = roadLineQuads(map, 'rw').flat();
    expect(Math.max(...west.map((p) => p[0]))).toBeCloseTo(-8.75, 6);
    expect(keptIntervals([[0, 0], [10, 0]], [[[4, -1], [5, -1], [5, 1], [4, 1]], [[9.5, -1], [11, -1], [11, 1], [9.5, 1]]])).toEqual([
      [0, 4],
      [5, 9.5],
    ]);
  });

  it('keeps the dash phase of the whole line on the painted part', () => {
    const map = clone();
    const road = map.roads.find((r) => r.id === 'rw');
    if (!road) throw new Error('rw');
    const lanes = new Map(road.lanes.map((l) => [l.id, l]));
    // A lane divider whose last dash, x −11 to −9, runs over the stop line's near edge.
    const line = { ...road.laneLines[0], polyline: /** @type {Vec2[]} */ ([[-155, 3.5], [-7, 3.5]]) };
    expect(line.type).toBe('dashed');
    const whole = laneLineQuads(line, lanes).quads;
    const cut = laneLineQuads(line, lanes, lineCuts(map).get('rw')).quads;
    expect(cut).toHaveLength(whole.length);
    expect(cut.slice(0, -1)).toEqual(whole.slice(0, -1));
    const last = cut[cut.length - 1].map((p) => p[0]);
    expect(Math.min(...last)).toBeCloseTo(-9 - STOP_LINE_WIDTH_M / 2 - LANE_DASH.dash + 0.15, 9);
    expect(Math.max(...last)).toBeCloseTo(-9 - STOP_LINE_WIDTH_M / 2, 9);
  });
});

describe('STOP word and give-way marking', () => {
  it('writes STOP in each lane of a stop-sign line, read from the driver seat, its top 2.5 m before the line', () => {
    const map = clone();
    const sl = stopLine(map, 'sl-n');
    sl.control = 'stop-sign';
    delete sl.signalId;
    const [station, ...rest] = laneStations(sl, lanesOf(map));
    expect(rest).toHaveLength(0);
    expect(station.point[0]).toBeCloseTo(-1.75, 9);
    expect(station.point[1]).toBeCloseTo(-9, 9);
    const quads = stopWordQuads(station, nearEdgeM(sl));
    const pts = quads.flat().map((p) => local(p, station.point, station.heading));
    const us = pts.map((p) => p[0]);
    const top = -(STOP_LINE_WIDTH_M / 2 + STOP_WORD.setback);
    expect(Math.max(...us)).toBeCloseTo(top, 9);
    expect(Math.min(...us)).toBeCloseTo(top - STOP_WORD.height, 9);
    expect(Math.max(...pts.map((p) => Math.abs(p[1])))).toBeLessThanOrEqual(station.width / 2);
    // S (first five strokes) on the driver's left, P (last four) on the right.
    const meanV = (/** @type {Vec2[][]} */ qs) => {
      const vs = qs.flat().map((p) => local(p, station.point, station.heading)[1]);
      return vs.reduce((a, b) => a + b, 0) / vs.length;
    };
    expect(meanV(quads.slice(0, 5))).toBeGreaterThan(0);
    expect(meanV(quads.slice(-4))).toBeLessThan(0);
    // The T's bar, its sixth stroke, lies at the top, towards the line.
    const bar = quads[5].map((p) => local(p, station.point, station.heading)[0]);
    expect(Math.max(...bar)).toBeCloseTo(top, 9);
    expect(Math.min(...bar)).toBeCloseTo(top - STOP_WORD.stroke, 9);
  });

  it('paints vạch 7.2 Mẫu 1: two dashed 20 cm lines and one inverted triangle per lane', () => {
    const map = clone();
    const sl = stopLine(map, 'sl-w');
    sl.control = 'give-way';
    delete sl.signalId;
    const line = stopLineQuads(sl);
    // 7 m of line: dashes start every 0.8 m, so 9 dashes per strand.
    expect(line).toHaveLength(18);
    const xs = [...new Set(line.flat().map((p) => Math.round(p[0] * 1000) / 1000))].sort((a, b) => a - b);
    expect(xs).toEqual([-9.3, -9.1, -8.9, -8.7]);
    const first = line[0].map((p) => p[1]);
    expect(Math.max(...first) - Math.min(...first)).toBeCloseTo(GIVE_WAY.dash, 9);

    // The lane and centre lines stop at the give-way line's painted near edge.
    const road = map.roads.find((r) => r.id === 'rw');
    if (!road) throw new Error('rw');
    for (const l of road.laneLines) l.type = 'solid';
    const ends = roadLineQuads(map, 'rw').flat().map((p) => p[0]);
    expect(Math.max(...ends)).toBeCloseTo(-9 - nearEdgeM(sl), 9);
    expect(nearEdgeM(sl)).toBeCloseTo(0.3, 9);

    const stations = laneStations(sl, lanesOf(map));
    expect(stations).toHaveLength(2);
    for (const station of stations) {
      const tri = giveWayTriangleQuads(station, nearEdgeM(sl));
      expect(tri).toHaveLength(3);
      const pts = tri.flat().map((p) => local(p, station.point, station.heading));
      const base = -(GIVE_WAY.spacing / 2 + GIVE_WAY.width / 2 + GIVE_WAY_TRIANGLE.setback);
      expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(base, 9);
      expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(base - GIVE_WAY_TRIANGLE.length, 9);
      expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(GIVE_WAY_TRIANGLE.base / 2, 9);
    }
  });

  it('adds the STOP word, the triangles and the arrows to the white paint of the road mesh', () => {
    const bare = clone();
    delete bare.laneArrows;
    const plain = buildRoadMeshes(bare);
    const arrows = buildRoadMeshes(MAP);
    expect(arrows.triangles.white).toBeGreaterThan(plain.triangles.white);
    const marked = clone();
    for (const id of ['sl-n', 'sl-s']) {
      const sl = stopLine(marked, id);
      sl.control = id === 'sl-n' ? 'stop-sign' : 'give-way';
      delete sl.signalId;
    }
    const painted = buildRoadMeshes(marked);
    expect(painted.triangles.white).toBeGreaterThan(arrows.triangles.white);
    for (const r of [plain, arrows, painted]) r.dispose();
  });
});

describe('lane arrows', () => {
  /** @type {LaneArrow['turns'][]} */
  const subsets = [];
  const all = /** @type {const} */ (['straight', 'left', 'right', 'uturn']);
  for (let mask = 1; mask < 16; mask += 1) subsets.push(all.filter((_, i) => mask & (1 << i)));

  it.each(subsets.map((t) => [t.join('+'), t]))('draws %s with its tip on pos, 3.0 m long or 3.2 m combined', (_, turns) => {
    const arrow = { id: 'a', laneId: 'rw-e0', pos: { x: 3, z: -2 }, heading: 0.7, turns };
    const pts = laneArrowRings(arrow)
      .flat()
      .map((p) => local(p, [3, -2], 0.7));
    const us = pts.map((p) => p[0]);
    // The U-turn hook is a polygonal arc, so its outer edge may stand a couple of millimetres out.
    expect(Math.max(...us)).toBeCloseTo(0, 2);
    expect(Math.max(...us)).toBeLessThan(0.005);
    expect(Math.min(...us)).toBeCloseTo(turns.length > 1 ? -LANE_ARROW.combinedLength : -LANE_ARROW.length, 9);
    const vs = pts.map((p) => p[1]);
    if (turns.includes('left') || turns.includes('uturn')) expect(Math.max(...vs)).toBeGreaterThan(0.5);
    else expect(Math.max(...vs)).toBeLessThan(LANE_ARROW.headWidth / 2 + 1e-9);
    if (turns.includes('right')) expect(Math.min(...vs)).toBeLessThan(-0.5);
    else expect(Math.min(...vs)).toBeGreaterThan(-LANE_ARROW.headWidth / 2 - 1e-9);
  });

  it('turns the fixture arrows the right way round on the map', () => {
    const [right, left] = /** @type {LaneArrow[]} */ (MAP.laneArrows);
    expect(right.turns).toEqual(['straight', 'right']);
    expect(left.turns).toEqual(['straight', 'left']);
    // Heading 0 runs along +x, so the left of the traffic is −z.
    const rz = laneArrowRings(right).flat().map((p) => p[1]);
    const lz = laneArrowRings(left).flat().map((p) => p[1]);
    expect(Math.max(...rz)).toBeGreaterThan(right.pos.z + 0.5);
    expect(Math.min(...lz)).toBeLessThan(left.pos.z - 0.5);
  });
});

/**
 * Meshes under a group.
 * @param {import('three').Object3D} group Group.
 * @returns {Mesh[]} Meshes.
 */
function meshes(group) {
  /** @type {Mesh[]} */
  const out = [];
  group.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

/**
 * Lamp mesh by name.
 * @param {Mesh[]} list Meshes.
 * @param {string} name Name.
 * @returns {Mesh} Mesh.
 */
function lamp(list, name) {
  const m = list.find((x) => x.name === name);
  if (!m) throw new Error(name);
  return m;
}

describe('far-side signal heads', () => {
  it('stands post repeaters at 2.5 m and hangs mast-arm repeaters at 5.5 m, with no pole under the arm head', () => {
    const heads = headPlacements(MAP);
    expect(heads).toHaveLength(8);
    expect(heads.slice(0, 4).map((h) => h.name)).toEqual(MAP.signals.map((s) => s.id));
    const lights = buildTrafficLights(MAP);
    const list = meshes(lights.group);
    expect(list.filter((m) => m.name.startsWith('lamp-'))).toHaveLength(24);
    expect(lamp(list, 'lamp-sig-w-r0-green').position.y).toBeCloseTo(LOWEST_LAMP_Y_M.cantilever, 9);
    expect(lamp(list, 'lamp-sig-e-r0-green').position.y).toBeCloseTo(LOWEST_LAMP_Y_M.side, 9);
    expect(lamp(list, 'lamp-sig-w-green').position.y).toBeCloseTo(LOWEST_LAMP_Y_M.side, 9);

    const body = lamp(list, 'signal-bodies').geometry.getAttribute('position');
    let atMast = 0;
    let underHead = 0;
    for (let i = 0; i < body.count; i += 1) {
      if (Math.abs(body.getY(i)) > 1e-9) continue;
      if (Math.hypot(body.getX(i) - 8.5, body.getZ(i) - 5) < 0.2) atMast += 1;
      if (Math.hypot(body.getX(i) - 8.5, body.getZ(i) - 3.5) < 0.3) underHead += 1;
    }
    expect(atMast).toBeGreaterThan(0);
    expect(underHead).toBe(0);
    lights.dispose();
  });

  it('shows the signal lamps and countdown on every head, 1.5 × larger on far heads', () => {
    const t = 0;
    /** @type {Record<string, LightState>} */
    const states = Object.fromEntries(MAP.signals.map((s) => [s.id, signalState(s, t)]));
    expect(new Set(Object.values(states))).toEqual(new Set(['green', 'red']));
    const lights = buildTrafficLights(MAP);
    lights.update(states, t);
    const list = meshes(lights.group);
    for (const s of MAP.signals) {
      for (const c of ['red', 'yellow', 'green']) {
        expect(lamp(list, `lamp-${s.id}-r0-${c}`).material).toBe(lamp(list, `lamp-${s.id}-${c}`).material);
      }
    }
    const display = lamp(list, 'signal-countdowns').geometry;
    const pos = display.getAttribute('position');
    const color = display.getAttribute('color');
    /**
     * Width of a head's units digit quad.
     * @param {number} h Head index.
     * @returns {number} Metres.
     */
    const width = (h) => {
      const v = (h * 2 + 1) * 6;
      return Math.hypot(pos.getX(v + 1) - pos.getX(v), pos.getZ(v + 1) - pos.getZ(v));
    };
    MAP.signals.forEach((s, i) => {
      const far = 4 + i;
      expect(width(far) / width(i)).toBeCloseTo(REPEATER_COUNTDOWN_SCALE, 4);
      const near = (i * 2 + 1) * 6;
      const rep = (far * 2 + 1) * 6;
      expect([color.getX(rep), color.getY(rep), color.getZ(rep)]).toEqual([color.getX(near), color.getY(near), color.getZ(near)]);
      if (states[s.id] === 'red') expect(color.getX(rep)).toBeGreaterThan(color.getY(rep));
      else expect(color.getY(rep)).toBeGreaterThan(color.getX(rep));
    });
    // Yellow: blank on every head.
    const yellowT = 28;
    lights.update(Object.fromEntries(MAP.signals.map((s) => [s.id, signalState(s, yellowT)])), yellowT);
    MAP.signals.forEach((s, i) => {
      if (signalState(s, yellowT) !== 'yellow') return;
      for (const h of [i, 4 + i]) {
        const v = (h * 2 + 1) * 6;
        expect(color.getX(v) + color.getY(v) + color.getZ(v)).toBe(0);
      }
    });
    lights.dispose();
  });
});

describe('route markers in a run without a route', () => {
  it('hides the marker and the finish arch while the frame has no route, and shows them again after', () => {
    const markers = buildRouteMarkers(MINIMAL);
    const frame = FRAMES[0];
    const free = { ...frame, route: null };
    expect(markedCheckpoint(MINIMAL, free)).toBeNull();
    markers.update(free, 0);
    expect(markers.group.visible).toBe(false);
    markers.update(frame, 0);
    expect(markers.group.visible).toBe(true);
    expect(markers.group.getObjectByName('checkpoint-marker')?.visible).toBe(true);
    markers.dispose();
  });
});
