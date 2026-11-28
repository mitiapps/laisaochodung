/**
 * Compiles a `MapSpec` into a map JSON object (`src/contracts/map.js`): roads and junctions, then
 * zones, crosswalks (written, OSM and derived on every arm of a signalised junction), stop lines
 * with one resolved control (light over sign over marking, QCVN 41 Điều 4) and the solid approach
 * before them, signals with far-side repeaters, restrictions, entries, signs, pavements, obstacles,
 * actors and the route.
 */

import {
  distance,
  footprint,
  headingOf,
  headingVector,
  leftVector,
  offsetPolyline,
  pointInPolygon,
  polygonsIntersect,
  segmentIntersection,
  polylineLength,
  slicePolyline,
} from '../../../src/geometry/index.js';
import { MAP_SCHEMA_VERSION } from '../../../src/contracts/map.js';
import { carriageway, directionSpan, laneSpan, locateOnWay, splitNetwork, wayPoints } from './graph.js';
import { LANE_WIDTH_M, band, buildRoad, directionLaneIds, junctionPolygon } from './lanes.js';
import { DEFAULT_CYCLE } from './source.js';
import {
  boundingRing,
  endSignStop,
  junctionBufferZones,
  travelHeading,
  walkExtent,
  zonesForExtent,
} from './zones.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('./source.js').MapSpec} MapSpec */
/** @typedef {import('./source.js').WayAt} WayAt */
/** @typedef {import('./graph.js').Topology} Topology */
/** @typedef {import('./graph.js').TopoRoad} TopoRoad */
/** @typedef {import('./graph.js').NetWay} NetWay */
/** @typedef {import('./graph.js').LineStretch} LineStretch */
/** @typedef {import('./zones.js').Placement} Placement */
/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/map.js').Zone} Zone */
/** @typedef {'forward' | 'backward'} Dir */

/** A traffic-signal node belongs to the nearest junction within this distance (m). */
export const SIGNAL_NODE_RANGE_M = 30;
/** A crosswalk this close to a junction edge moves the approach stop line behind it (m). */
export const STOP_LINE_CROSSWALK_RANGE_M = 15;
/**
 * Gap between a stop line and the crosswalk after it (m). QCVN 41:2024 G2.1 asks for 1.5–3.0 m
 * ("nên"); marking sizes: 2019 text = 2026 draft, annex not on the 2024 change list.
 */
export const STOP_LINE_CROSSWALK_GAP_M = 2;
/**
 * Gap between a stop line and the road end when no crosswalk follows (m, `paramBasis: design`):
 * about the cross road's kerb line.
 */
export const STOP_LINE_GAP_M = 1;
/** Width of a crosswalk the build adds on an arm of a signalised junction (m, design; W.224 b: ≥ 3 m). */
export const DERIVED_CROSSWALK_WIDTH_M = 4;
/** Gap between a derived crosswalk and the road end (m, design). */
export const DERIVED_CROSSWALK_END_GAP_M = 0.5;
/** Arms shorter than this get no derived crosswalk (m, design): no room for it and a stop line. */
export const DERIVED_CROSSWALK_MIN_ROAD_M = 20;
/**
 * Longest solid approach before a stop line (m, `paramBasis: design`): the standard gives no length.
 * The stretch is the last `min(SOLID_APPROACH_M, SOLID_APPROACH_SHARE × road length)` before the
 * line, where lane lines become solid white (2.2) and a two-way centre line solid yellow (1.2).
 */
export const SOLID_APPROACH_M = 30;
/** Largest share of a road the solid approach may take (design): Pasteur blocks are 61–109 m. */
export const SOLID_APPROACH_SHARE = 0.4;
/**
 * A far-side repeater stands this far past the junction polygon along the approach's straight-on
 * line (m, design; QCVN 41:2024 9.5 "có thể bổ sung … phía bên kia nút giao").
 */
export const REPEATER_PAST_JUNCTION_M = 1.5;
/** Longest mast arm of a repeater over two or more lanes (m, design; 17.4 prefers overhead there). */
export const REPEATER_MAX_ARM_M = 7;
/** A repeater base on a lane or junction slides this far along the heading at most before it is dropped (m, design). */
export const REPEATER_MAX_SLIDE_M = 6;
/** Step of that slide (m). */
const REPEATER_SLIDE_STEP_M = 0.5;
/** Distance of a sign post or a signal head beyond the carriageway edge (m). */
export const POST_OFFSET_M = 1;

/** Smallest sine of the angle between two arms whose pavement corner is filled (30°). */
const CORNER_MIN_SIN = 0.5;

/**
 * Corner pavements. Where a junction is trimmed back further than the pavements reach, two arms
 * meeting at an angle leave a gap between their pavement ends and the junction's chamfer that is
 * neither road nor pavement. Each such gap gets its own pavement, bounded by the two pavement end
 * edges, their outer edges up to where those meet, and the chamfer, so the kerb wraps the corner.
 * A pair is skipped when the arms meet at less than 30° (the straight side of a T-junction), when
 * the outer edges do not meet towards the junction within its trim (the pavements already touch
 * or overlap there), or when the polygon would
 * overlap the junction, another pavement or a road.
 * @param {Topology} topo Topology.
 * @param {Map<string, Vec2[]>} junctionPolys Junction polygons by id.
 * @param {GameMap['pavements']} existing Road pavements.
 * @returns {GameMap['pavements']} Corner pavements, `pv-<junction>-c<n>`.
 */
