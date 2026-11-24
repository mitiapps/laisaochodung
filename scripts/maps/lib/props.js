/**
 * Street props (`GameMap.props`): trees, lamps, power poles, cabinets, bus stops and
 * parked-motorbike clusters beside the road.
 *
 * - Every road side with a pavement is a `RoadSide`: the kerb line (carriageway edge) and the
 *   pavement width outward from it. Positions on a side are a station `s` along the road and a
 *   distance `d` outward from the kerb.
 * - Props come from three places: tutorial `props:` lists in `source.yaml`, OSM nodes (snapped
 *   to the kerb zone when they fall on the carriageway or a pavement), and a seeded fill at
 *   design spacing along every pavement.
 * - A prop never overlaps a lane, a junction, a building, a sign post, a crosswalk landing or
 *   another prop, and every pavement keeps a clear walking strip of `CLEAR_STRIP_M` wherever a
 *   prop stands on it.
 *
 * Pure and deterministic: the fill draws from streams seeded by the map id and the side id, so
 * adding a prop on one side never reshuffles another.
 */

import { footprint, polygonsIntersect, projectOntoPolyline, polylineLength } from '../../../src/geometry/index.js';
import { PROP_KINDS } from '../../../src/contracts/map.js';
import { createStream, hash32, hashString, range, uniform } from '../../../src/world/random.js';
import { carriageway, locateOnWay } from './graph.js';
import { LANE_WIDTH_M, growPolygon } from './lanes.js';
import { pointOnRoad } from './elements.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('./graph.js').Topology} Topology */
/** @typedef {import('./graph.js').TopoRoad} TopoRoad */
/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/map.js').Prop} Prop */
/** @typedef {Prop['kind']} PropKind */
/** @typedef {import('./source.js').SourceYaml} SourceYaml */

/**
 * Clear walking strip a pavement keeps beside any prop on it (m, design after HCMC's sidewalk
 * parking rule, kerb excluded).
 */
export const CLEAR_STRIP_M = 1.5;

/** Gap between a frontage prop and the back edge of the pavement (m, design). */
export const FRONTAGE_GAP_M = 0.25;

/** A crosswalk keeps this much room around it free of props, for the people using it (m, design). */
const CROSSWALK_CLEAR_M = 2.5;

/** Square kept free around a sign post or signal head (m, design). */
const POST_CLEAR_M = 0.8;

/** Props stay this far from either end of a road side (m, design). */
const SIDE_END_M = 1;

/**
 * Ground footprint per kind: `lengthM` along the heading (along the kerb), `widthM` across it;
 * trees use their 1.2 m pit. A bus stop is a slim 1.2 m shelter and a stall 1.2 m deep, so both
 * fit a 3 m pavement beside the clear strip. `kerbOffsetM` is the default distance from the kerb
 * to the prop centre, and `frontage` kinds stand behind the pavement, in front of the buildings.
 * Solid props are colliders; stalls and bins are not.
 * @type {Readonly<Record<PropKind, {lengthM: number, widthM: number, solid: boolean, kerbOffsetM: number, frontage: boolean}>>}
 */
export const PROP_SPECS = Object.freeze({
  tree: { lengthM: 1.2, widthM: 1.2, solid: true, kerbOffsetM: 0.85, frontage: false },
  lamp: { lengthM: 0.4, widthM: 0.4, solid: true, kerbOffsetM: 0.5, frontage: false },
  'power-pole': { lengthM: 0.4, widthM: 0.4, solid: true, kerbOffsetM: 0.5, frontage: false },
  cabinet: { lengthM: 0.8, widthM: 0.5, solid: true, kerbOffsetM: 0.55, frontage: false },
  'bus-stop': { lengthM: 4, widthM: 1.2, solid: true, kerbOffsetM: 0.75, frontage: false },
  'parked-motorbikes': { lengthM: 4, widthM: 2, solid: true, kerbOffsetM: 1, frontage: true },
  bin: { lengthM: 0.6, widthM: 0.6, solid: false, kerbOffsetM: 0.5, frontage: false },
  stall: { lengthM: 2, widthM: 1.2, solid: false, kerbOffsetM: 0.75, frontage: false },
});