function cornerPavements(topo, junctionPolys, existing) {
  /** @type {GameMap['pavements']} */
  const out = [];
  const roadPolys = topo.roads.map((road) => {
    const cw = carriageway(road.way, LANE_WIDTH_M);
    return band(road.points, 0, polylineLength(road.points), cw.lo, cw.hi);
  });
  for (const j of topo.junctions) {
    const poly = junctionPolys.get(j.id);
    if (!poly) continue;
    /** @type {Array<{roadId: string, inner: Vec2, outer: Vec2, d: Vec2}>} */
    const ends = [];
    for (const road of topo.roads) {
      const cw = carriageway(road.way, LANE_WIDTH_M);
      const len = polylineLength(road.points);
      const { left, right } = road.way.pavement;
      for (const atStart of [true, false]) {
        if ((atStart ? road.startJunction : road.endJunction) !== j.id) continue;
        const s = atStart ? 0 : len;
        // Unit direction from the junction into the road.
        const [hx, hz] = headingVector(pointOnRoad(road, s, 0).heading);
        const d = /** @type {Vec2} */ (atStart ? [hx, hz] : [-hx, -hz]);
        if (right > 0) ends.push({ roadId: road.id, inner: pointOnRoad(road, s, cw.lo).point, outer: pointOnRoad(road, s, cw.lo - right).point, d });
        if (left > 0) ends.push({ roadId: road.id, inner: pointOnRoad(road, s, cw.hi).point, outer: pointOnRoad(road, s, cw.hi + left).point, d });
      }
    }
    let n = 0;
    for (let i = 0; i < ends.length; i += 1) {
      for (let k = i + 1; k < ends.length; k += 1) {
        const A = ends[i];
        const B = ends[k];
        if (A.roadId === B.roadId) continue;
        // Outer edge lines, walked back towards the junction: A.outer − t·A.d = B.outer − u·B.d.
        // The sine of the angle between the arms: only a real corner (30° or more) is paved, not
        // the straight side of a T-junction between two nearly aligned arms.
        const det = -A.d[0] * B.d[1] + A.d[1] * B.d[0];
        if (Math.abs(det) < CORNER_MIN_SIN) continue;
        const rx = B.outer[0] - A.outer[0];
        const rz = B.outer[1] - A.outer[1];
        const t = (rx * B.d[1] - rz * B.d[0]) / det;
        const u = (A.d[1] * rx - A.d[0] * rz) / det;
        if (!(t > 1e-6 && u > 1e-6 && t <= j.trimM && u <= j.trimM)) continue;
        const x = /** @type {Vec2} */ ([A.outer[0] - t * A.d[0], A.outer[1] - t * A.d[1]]);
        const ring = /** @type {Vec2[]} */ ([A.inner, A.outer, x, B.outer, B.inner]);
        const area = ring.reduce((acc, p, q) => acc + p[0] * ring[(q + 1) % ring.length][1] - ring[(q + 1) % ring.length][0] * p[1], 0) / 2;
        if (Math.abs(area) < 0.05) continue;
        // A point well inside the gap must be in no junction, pavement or road.
        const probe = /** @type {Vec2} */ ([(A.inner[0] + B.inner[0] + x[0]) / 3, (A.inner[1] + B.inner[1] + x[1]) / 3]);
        if (pointInPolygon(probe, poly)) continue;
        if ([...existing, ...out].some((pv) => pointInPolygon(probe, pv.polygon))) continue;
        if (roadPolys.some((rp) => pointInPolygon(probe, rp))) continue;
        n += 1;
        out.push({ id: `pv-${j.id}-c${n}`, polygon: ring });
      }
    }
  }
  return out;
}

/** Signs that turn into restrictions, with what they ban. */
const RESTRICTION_SIGNS = Object.freeze({ 'P.123a': ['left'], 'P.124a': ['uturn'] });
/** Signs that turn into banned entries. */
const ENTRY_SIGNS = Object.freeze(['P.101', 'P.102']);
/** Signs that control a junction approach, strongest first after lights. */
const CONTROL_SIGNS = Object.freeze({ 'R.122': 'stop-sign', 'W.208': 'give-way' });

/**
 * Point and travel-reference heading at road distance `s`, offset laterally (positive left).
 * @param {TopoRoad} road Road.
 * @param {number} s Road distance (clamped).
 * @param {number} lateral Lateral offset.
 * @returns {{point: Vec2, heading: number}} Point and reference heading.
 */
export function pointOnRoad(road, s, lateral) {
  const len = polylineLength(road.points);
  const c = Math.max(0, Math.min(len, s));
  const win = slicePolyline(road.points, Math.max(0, c - 0.5), Math.min(len, c + 0.5));
  const heading = headingOf(win[win.length - 1][0] - win[0][0], win[win.length - 1][1] - win[0][1]);
  const base = slicePolyline(road.points, c, c)[0];
  const [lx, lz] = leftVector(heading);
  return { point: [base[0] + lx * lateral, base[1] + lz * lateral], heading };
}

/**
 * Rounds a pose to a contract `Pos2`.
 * @param {Vec2} p Point.
 * @returns {{x: number, z: number}} Position.
 */
function pos2(p) {
  return { x: p[0], z: p[1] };
}

/**
 * Whether two headings lie on the same axis of a junction (within 45°, either way along it).
 * @param {number} a Heading.
 * @param {number} b Heading.
 * @returns {boolean} Same axis.
 */
function sameAxis(a, b) {
  return Math.abs(Math.sin(a - b)) < Math.SQRT1_2;
}

/**
 * Whether a crosswalk belongs to one end of its road: within `STOP_LINE_CROSSWALK_RANGE_M` of that
 * end and in that half of the road.
 * @param {{s0: number, s1: number, s: number}} c Crosswalk span in road distances.
 * @param {number} len Road length.
 * @param {boolean} atStart The road's start end, else its end.
 * @returns {boolean} Near that end.
 */