/**
 * Seeded fill along every pavement: first station range, spacing range, and the smallest
 * distance to another prop of the same kind (m, design: trees every 12–20 m, lamps every 30 m,
 * poles every 35 m). Power poles only on tutorial streets: the OSM district has its cables
 * underground.
 */
export const FILL = Object.freeze([
  { kind: /** @type {PropKind} */ ('tree'), first: [3, 9], spacing: [12, 20], minGapM: 8, tutorialOnly: false },
  { kind: /** @type {PropKind} */ ('lamp'), first: [10, 16], spacing: [30, 30], minGapM: 15, tutorialOnly: false },
  { kind: /** @type {PropKind} */ ('power-pole'), first: [24, 30], spacing: [35, 35], minGapM: 17, tutorialOnly: true },
]);

/** Parked-motorbike fill in front of shophouse forecourts: spacing and share of slots used. */
const CLUSTER_SPACING_M = 6;
const CLUSTER_SHARE = 0.6;

/** Steps tried when a fill station is blocked, before the slot is skipped (m). */
const NUDGES = Object.freeze([1, 2, 3, 4, 5]);

/**
 * One road side with a pavement.
 * @typedef {object} RoadSide
 * @property {string} id `<road>-r` or `<road>-l`.
 * @property {TopoRoad} road Road.
 * @property {'left' | 'right'} side Side of the road reference direction.
 * @property {number} lengthM Road length.
 * @property {number} kerb Lateral of the kerb line (carriageway edge), positive left.
 * @property {1 | -1} out Lateral sign of the outward direction.
 * @property {number} widthM Pavement width.
 */

/**
 * Road sides with a pavement, in road id order, right before left.
 * @param {Topology} topo Topology.
 * @returns {RoadSide[]} Sides.
 */
export function roadSides(topo) {
  /** @type {RoadSide[]} */
  const out = [];
  const roads = [...topo.roads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const road of roads) {
    const cw = carriageway(road.way, LANE_WIDTH_M);
    const lengthM = polylineLength(road.points);
    const { left, right } = road.way.pavement;
    if (right > 0) out.push({ id: `${road.id}-r`, road, side: 'right', lengthM, kerb: cw.lo, out: -1, widthM: right });
    if (left > 0) out.push({ id: `${road.id}-l`, road, side: 'left', lengthM, kerb: cw.hi, out: 1, widthM: left });
  }
  return out;
}

/**
 * Point of a side at station `s` and distance `d` outward from the kerb.
 * @param {RoadSide} side Side.
 * @param {number} s Station.
 * @param {number} d Distance from the kerb.
 * @returns {{point: Vec2, heading: number}} Point and the travel heading of the nearside lanes.
 */
export function sidePoint(side, s, d) {
  const at = pointOnRoad(side.road, s, side.kerb + side.out * d);
  return { point: at.point, heading: side.side === 'right' ? at.heading : at.heading + Math.PI };
}

/**
 * Station and kerb distance of a point on a side.
 * @param {RoadSide} side Side.
 * @param {Vec2} p Point.
 * @returns {{s: number, d: number}} Station along the road and distance outward from the kerb.
 */
export function sideCoords(side, p) {
  const pr = projectOntoPolyline(p, side.road.points);
  return { s: pr.s, d: (pr.lateral - side.kerb) * side.out };
}

/**
 * Ground footprint of a prop.
 * @param {{kind: PropKind, pos: {x: number, z: number}, heading: number}} prop Prop.
 * @returns {Vec2[]} Ring.
 */
export function propFootprint(prop) {
  const spec = PROP_SPECS[prop.kind];
  return footprint(prop.pos, prop.heading, spec.lengthM, spec.widthM);
}

/**
 * Axis-aligned bounds of a ring.
 * @param {Vec2[]} ring Ring.
 * @returns {[number, number, number, number]} minX, minZ, maxX, maxZ.
 */
function bounds(ring) {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const [x, z] of ring) {
    if (x < a) a = x;
    if (z < b) b = z;
    if (x > c) c = x;
    if (z > d) d = z;
  }
  return [a, b, c, d];
}

/**
 * Polygons a prop must not touch, with their bounds for a quick reject.
 */
export class Blockers {
  constructor() {
    /** @type {Array<{ring: Vec2[], box: [number, number, number, number], what: string}>} */
    this.items = [];
  }

  /**
   * @param {Vec2[]} ring Ring.
   * @param {string} what Name for messages.
   */
  add(ring, what) {
    this.items.push({ ring, box: bounds(ring), what });
  }

  /**
   * The first blocker a ring touches, or null.
   * @param {Vec2[]} ring Ring.
   * @returns {string | null} Its name.
   */
  hit(ring) {
    const [a, b, c, d] = bounds(ring);
    for (const it of this.items) {
      const [p, q, r, s] = it.box;
      if (c < p || a > r || d < q || b > s) continue;
      if (polygonsIntersect(ring, it.ring)) return it.what;
    }
    return null;
  }
}

/**
 * Lanes, junctions, crosswalk landings and posts of a map: what no prop and no building may
 * touch (buildings use only the lanes and junctions).
 * @param {GameMap} map Compiled map.
 * @returns {Blockers} Blockers.
 */
export function mapBlockers(map) {
  const out = new Blockers();
  for (const road of map.roads) for (const lane of road.lanes) out.add(lane.polygon, `lane ${lane.id}`);
  for (const j of map.junctions) out.add(j.polygon, `junction ${j.id}`);
  for (const c of map.crosswalks) out.add(growPolygon(c.polygon, CROSSWALK_CLEAR_M), `crosswalk ${c.id}`);
  for (const post of [...map.signs, ...map.signals]) out.add(footprint(post.pos, post.heading, POST_CLEAR_M, POST_CLEAR_M), `post ${post.id}`);
  for (const o of map.obstacles) out.add(o.footprint, `obstacle ${o.id}`);
  return out;
}

/**
 * Footprint of a prop in side coordinates.
 * @typedef {object} SideSpan
 * @property {number} s0 Smallest station.
 * @property {number} s1 Largest station.
 * @property {number} d0 Smallest kerb distance.
 * @property {number} d1 Largest kerb distance.
 */

/**
 * Span of a ring on a side, or null when the whole ring lies beyond one end of the road (its
 * stations clamp to that end).
 * @param {RoadSide} side Side.
 * @param {Vec2[]} ring Ring.
 * @returns {SideSpan | null} Span.
 */
function sideSpan(side, ring) {
  const cs = ring.map((p) => sideCoords(side, p));
  if (cs.every((c) => c.s <= 1e-6) || cs.every((c) => c.s >= side.lengthM - 1e-6)) return null;
  return {
    s0: Math.min(...cs.map((c) => c.s)),
    s1: Math.max(...cs.map((c) => c.s)),
    d0: Math.min(...cs.map((c) => c.d)),
    d1: Math.max(...cs.map((c) => c.d)),
  };
}

/**
 * Widest stretch of the pavement left free across it at station `s`.
 * @param {RoadSide} side Side.
 * @param {readonly SideSpan[]} spans Prop spans on this side.
 * @param {number} s Station.
 * @returns {number} Free width (m).
 */
export function clearWidthAt(side, spans, s) {
  const taken = spans
    .filter((sp) => s >= sp.s0 && s <= sp.s1 && sp.d1 > 0 && sp.d0 < side.widthM)
    .map((sp) => [Math.max(0, sp.d0), Math.min(side.widthM, sp.d1)])
    .sort((a, b) => a[0] - b[0]);
  let best = 0;
  let at = 0;
  for (const [a, b] of taken) {
    best = Math.max(best, a - at);
    at = Math.max(at, b);
  }
  return Math.max(best, side.widthM - at);
}