function crosswalkNearEnd(c, len, atStart) {
  return atStart ? c.s0 <= STOP_LINE_CROSSWALK_RANGE_M && c.s < len / 2 : c.s1 >= len - STOP_LINE_CROSSWALK_RANGE_M && c.s > len / 2;
}

/**
 * A line spec with solid stretches laid over it: inside any interval the line is solid and not
 * crossable; outside it keeps its own stretches. Neighbouring stretches of the same kind merge.
 * @param {LineStretch[]} spec Stretches covering [0, ∞) in way distances.
 * @param {Array<[number, number]>} intervals Solid intervals in way distances.
 * @returns {LineStretch[]} New stretches covering [0, ∞).
 */
export function withSolidStretches(spec, intervals) {
  const cuts = [...new Set([0, ...spec.flatMap((st) => [st.fromS, st.toS]), ...intervals.flat()])]
    .filter((x) => x >= 0)
    .sort((a, b) => a - b);
  /** @type {LineStretch[]} */
  const out = [];
  for (let i = 0; i < cuts.length; i += 1) {
    const a = cuts[i];
    const b = i + 1 < cuts.length ? cuts[i + 1] : Infinity;
    if (!(b > a)) continue;
    const mid = Number.isFinite(b) ? (a + b) / 2 : a + 1;
    const own = /** @type {LineStretch} */ (spec.find((st) => mid >= st.fromS && mid < st.toS));
    const solid = intervals.some(([lo, hi]) => mid > lo && mid < hi);
    const type = solid ? 'solid' : own.type;
    const crossable = solid ? 'none' : own.crossable;
    const last = out[out.length - 1];
    if (last && last.type === type && last.crossable === crossable) last.toS = b;
    else out.push({ fromS: a, toS: b, type, crossable });
  }
  return out;
}

/**
 * Far-side repeater of a signalised approach (QCVN 41:2024 9.5): across the junction, on the right
 * of the approach's straight-on line, `REPEATER_PAST_JUNCTION_M` past the junction polygon. One lane
 * in the direction: a post. Two or more: a mast arm (17.4 prefers overhead heads there) with the
 * head over the middle of the approach lanes, the arm at most `REPEATER_MAX_ARM_M`. A base that
 * lands on a lane or junction slides along the heading up to `REPEATER_MAX_SLIDE_M`; past that the
 * repeater is dropped.
 * @param {TopoRoad} road Approach road.
 * @param {Dir} dir Approach direction.
 * @param {number} stopS Road distance of the stop line.
 * @param {Vec2[]} junctionPoly Polygon of the junction ahead.
 * @param {Vec2[][]} blocked Lane and junction polygons.
 * @returns {{head: import('../../../src/contracts/map.js').SignalHead | null, reason: string}} The head, or null and why.
 */
function farSideRepeater(road, dir, stopS, junctionPoly, blocked) {
  const span = directionSpan(road.way, dir, LANE_WIDTH_M);
  const mid = pointOnRoad(road, stopS, (span.lo + span.hi) / 2);
  const heading = travelHeading(mid.heading, dir);
  const [hx, hz] = headingVector(heading);
  const reach = 500;
  const far = /** @type {Vec2} */ ([mid.point[0] + hx * reach, mid.point[1] + hz * reach]);
  let exit = -1;
  for (let i = 0; i < junctionPoly.length; i += 1) {
    const hit = segmentIntersection(mid.point, far, junctionPoly[i], junctionPoly[(i + 1) % junctionPoly.length]);
    if (hit) exit = Math.max(exit, hit.t * reach);
  }
  if (exit < 0) return { head: null, reason: 'the straight-on line misses the junction polygon' };
  const along = exit + REPEATER_PAST_JUNCTION_M;
  const right = pointOnRoad(road, stopS, dir === 'forward' ? span.lo - POST_OFFSET_M : span.hi + POST_OFFSET_M).point;
  const base = /** @type {Vec2} */ ([right[0] + hx * along, right[1] + hz * along]);
  const lanes = dir === 'forward' ? road.way.forward : road.way.backward;
  /** @type {Vec2} */
  let headAt = base;
  if (lanes >= 2) {
    const over = /** @type {Vec2} */ ([mid.point[0] + hx * along, mid.point[1] + hz * along]);
    const arm = distance(base, over);
    const k = arm > REPEATER_MAX_ARM_M ? REPEATER_MAX_ARM_M / arm : 1;
    headAt = [base[0] + (over[0] - base[0]) * k, base[1] + (over[1] - base[1]) * k];
  }
  for (let slide = 0; slide <= REPEATER_MAX_SLIDE_M + 1e-9; slide += REPEATER_SLIDE_STEP_M) {
    const b = /** @type {Vec2} */ ([base[0] + hx * slide, base[1] + hz * slide]);
    if (blocked.some((poly) => pointInPolygon(b, poly))) continue;
    if (lanes < 2) return { head: { pos: pos2(b), mount: 'post' }, reason: '' };
    return { head: { pos: pos2([headAt[0] + hx * slide, headAt[1] + hz * slide]), mount: 'mast-arm', mastPos: pos2(b) }, reason: '' };
  }
  return { head: null, reason: `its base stays on a lane or junction for ${REPEATER_MAX_SLIDE_M} m past the junction` };
}

/**
 * Road topology of a spec: its network split at junctions with the spec's junction trims.
 * @param {MapSpec} spec Spec.
 * @returns {Topology} Topology.
 */
export function topologyOf(spec) {
  /** @type {Map<string, number>} */
  const junctionTrims = new Map();
  for (const [node, j] of spec.junctions) if (j.trimM !== undefined) junctionTrims.set(node, j.trimM);
  return splitNetwork(spec.network, { laneWidth: LANE_WIDTH_M, junctionTrims });
}