/**
 * Props placed so far, with their spans on each side they stand on, so each new one is checked
 * against the lanes, the buildings, the other props and the walking strip.
 */
export class PropSet {
  /**
   * @param {RoadSide[]} sides Road sides.
   * @param {Blockers} blockers Static blockers.
   */
  constructor(sides, blockers) {
    this.sides = sides;
    this.blockers = blockers;
    /** @type {Prop[]} */
    this.props = [];
    /** @type {Map<string, SideSpan[]>} side id → spans of props on its pavement */
    this.spans = new Map(sides.map((s) => [s.id, []]));
    this.own = new Blockers();
  }

  /**
   * Why a prop cannot stand where it is, or null when it can.
   * @param {Prop} prop Candidate.
   * @returns {string | null} Reason.
   */
  problem(prop) {
    const ring = propFootprint(prop);
    const hit = this.blockers.hit(ring) ?? this.own.hit(ring);
    if (hit) return `touches ${hit}`;
    for (const side of this.sides) {
      const sp = sideSpan(side, ring);
      if (!sp || sp.d1 <= 0 || sp.d0 >= side.widthM) continue;
      const spans = [.../** @type {SideSpan[]} */ (this.spans.get(side.id)), sp];
      for (let s = Math.max(0, sp.s0); s <= Math.min(side.lengthM, sp.s1) + 1e-9; s += 0.25) {
        const w = clearWidthAt(side, spans, s);
        if (w < CLEAR_STRIP_M - 1e-6) return `leaves ${w.toFixed(2)} m of pavement ${side.id} clear at s = ${s.toFixed(1)}`;
      }
    }
    return null;
  }

  /**
   * Adds a prop without checks (after `problem` returned null).
   * @param {Prop} prop Prop.
   */
  add(prop) {
    const ring = propFootprint(prop);
    this.props.push(prop);
    this.own.add(ring, `prop ${prop.id}`);
    for (const side of this.sides) {
      const sp = sideSpan(side, ring);
      if (!sp || sp.d1 <= 0 || sp.d0 >= side.widthM) continue;
      /** @type {SideSpan[]} */ (this.spans.get(side.id)).push(sp);
    }
  }

  /**
   * Adds a prop when it fits.
   * @param {Prop} prop Candidate.
   * @returns {boolean} Placed.
   */
  tryAdd(prop) {
    if (this.problem(prop) !== null) return false;
    this.add(prop);
    return true;
  }
}

/**
 * Builds a prop on a side.
 * @param {string} id Id.
 * @param {PropKind} kind Kind.
 * @param {RoadSide} side Side.
 * @param {number} s Station.
 * @param {number} d Kerb distance of the centre.
 * @returns {Prop} Prop.
 */
function propOnSide(id, kind, side, s, d) {
  const at = sidePoint(side, s, d);
  return { id, kind, pos: { x: at.point[0], z: at.point[1] }, heading: at.heading, solid: PROP_SPECS[kind].solid };
}

/**
 * Default kerb distance of a kind's centre on a side.
 * @param {PropKind} kind Kind.
 * @param {RoadSide} side Side.
 * @returns {number} Distance (m).
 */
export function defaultOffset(kind, side) {
  const spec = PROP_SPECS[kind];
  return spec.frontage ? side.widthM + FRONTAGE_GAP_M + spec.widthM / 2 : spec.kerbOffsetM;
}

/**
 * A tutorial `props:` entry resolved to a place on a road side.
 * @typedef {object} PropSpec
 * @property {string} id Id.
 * @property {PropKind} kind Kind.
 * @property {RoadSide} side Side.
 * @property {number} s Station on the side's road.
 * @property {number} d Kerb distance of the centre.
 */

/**
 * Parses a tutorial `props:` list. Positions are `{way, side, s}` (way distance, as for building
 * rows) with an optional `offsetM` from the kerb to the prop centre.
 * @param {unknown} list Value of the `props` key.
 * @param {Topology} topo Topology.
 * @param {RoadSide[]} sides Road sides.
 * @param {string} file File name for messages.
 * @returns {PropSpec[]} Resolved entries.
 */
export function parsePropList(list, topo, sides, file) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${file} props: expected a list`);
  /** @type {Set<string>} */
  const ids = new Set();
  return list.map((raw, i) => {
    const w = `${file} props[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${w}: expected a mapping`);
    const p = /** @type {SourceYaml} */ (raw);
    const id = p.id === undefined ? `pr-${i + 1}` : p.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error(`${w}.id: expected a lower-case id`);
    if (ids.has(id)) throw new Error(`${w}: duplicate id ${id}`);
    ids.add(id);
    if (!PROP_KINDS.includes(p.kind)) throw new Error(`${w}.kind: expected one of ${PROP_KINDS.join(', ')}`);
    const kind = /** @type {PropKind} */ (p.kind);
    if (p.side !== 'left' && p.side !== 'right') throw new Error(`${w}.side: expected left or right`);
    if (typeof p.s !== 'number' || !Number.isFinite(p.s) || p.s < 0) throw new Error(`${w}.s: expected a distance`);
    if (typeof p.way !== 'string') throw new Error(`${w}.way: expected a way id`);
    let located;
    try {
      located = locateOnWay(topo, p.way, p.s);
    } catch (err) {
      throw new Error(`${w}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const side = sides.find((sd) => sd.road === located.road && sd.side === p.side);
    if (!side) throw new Error(`${w}: way ${p.way} has no pavement on the ${p.side}`);
    let d = defaultOffset(kind, side);
    if (p.offsetM !== undefined) {
      if (typeof p.offsetM !== 'number' || !Number.isFinite(p.offsetM) || p.offsetM < 0) throw new Error(`${w}.offsetM: expected a distance`);
      d = p.offsetM;
    }
    return { id, kind, side, s: located.s, d };
  });
}

/**
 * Places resolved tutorial props; a tutorial source is authored, so a prop that does not fit
 * fails the build.
 * @param {PropSet} set Prop set.
 * @param {readonly PropSpec[]} specs Entries.
 * @param {string} file File name for messages.
 */
export function placePropList(set, specs, file) {
  for (const p of specs) {
    const prop = propOnSide(p.id, p.kind, p.side, p.s, p.d);
    const why = set.problem(prop);
    if (why) throw new Error(`${file}: prop ${p.id} (${p.kind}) ${why}`);
    set.add(prop);
  }
}

/**
 * Ground footprint a tutorial prop will take, before it is placed.
 * @param {PropSpec} p Entry.
 * @returns {Vec2[]} Ring.
 */
export function propSpecFootprint(p) {
  return propFootprint(propOnSide(p.id, p.kind, p.side, p.s, p.d));
}

/** OSM tags to prop kinds. Benches, fences, walls and gates have no prop kind and are skipped. */
const OSM_PROP_KINDS = Object.freeze([
  { kind: /** @type {PropKind} */ ('tree'), match: (/** @type {Record<string, string>} */ t) => t.natural === 'tree' },
  { kind: /** @type {PropKind} */ ('lamp'), match: (/** @type {Record<string, string>} */ t) => t.highway === 'street_lamp' },
  { kind: /** @type {PropKind} */ ('bus-stop'), match: (/** @type {Record<string, string>} */ t) => t.highway === 'bus_stop' },
  { kind: /** @type {PropKind} */ ('cabinet'), match: (/** @type {Record<string, string>} */ t) => t.man_made === 'street_cabinet' },
  { kind: /** @type {PropKind} */ ('parked-motorbikes'), match: (/** @type {Record<string, string>} */ t) => t.amenity === 'motorcycle_parking' },
]);

/**
 * @typedef {object} OsmPropElement
 * @property {'node' | 'way' | 'relation'} type Type.
 * @property {number} id Id.
 * @property {number} [lat] Node latitude.
 * @property {number} [lon] Node longitude.
 * @property {Array<{lat: number, lon: number}>} [geometry] Way geometry.
 * @property {Record<string, string>} [tags] Tags.
 */