/**
 * Compiles a spec into a map.
 * @param {MapSpec} spec Spec.
 * @param {string[]} [notes] Receives the build notes worth logging (derived elements skipped or
 *   dropped).
 * @returns {GameMap} Map (not yet rounded or validated).
 */
export function compileMap(spec, notes = []) {
  const topo = topologyOf(spec);
  const { network } = topo;
  for (const node of spec.junctions.keys()) {
    if (!topo.junctionOfNode.has(node)) throw new Error(`${spec.id}: junction settings for ${node}, which is not a junction`);
  }
  const roads = topo.roads.map(buildRoad);
  const allLaneIds = roads.flatMap((r) => r.lanes.map((l) => l.id));

  /** @type {Map<string, import('./source.js').JunctionSpec>} */
  const junctionSpec = new Map();
  for (const j of topo.junctions) {
    const settings = j.nodeIds.map((n) => spec.junctions.get(n)).filter((x) => x !== undefined);
    if (settings.length > 1) throw new Error(`${spec.id}: junction ${j.id} has settings on two of its nodes`);
    junctionSpec.set(j.id, settings[0] ?? { signals: null });
  }
  /** @type {Map<string, Vec2[]>} */
  const junctionPolys = new Map(
    topo.junctions.map((j) => [j.id, junctionSpec.get(j.id)?.polygon ?? junctionPolygon(topo, j.id)]),
  );

  /**
   * @param {WayAt} at Way position.
   * @param {Dir} dir Direction.
   * @param {string} what Element for messages.
   * @param {boolean} [againstOneway] Allow facing traffic against a one-way road (no-entry signs).
   * @returns {Placement} Placement.
   */
  const place = (at, dir, what, againstOneway = false) => {
    let located;
    try {
      located = locateOnWay(topo, at.way, at.s);
    } catch (err) {
      throw new Error(`${spec.id}: ${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (dir === 'backward' && located.road.way.oneway && !againstOneway) {
      throw new Error(`${spec.id}: ${what} faces backward on one-way way ${at.way}`);
    }
    return { road: located.road, s: located.s, dir };
  };

  // Signs.
  const placedSigns = spec.signs.map((s) => ({
    spec: s,
    code: s.code,
    placement: place(s.at, s.dir, `sign ${s.id}`, ENTRY_SIGNS.includes(s.code)),
  }));
  /**
   * @param {Placement} p Placement.
   * @returns {{point: Vec2, heading: number}} Post position on the right of the travel direction.
   */
  const postAt = (p) => {
    const cw = carriageway(p.road.way, LANE_WIDTH_M);
    const lat = p.dir === 'forward' ? cw.lo - POST_OFFSET_M : cw.hi + POST_OFFSET_M;
    const at = pointOnRoad(p.road, p.s, lat);
    return { point: at.point, heading: travelHeading(at.heading, p.dir) };
  };
  const signs = placedSigns.map(({ spec: s, placement }) => {
    const post = postAt(placement);
    /** @type {GameMap['signs'][number]} */
    const out = { id: s.id, code: s.code, pos: pos2(post.point), heading: post.heading, source: spec.placedSource };
    if (s.value !== undefined) out.value = s.value;
    return out;
  });

  // Zones.
  /** @type {Zone[]} */
  const zones = [];
  for (const { spec: s, code, placement } of placedSigns) {
    if (code === 'P.127') {
      // A speed limit ends at DP.134 or where the next P.127 facing the same traffic replaces it.
      const extent = walkExtent(topo, placement, endSignStop(placedSigns, ['DP.134', 'P.127'], placement));
      zones.push(
        ...zonesForExtent(extent, { id: `z-${s.id}`, type: 'speed-limit', signIds: [s.id], source: spec.placedSource, valueKmh: s.value }),
      );
    } else if (code === 'P.130') {
      const extent = walkExtent(topo, placement, () => null);
      zones.push(...zonesForExtent(extent, { id: `z-${s.id}`, type: 'no-stopping', signIds: [s.id], source: spec.placedSource }));
    }
  }
  const builtUpSigns = placedSigns.filter((x) => x.code === 'R.420').map((x) => x.spec.id);
  if (builtUpSigns.length === 0) throw new Error(`${spec.id}: every MVP map lies inside an R.420 built-up zone; place an R.420`);
  const everything = [...roads.flatMap((r) => r.lanes.map((l) => l.polygon)), ...junctionPolys.values()];
  const mapRing = boundingRing(everything, 30);
  zones.push({ id: 'z-built-up', type: 'built-up', polygon: mapRing, laneIds: allLaneIds, signIds: builtUpSigns, source: spec.placedSource });
  if (spec.lit) zones.push({ id: 'z-lit', type: 'lit', polygon: mapRing, laneIds: allLaneIds, signIds: [], source: spec.placedSource });
  zones.push(...junctionBufferZones(topo, junctionPolys));

  // Signal nodes (OSM) belong to the nearest junction within range.
  /** @type {Set<string>} */
  const signalizedByNode = new Set();
  for (const nid of spec.network.signalNodes ?? []) {
    const node = network.nodes.get(nid);
    if (!node) continue;
    let best = null;
    let bestD = SIGNAL_NODE_RANGE_M;
    for (const j of topo.junctions) {
      for (const m of j.nodeIds) {
        const d = distance(node.pos, /** @type {Vec2} */ (network.nodes.get(m)?.pos));
        if (d <= bestD) {
          bestD = d;
          best = j.id;
        }
      }
    }
    if (best) signalizedByNode.add(best);
  }

  /**
   * @param {string} id Junction id.
   * @returns {boolean} Whether the junction has lights.
   */
  const isSignalized = (id) => junctionSpec.get(id)?.signals != null || signalizedByNode.has(id);

  // Crosswalks.
  const sourceCrosswalks = spec.crosswalks.map((c) => {
    let located;
    const half = c.widthM / 2;
    if (c.clamp) {
      const candidates = topo.roads.filter((r) => r.way.id === c.at.way);
      const road = candidates.reduce((best, r) => {
        const gap = (/** @type {TopoRoad} */ x) => Math.max(0, x.s0 - c.at.s, c.at.s - x.s1);
        return gap(r) < gap(best) ? r : best;
      });
      const len = polylineLength(road.points);
      const s = Math.max(half + 0.5, Math.min(len - half - 0.5, c.at.s - road.s0));
      located = { road, s };
    } else {
      located = place(c.at, 'forward', `crosswalk ${c.id}`, true);
      const len = polylineLength(located.road.points);
      if (located.s - half < 0 || located.s + half > len) throw new Error(`${spec.id}: crosswalk ${c.id} runs into a junction`);
    }
    const cw = carriageway(located.road.way, LANE_WIDTH_M);
    return {
      id: c.id,
      road: located.road,
      s0: located.s - half,
      s1: located.s + half,
      s: located.s,
      polygon: band(located.road.points, located.s - half, located.s + half, cw.lo, cw.hi),
    };
  });
  // Two source crosswalks on one road must not overlap (two OSM crossing nodes clamped to one road
  // end): the one with the smaller id stays.
  /** @type {typeof sourceCrosswalks} */
  const crosswalks = [];
  for (const c of [...sourceCrosswalks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const clash = crosswalks.find((k) => k.road === c.road && c.s0 < k.s1 && k.s0 < c.s1);
    if (clash) notes.push(`crosswalk ${c.id} overlaps ${clash.id} on road ${c.road.id}: dropped`);
    else crosswalks.push(c);
  }
  crosswalks.sort((a, b) => sourceCrosswalks.indexOf(a) - sourceCrosswalks.indexOf(b));

  // Every arm of a signalised junction gets a zebra near the junction (QCVN 41:2024 W.224 b: it
  // "phải được sơn kẻ vạch" where many people cross), unless a source crosswalk already lies within
  // STOP_LINE_CROSSWALK_RANGE_M of that end or the arm is too short.
  for (const j of topo.junctions) {
    if (!isSignalized(j.id)) continue;
    for (const road of topo.roads) {
      for (const atStart of [true, false]) {
        if ((atStart ? road.startJunction : road.endJunction) !== j.id) continue;
        const len = polylineLength(road.points);
        const tag = atStart ? 's' : 'e';
        if (len < DERIVED_CROSSWALK_MIN_ROAD_M) {
          notes.push(`no derived crosswalk on road ${road.id} at ${j.id}: the road is ${len.toFixed(1)} m, under ${DERIVED_CROSSWALK_MIN_ROAD_M} m`);
          continue;
        }
        const covered = crosswalks.some((c) => c.road === road && crosswalkNearEnd(c, len, atStart));
        if (covered) continue;
        const s0 = atStart ? DERIVED_CROSSWALK_END_GAP_M : len - DERIVED_CROSSWALK_END_GAP_M - DERIVED_CROSSWALK_WIDTH_M;
        const s1 = s0 + DERIVED_CROSSWALK_WIDTH_M;
        const cw = carriageway(road.way, LANE_WIDTH_M);
        crosswalks.push({ id: `cw-${road.id}-${tag}`, road, s0, s1, s: (s0 + s1) / 2, polygon: band(road.points, s0, s1, cw.lo, cw.hi) });
      }
    }
  }

  // Junction approaches and their control.
  /** @type {Map<string, {code: string, signId: string}[]>} */
  const approachSigns = new Map();
  for (const x of placedSigns) {
    if (!(x.code in CONTROL_SIGNS) && !(x.code in RESTRICTION_SIGNS)) continue;
    const extent = walkExtent(topo, x.placement, () => null);
    if (!extent.approach) throw new Error(`${spec.id}: sign ${x.spec.id} (${x.code}) is not followed by a junction`);
    const key = `${extent.approach.road.id}:${extent.approach.dir}`;
    if (!approachSigns.has(key)) approachSigns.set(key, []);
    /** @type {{code: string, signId: string}[]} */ (approachSigns.get(key)).push({ code: x.code, signId: x.spec.id });
  }

  /** @type {GameMap['stopLines']} */
  const stopLines = [];
  /** @type {GameMap['signals']} */
  const signals = [];
  /** @type {GameMap['junctions']} */
  const junctions = [];
  /** @type {GameMap['restrictions']} */
  const restrictions = [];
  /** @type {Map<string, string>} crosswalk id → signal id */
  const crosswalkSignal = new Map();
  /** @type {Map<string, string>} crosswalk id → walk signal id */
  const crosswalkWalkSignal = new Map();
  /** @type {Map<string, {forward: Array<[number, number]>, backward: Array<[number, number]>}>} road id → solid-approach intervals per direction, in road distances */
  const solidApproach = new Map();
  /** @type {Vec2[][]} Polygons no repeater base may stand in. */
  const carriagewayPolys = [...roads.flatMap((r) => r.lanes.map((l) => l.polygon)), ...junctionPolys.values()];

  for (const j of topo.junctions) {
    const js = /** @type {import('./source.js').JunctionSpec} */ (junctionSpec.get(j.id));
    const signalized = isSignalized(j.id);
    const cycle = js.signals ?? DEFAULT_CYCLE;
    const period = cycle.green + cycle.yellow + cycle.red;
    /** @type {Array<{id: string, heading: number}>} */
    const junctionSignals = [];
    const incident = topo.roads.filter((r) => r.startJunction === j.id || r.endJunction === j.id);
    /** @type {Array<{road: TopoRoad, dir: Dir}>} */
    const approaches = [];
    for (const road of incident) {
      if (road.endJunction === j.id) approaches.push({ road, dir: 'forward' });
      if (road.startJunction === j.id && road.way.backward > 0) approaches.push({ road, dir: 'backward' });
    }
    approaches.sort((a, b) => {
      // Code-unit order, as in the serialiser, so the phase axis never depends on the locale.
      const ka = `${a.road.id}:${a.dir}`;
      const kb = `${b.road.id}:${b.dir}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    /** @type {Set<string>} */
    const controlledRoads = new Set();
    let axis = null;
    for (const { road, dir } of approaches) {
      const key = `${road.id}:${dir}`;
      const tag = dir === 'forward' ? 'f' : 'b';
      const len = polylineLength(road.points);
      const signsHere = approachSigns.get(key) ?? [];
      for (const r of signsHere) {
        if (r.code in RESTRICTION_SIGNS) {
          restrictions.push({
            id: `rx-${r.signId}`,
            junctionId: j.id,
            fromLaneIds: directionLaneIds(road, dir),
            banned: [.../** @type {Record<string, ('left' | 'right' | 'uturn')[]>} */ (RESTRICTION_SIGNS)[r.code]],
            signId: r.signId,
          });
        }
      }
      /** @type {'signal' | 'stop-sign' | 'give-way' | null} */
      let control = null;
      if (signalized) control = 'signal';
      else if (signsHere.some((r) => r.code === 'R.122')) control = 'stop-sign';
      else if (signsHere.some((r) => r.code === 'W.208')) control = 'give-way';
      if (!control) continue;
      controlledRoads.add(road.id);

      // The stop line sits before a crosswalk in the approach half of the road near the junction.
      const near = crosswalks.filter((c) => c.road === road && crosswalkNearEnd(c, len, dir === 'backward'));
      let stopS;
      if (near.length > 0) {
        stopS =
          dir === 'forward'
            ? Math.min(...near.map((c) => c.s0)) - STOP_LINE_CROSSWALK_GAP_M
            : Math.max(...near.map((c) => c.s1)) + STOP_LINE_CROSSWALK_GAP_M;
      } else stopS = dir === 'forward' ? len - STOP_LINE_GAP_M : STOP_LINE_GAP_M;
      if (stopS < 0 || stopS > len) throw new Error(`${spec.id}: no room for the stop line of road ${road.id} at ${j.id}`);
      const solidM = Math.min(SOLID_APPROACH_M, SOLID_APPROACH_SHARE * len);
      if (!solidApproach.has(road.id)) solidApproach.set(road.id, { forward: [], backward: [] });
      // Through to the road end, so no dashed piece is left past the line.
      /** @type {{forward: Array<[number, number]>, backward: Array<[number, number]>}} */ (solidApproach.get(road.id))[dir].push(
        dir === 'forward' ? [Math.max(0, stopS - solidM), len] : [0, Math.min(len, stopS + solidM)],
      );

      const span = directionSpan(road.way, dir, LANE_WIDTH_M);
      const a = pointOnRoad(road, stopS, span.lo).point;
      const b = pointOnRoad(road, stopS, span.hi).point;
      const slId = `sl-${road.id}-${tag}`;
      /** @type {GameMap['stopLines'][number]} */
      const line = { id: slId, segment: [a, b], laneIds: directionLaneIds(road, dir), control };
      if (control === 'signal') {
        const sigId = `sig-${road.id}-${tag}`;
        line.signalId = sigId;
        const head = pointOnRoad(road, stopS, dir === 'forward' ? span.lo - POST_OFFSET_M : span.hi + POST_OFFSET_M);
        const heading = travelHeading(head.heading, dir);
        if (axis === null) axis = heading;
        // The cross axis runs half a period later, so the clearance splits evenly between the
        // two changes; parseJunctions keeps red ≥ green + yellow + 2 × ALL_RED_S.
        /** @type {GameMap['signals'][number]} */
        const signal = {
          id: sigId,
          pos: pos2(head.point),
          heading,
          stopLineIds: [slId],
          cycle: { ...cycle, offset: sameAxis(heading, /** @type {number} */ (axis)) ? 0 : period / 2 },
        };
        const repeater = farSideRepeater(road, dir, stopS, /** @type {Vec2[]} */ (junctionPolys.get(j.id)), carriagewayPolys);
        if (repeater.head) signal.repeaters = [repeater.head];
        else notes.push(`no far-side repeater for ${sigId} at ${j.id}: ${repeater.reason}`);
        signals.push(signal);
        junctionSignals.push({ id: sigId, heading });
        for (const c of near) crosswalkSignal.set(c.id, sigId);
      }
      stopLines.push(line);
    }

    // Pedestrian heads of a crosswalk near this junction are timed by a signal of the other axis:
    // its green is when the traffic over the crosswalk stands.
    if (junctionSignals.length > 0) {
      for (const road of incident) {
        const len = polylineLength(road.points);
        for (const atStart of [true, false]) {
          if ((atStart ? road.startJunction : road.endJunction) !== j.id) continue;
          const roadHeading = pointOnRoad(road, atStart ? 0 : len, 0).heading;
          const walk = junctionSignals
            .filter((x) => !sameAxis(x.heading, roadHeading))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
          for (const c of crosswalks) {
            if (c.road !== road || crosswalkWalkSignal.has(c.id)) continue;
            if (!crosswalkNearEnd(c, len, atStart)) continue;
            if (walk) crosswalkWalkSignal.set(c.id, walk.id);
            else notes.push(`crosswalk ${c.id} at ${j.id} has no pedestrian heads: no signal on the other axis`);
          }
        }
      }
    }

    const roadIds = [...new Set(incident.map((r) => r.id))].sort();
    let priorityRoadIds = [];
    if (!signalized) {
      const prio = new Set(incident.filter((r) => r.way.priority).map((r) => r.id));
      if (controlledRoads.size > 0) for (const id of roadIds) if (!controlledRoads.has(id)) prio.add(id);
      priorityRoadIds = [...prio].sort();
    }
    junctions.push({
      id: j.id,
      polygon: /** @type {Vec2[]} */ (junctionPolys.get(j.id)),
      roadIds,
      signalized,
      roundabout: false,
      priorityRoadIds,
    });
  }

  // Entries.
  const entries = placedSigns
    .filter((x) => ENTRY_SIGNS.includes(x.code))
    .map(({ spec: s, placement }) => {
      const cw = carriageway(placement.road.way, LANE_WIDTH_M);
      const a = pointOnRoad(placement.road, placement.s, cw.lo);
      const b = pointOnRoad(placement.road, placement.s, cw.hi);
      return {
        id: `en-${s.id}`,
        segment: /** @type {[Vec2, Vec2]} */ ([a.point, b.point]),
        heading: travelHeading(a.heading, placement.dir),
        bannedClasses: /** @type {('all')[]} */ (['all']),
        signId: s.id,
      };
    });

  // Pavements.
  /** @type {GameMap['pavements']} */
  const pavements = [];
  for (const road of topo.roads) {
    const cw = carriageway(road.way, LANE_WIDTH_M);
    const len = polylineLength(road.points);
    const { left, right } = road.way.pavement;
    if (right > 0) pavements.push({ id: `pv-${road.id}-r`, polygon: band(road.points, 0, len, cw.lo - right, cw.lo) });
    if (left > 0) pavements.push({ id: `pv-${road.id}-l`, polygon: band(road.points, 0, len, cw.hi, cw.hi + left) });
  }
  pavements.push(...cornerPavements(topo, junctionPolys, pavements));

  // Obstacles.
  /**
   * @param {string} wayId Way id.
   * @returns {NetWay} Way.
   */
  const wayById = (wayId) => /** @type {NetWay} */ (network.ways.find((w) => w.id === wayId));
  /** @type {GameMap['obstacles']} */
  const obstacles = spec.obstacles.map((o) => {
    const p = place(o.at, 'forward', `obstacle ${o.id}`);
    const at = pointOnRoad(p.road, p.s, o.lateral);
    return { id: o.id, kind: o.kind, footprint: footprint(pos2(at.point), at.heading, o.lengthM, o.widthM), height: o.heightM };
  });
  const blocked = [...roads.flatMap((r) => r.lanes.map((l) => l.polygon)), ...junctionPolys.values()];
  for (const b of spec.buildings) {
    const way = wayById(b.way);
    const cw = carriageway(way, LANE_WIDTH_M);
    const pts = wayPoints(network, way);
    const len = polylineLength(pts);
    if (b.toS > len) throw new Error(`${spec.id}: building ${b.id} runs off way ${b.way}`);
    const inner = b.side === 'right' ? cw.lo - way.pavement.right - b.setbackM : cw.hi + way.pavement.left + b.setbackM;
    const outer = b.side === 'right' ? inner - b.depthM : inner + b.depthM;
    const poly = band(pts, b.fromS, b.toS, Math.min(inner, outer), Math.max(inner, outer));
    if (blocked.some((q) => polygonsIntersect(poly, q))) throw new Error(`${spec.id}: building ${b.id} overlaps a lane or junction`);
    obstacles.push({ id: b.id, kind: 'building', footprint: poly, height: b.heightM });
  }

  // Actors.
  /** @type {GameMap['actors']} */
  const actors = spec.actors.map((a) => {
    /** @type {Vec2[]} */
    let path;
    if ('crosswalk' in a.path) {
      const name = a.path.crosswalk;
      const cw = crosswalks.find((c) => c.id === name);
      if (!cw) throw new Error(`${spec.id}: actor ${a.id} uses unknown crosswalk ${name}`);
      const span = carriageway(cw.road.way, LANE_WIDTH_M);
      const right = pointOnRoad(cw.road, cw.s, span.lo - 2).point;
      const left = pointOnRoad(cw.road, cw.s, span.hi + 2).point;
      path = a.path.from === 'right' ? [right, left] : [left, right];
    } else {
      path = [];
      for (const { way: wayId, dir, index, fromS, toS } of a.path.lanes) {
        const way = wayById(wayId);
        const { lo, hi } = laneSpan(way, dir, index, LANE_WIDTH_M);
        const pts = wayPoints(network, way);
        if (Math.max(fromS, toS) > polylineLength(pts)) throw new Error(`${spec.id}: actor ${a.id} path runs off way ${wayId}`);
        if (dir === 'forward' ? !(toS > fromS) : !(toS < fromS)) {
          throw new Error(`${spec.id}: actor ${a.id} path must run with its lane direction (fromS → toS)`);
        }
        const centre = offsetPolyline(slicePolyline(pts, Math.min(fromS, toS), Math.max(fromS, toS)), (lo + hi) / 2);
        const piece = dir === 'forward' ? centre : centre.reverse();
        const last = path[path.length - 1];
        path.push(...(last && distance(last, piece[0]) < 0.05 ? piece.slice(1) : piece));
      }
    }
    /** @type {GameMap['actors'][number]['trigger']} */
    let trigger;
    if ('atS' in a.trigger) trigger = { atS: a.trigger.atS };
    else {
      const way = wayById(a.trigger.way);
      const cw = carriageway(way, LANE_WIDTH_M);
      const pts = wayPoints(network, way);
      if (!(a.trigger.toS > a.trigger.fromS) || a.trigger.toS > polylineLength(pts)) {
        throw new Error(`${spec.id}: actor ${a.id} trigger range is empty or off the way`);
      }
      trigger = { polygon: band(pts, a.trigger.fromS, a.trigger.toS, cw.lo, cw.hi) };
    }
    const violations = a.violations === undefined ? {} : { violations: [...a.violations] };
    return { id: a.id, kind: a.kind, model: a.model, lengthM: a.lengthM, widthM: a.widthM, path, speed: a.speed, trigger, loop: a.loop, ...violations };
  });

  // Route.
  const st = place(spec.route.start.at, spec.route.start.dir, 'route start');
  const stLane = laneSpan(st.road.way, st.dir, spec.route.start.lane, LANE_WIDTH_M);
  const stAt = pointOnRoad(st.road, st.s, (stLane.lo + stLane.hi) / 2);
  const start = { pos: pos2(stAt.point), heading: travelHeading(stAt.heading, st.dir) };
  const checkpoints = spec.route.checkpoints.map((c, i) => {
    const p = place(c.at, c.dir, `route checkpoint ${i}`);
    // The nav arrow points at the gate centre, so on a multi-lane direction it must name a lane:
    // mid-direction would be a lane line and would steer a player along it.
    const count = p.dir === 'forward' ? p.road.way.forward : p.road.way.backward;
    if (c.lane === null && count > 1) throw new Error(`${spec.id}: route checkpoint ${i} needs a lane (${count} lanes)`);
    const span = laneSpan(p.road.way, p.dir, c.lane ?? 0, LANE_WIDTH_M);
    const at = pointOnRoad(p.road, p.s, (span.lo + span.hi) / 2);
    return { pos: pos2(at.point), heading: travelHeading(at.heading, p.dir) };
  });
  const fin = place(spec.route.finish.at, spec.route.finish.dir, 'route finish');
  const finLen = polylineLength(fin.road.points);
  const [f0, f1] = fin.dir === 'forward' ? [fin.s, fin.s + spec.route.finish.lengthM] : [fin.s - spec.route.finish.lengthM, fin.s];
  if (f0 < 0 || f1 > finLen) throw new Error(`${spec.id}: the finish area runs into a junction or off the road`);
  const finSpan = directionSpan(fin.road.way, fin.dir, LANE_WIDTH_M);
  const finish = { polygon: band(fin.road.points, f0, f1, finSpan.lo, finSpan.hi) };

  for (const z of zones) {
    if ((z.type === 'no-stopping' || z.type === 'junction-buffer') && pointInPolygon([start.pos.x, start.pos.z], z.polygon)) {
      throw new Error(`${spec.id}: the route start lies in ${z.type} zone ${z.id}; a waiting player would breach`);
    }
  }

  // Solid approach: the lines of the approaching direction, and the centre line, turn solid before
  // every stop line. An authored line spec is left as written.
  topo.roads.forEach((road, i) => {
    const intervals = solidApproach.get(road.id);
    if (!intervals) return;
    const authored = road.way.authoredLines ?? { center: false, lane: false };
    /**
     * @param {Array<[number, number]>} list Intervals in road distances.
     * @returns {Array<[number, number]>} The same in way distances.
     */
    const shift = (list) => list.map(([a, b]) => /** @type {[number, number]} */ ([a + road.s0, b + road.s0]));
    /** @type {import('./lanes.js').RoadLines} */
    const lines = {};
    if (!authored.lane) {
      if (intervals.forward.length > 0) lines.forward = withSolidStretches(road.way.laneLine, shift(intervals.forward));
      if (intervals.backward.length > 0) lines.backward = withSolidStretches(road.way.laneLine, shift(intervals.backward));
    }
    if (!authored.center) lines.center = withSolidStretches(road.way.centerLine, shift([...intervals.forward, ...intervals.backward]));
    roads[i] = buildRoad(road, lines);
  });

  /** @type {GameMap} */
  const map = {
    schemaVersion: /** @type {1} */ (MAP_SCHEMA_VERSION),
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    environment: spec.environment,
    route: { start, checkpoints, finish, timeLimitS: spec.timeLimitS },
    roads,
    junctions,
    zones,
    stopLines,
    signals,
    crosswalks: crosswalks.map((c) => {
      /** @type {GameMap['crosswalks'][number]} */
      const out = { id: c.id, polygon: c.polygon };
      const sig = crosswalkSignal.get(c.id);
      if (sig) out.signalId = sig;
      const walk = crosswalkWalkSignal.get(c.id);
      if (walk) out.walkSignalId = walk;
      return out;
    }),
    restrictions,
    entries,
    pavements,
    signs,
    obstacles,
    actors,
  };
  if (spec.attribution) map.attribution = spec.attribution;
  if (spec.origin) map.origin = spec.origin;
  return map;
}

/**
 * Route length: start, checkpoints and finish centre joined by straight legs (m).
 * @param {GameMap} map Map.
 * @returns {number} Length.
 */
export function routeLength(map) {
  const pts = [map.route.start.pos, ...map.route.checkpoints.map((c) => c.pos)].map((p) => /** @type {Vec2} */ ([p.x, p.z]));
  const f = map.route.finish.polygon;
  pts.push([f.reduce((s, p) => s + p[0], 0) / f.length, f.reduce((s, p) => s + p[1], 0) / f.length]);
  let len = 0;
  for (let i = 1; i < pts.length; i += 1) len += distance(pts[i - 1], pts[i]);
  return len;
}