/**
 * Road whose band (carriageway plus pavements, with half a metre to spare) holds a point.
 * @param {Topology} topo Topology.
 * @param {Vec2} p Point.
 * @returns {{road: TopoRoad, s: number, lateral: number} | null} Nearest road the point is on.
 */
function roadUnder(topo, p) {
  /** @type {{road: TopoRoad, s: number, lateral: number, dist: number} | null} */
  let best = null;
  for (const road of topo.roads) {
    const pr = projectOntoPolyline(p, road.points);
    const len = polylineLength(road.points);
    if (pr.s <= 1e-6 || pr.s >= len - 1e-6) continue;
    const cw = carriageway(road.way, LANE_WIDTH_M);
    const lo = cw.lo - road.way.pavement.right - 0.5;
    const hi = cw.hi + road.way.pavement.left + 0.5;
    if (pr.lateral < lo || pr.lateral > hi) continue;
    if (!best || pr.distance < best.dist) best = { road, s: pr.s, lateral: pr.lateral, dist: pr.distance };
  }
  return best;
}

/**
 * Imports OSM street furniture. A point on a corridor road's carriageway or pavement is moved
 * into the kerb zone of the nearer pavement at its station (the OSM node often sits on the road
 * centreline); a point off the corridor keeps its position. OSM input never fails the build: a
 * point that fits nowhere is skipped and logged.
 * @param {{elements: OsmPropElement[]}} raw Extract.
 * @param {(lat: number, lon: number) => Vec2} toXZ Projection.
 * @param {Topology} topo Topology.
 * @param {PropSet} set Prop set.
 * @returns {string[]} Notes.
 */
export function importOsmProps(raw, toXZ, topo, set) {
  /** @type {string[]} */
  const notes = [];
  let moved = 0;
  /** @type {Record<string, number>} */
  const skipped = {};
  const elements = [...raw.elements].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type < b.type ? -1 : 1));
  for (const e of elements) {
    const tags = e.tags;
    if (!tags || e.type === 'relation') continue;
    const match = OSM_PROP_KINDS.find((k) => k.match(tags));
    if (!match) {
      if (e.type === 'node' && tags.amenity === 'bench') skipped.bench = (skipped.bench ?? 0) + 1;
      continue;
    }
    /** @type {Vec2} */
    let p;
    if (e.type === 'node') {
      if (typeof e.lat !== 'number' || typeof e.lon !== 'number') throw new Error(`OSM node ${e.id}: no coordinates`);
      p = toXZ(e.lat, e.lon);
    } else {
      const g = e.geometry ?? [];
      if (g.length === 0) throw new Error(`OSM way ${e.id}: no geometry (fetch with "out body geom")`);
      const pts = g.map((q) => toXZ(q.lat, q.lon));
      p = [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
    }
    const id = `pr-osm-${e.type === 'node' ? 'n' : 'w'}${e.id}`;
    const kind = match.kind;
    const on = roadUnder(topo, p);
    if (!on) {
      const prop = { id, kind, pos: { x: p[0], z: p[1] }, heading: 0, solid: PROP_SPECS[kind].solid };
      const why = set.problem(prop);
      if (why === null) set.add(prop);
      else notes.push(`OSM ${kind} ${id} skipped: ${why}`);
      continue;
    }
    const cw = carriageway(on.road.way, LANE_WIDTH_M);
    const nearRight = Math.abs(on.lateral - cw.lo) <= Math.abs(on.lateral - cw.hi);
    const order = /** @type {Array<'right' | 'left'>} */ (nearRight ? ['right', 'left'] : ['left', 'right']);
    let placed = false;
    for (const sideName of order) {
      const side = set.sides.find((sd) => sd.road === on.road && sd.side === sideName);
      if (!side) continue;
      const d = defaultOffset(kind, side);
      for (const ds of [0, ...NUDGES.flatMap((n) => [n, -n])]) {
        const s = Math.max(SIDE_END_M, Math.min(side.lengthM - SIDE_END_M, on.s + ds));
        const prop = propOnSide(id, kind, side, s, d);
        if (set.tryAdd(prop)) {
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (placed) moved += 1;
    else notes.push(`OSM ${kind} ${id} skipped: no room on road ${on.road.id}`);
  }
  if (moved > 0) notes.push(`${moved} OSM props moved into the kerb zone of the nearer pavement`);
  for (const [k, n] of Object.entries(skipped)) notes.push(`${n} OSM ${k} nodes skipped: no prop kind for them`);
  return notes;
}

/**
 * Seeded stream of one side and purpose.
 * @param {string} mapId Map id.
 * @param {string} sideId Side id.
 * @param {string} purpose What the stream places.
 * @returns {import('../../../src/world/random.js').RandomStream} Stream.
 */
export function sideStream(mapId, sideId, purpose) {
  return createStream(hash32(hashString(mapId), hashString(sideId), hashString(purpose)));
}

/**
 * Seeded fill of trees, lamps and (tutorials only) power poles along every pavement. A station
 * that is blocked is nudged forward a few metres, then skipped; a station too close to a prop
 * of the same kind (an OSM tree, say) is skipped.
 * @param {PropSet} set Prop set.
 * @param {string} mapId Map id.
 * @param {boolean} tutorial Tutorial map.
 * @returns {number} Props added.
 */
export function fillPavements(set, mapId, tutorial) {
  let added = 0;
  for (const fill of FILL) {
    if (fill.tutorialOnly && !tutorial) continue;
    for (const side of set.sides) {
      const rng = sideStream(mapId, side.id, fill.kind);
      const d = PROP_SPECS[fill.kind].kerbOffsetM;
      if (side.widthM < d + PROP_SPECS[fill.kind].widthM / 2 + CLEAR_STRIP_M) continue;
      let n = 0;
      for (let s = range(rng, fill.first[0], fill.first[1]); s <= side.lengthM - SIDE_END_M; s += range(rng, fill.spacing[0], fill.spacing[1])) {
        for (const ds of [0, ...NUDGES]) {
          const at = s + ds;
          if (at > side.lengthM - SIDE_END_M) break;
          const prop = propOnSide(`pr-${fill.kind}-${side.id}-${n + 1}`, fill.kind, side, at, d);
          const near = set.props.some(
            (q) => q.kind === fill.kind && Math.hypot(q.pos.x - prop.pos.x, q.pos.z - prop.pos.z) < fill.minGapM,
          );
          if (near) break;
          if (set.tryAdd(prop)) {
            n += 1;
            added += 1;
            break;
          }
        }
      }
    }
  }
  return added;
}

/**
 * A shop forecourt between a pavement and a shophouse row, where motorbikes park.
 * @typedef {object} Forecourt
 * @property {RoadSide} side Side.
 * @property {number} s0 First station.
 * @property {number} s1 Last station.
 * @property {string} rowId Building row behind it.
 */

/**
 * Seeded parked-motorbike clusters in shop forecourts: a slot every few metres, a share of them
 * used.
 * @param {PropSet} set Prop set.
 * @param {string} mapId Map id.
 * @param {readonly Forecourt[]} forecourts Forecourts.
 * @returns {number} Clusters added.
 */
export function fillForecourts(set, mapId, forecourts) {
  let added = 0;
  const half = PROP_SPECS['parked-motorbikes'].lengthM / 2;
  for (const f of forecourts) {
    const rng = sideStream(mapId, f.rowId, 'parked-motorbikes');
    let n = 0;
    for (let s = f.s0 + half + 0.5; s <= f.s1 - half - 0.5; s += CLUSTER_SPACING_M) {
      if (uniform(rng) >= CLUSTER_SHARE) continue;
      const prop = propOnSide(`pr-motorbikes-${f.rowId}-${n + 1}`, 'parked-motorbikes', f.side, s, defaultOffset('parked-motorbikes', f.side));
      if (set.tryAdd(prop)) {
        n += 1;
        added += 1;
      }
    }
  }
  return added;
}
