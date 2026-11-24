/**
 * Runtime view of a map's lane graph: every lane and junction connector becomes one indexed edge
 * with precomputed lengths, the stop line that holds it, its speed limit, its successors and its
 * conflict zones. Built once per traffic state; nothing here changes while traffic runs.
 *
 * Edge indices are lanes first, in map order (road by road, lane by lane), then connectors in map
 * order, so every loop over edges has a fixed order.
 */

import { angleDiff, footprint, headingOf, polygonsIntersect, projectOntoPolyline, segmentIntersection } from '../../geometry/index.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/map.js').Connector} Connector */
/** @typedef {import('../../contracts/telemetry.js').Vec2} Vec2 */

/** Turn manoeuvres by rank: a lower rank has priority over a higher one at a conflict. */
export const TURN_RANK = Object.freeze({ straight: 0, right: 1, left: 2, uturn: 3 });

/** Sampling step of the swing-zone search, metres. */
const SWING_SAMPLE_M = 0.5;

/**
 * Lane-graph shaping values from `TrafficParams.behaviour` (turn speeds, long vehicles, swing
 * zones, hold-point move-back).
 * @typedef {Pick<import('../../contracts/traffic.js').BehaviourParams,
 *   'turnLateralMps2' | 'minTurnSpeedMps' | 'swingConflictM' | 'maxHoldBackM'>} GraphParams
 */

/**
 * Sizes that shape the junctions: the longest vehicle of the map's mix, if it is long, and the
 * half width a waiting agent takes around its lane centre.
 * @typedef {object} SweepOptions
 * @property {{lengthM: number, widthM: number} | null} longVehicle Longest model of the mix when
 *   longer than `behaviour.longVehicleM`, else null.
 * @property {number} waitHalfWidthM Half width, around the lane centre, of any waiting agent that
 *   is not long (its lateral offset included).
 * @property {number} waitLengthM Length of the longest agent that is not long.
 */

/**
 * One conflict zone seen from one of its two connectors.
 * @typedef {object} EdgeConflict
 * @property {number} other Edge index of the other connector.
 * @property {number} fromS Start of the zone along this connector.
 * @property {number} toS End of the zone along this connector.
 * @property {number} otherFromS Start of the zone along the other connector.
 * @property {number} otherToS End of the zone along the other connector.
 * @property {boolean} swing A swing zone: binding only when a long vehicle is involved.
 */

/**
 * @typedef {object} Edge
 * @property {number} index Edge index.
 * @property {string} id Lane or connector id.
 * @property {'lane' | 'connector'} kind Edge kind.
 * @property {Vec2[]} points Centreline from the map.
 * @property {Float64Array} xs Centreline x per vertex.
 * @property {Float64Array} zs Centreline z per vertex.
 * @property {Float64Array} cum Distance along the centreline at each vertex.
 * @property {number} length Centreline length.
 * @property {number} roadIndex Road index of a lane, or of a connector's approach lane.
 * @property {number} startHeading Heading at the start.
 * @property {number} endHeading Heading at the end.
 * @property {number[]} next Successors: a lane's connectors, a connector's exit lane.
 * @property {boolean} sink A lane whose end leaves the map.
 * @property {boolean} deadEnd A lane end with no connector that is not a sink.
 * @property {number} holdS Lanes: where an agent waits before its connector (the stop line, else
 *   the lane end). Connectors: 0.
 * @property {'signal' | 'stop-sign' | 'give-way' | null} control Lanes: control of the stop line.
 * @property {number} signalIndex Lanes: index into `map.signals` of the signal, or −1.
 * @property {number | null} limitKmh Speed limit binding the lane (of the approach lane for a
 *   connector), or null when none is known.
 * @property {number} turnSpeedMps Connectors: speed cap through the turn; Infinity on lanes and
 *   straight connectors.
 * @property {'straight' | 'left' | 'right' | 'uturn' | null} turn Connectors: manoeuvre.
 * @property {number} fromEdge Connectors: approach lane edge; lanes: −1.
 * @property {number} toEdge Connectors: exit lane edge; lanes: −1.
 * @property {number} junctionIndex Connectors: index into `map.junctions`; lanes: −1.
 * @property {number[]} siblings Connectors: other connectors leaving the same approach lane.
 * @property {EdgeConflict[]} conflicts Connectors: conflict zones with other connectors.
 * @property {number} clearS Connectors: end of the last conflict zone along it (0 without any).
 */

/**
 * @typedef {object} LaneGraph
 * @property {Edge[]} edges Lanes, then connectors.
 * @property {number} laneCount Number of lane edges (they come first).
 * @property {Map<string, number>} edgeIndex Edge index by lane or connector id.
 * @property {string[]} roadIds Road ids in map order.
 * @property {{minX: number, minZ: number, maxX: number, maxZ: number}} bounds Box around every
 *   edge vertex.
 */

/**
 * Speed limit binding a lane: the lowest `speed-limit` zone that lists it.
 * @param {GameMap} map Map.
 * @param {string} laneId Lane id.
 * @returns {number | null} Limit in km/h, or null.
 */
function laneLimit(map, laneId) {
  let limit = null;
  for (const z of map.zones) {
    if (z.type !== 'speed-limit' || typeof z.valueKmh !== 'number' || !z.laneIds.includes(laneId)) continue;
    if (limit === null || z.valueKmh < limit) limit = z.valueKmh;
  }
  return limit;
}

/**
 * Where a stop line crosses a lane centreline, as a distance along the lane.
 * @param {Vec2[]} centerline Lane centreline.
 * @param {[Vec2, Vec2]} segment Stop line.
 * @returns {number} Distance along the lane.
 */
function stopLineS(centerline, segment) {
  let acc = 0;
  for (let i = 0; i < centerline.length - 1; i += 1) {
    const a = centerline[i];
    const b = centerline[i + 1];
    const hit = segmentIntersection(a, b, segment[0], segment[1]);
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (hit) return acc + seg * hit.t;
    acc += seg;
  }
  // The line misses the centreline (drawn short): use the projection of its midpoint.
  /** @type {Vec2} */
  const mid = [(segment[0][0] + segment[1][0]) / 2, (segment[0][1] + segment[1][1]) / 2];
  return projectOntoPolyline(mid, centerline).s;
}

/**
 * @param {Vec2[]} points Polyline.
 * @returns {{xs: Float64Array, zs: Float64Array, cum: Float64Array, length: number}} Arrays.
 */
function polylineArrays(points) {
  if (!Array.isArray(points) || points.length < 2) throw new RangeError('A lane graph edge needs at least 2 points');
  const n = points.length;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = points[i][0];
    zs[i] = points[i][1];
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  if (!(cum[n - 1] > 0)) throw new RangeError('A lane graph edge has zero length');
  return { xs, zs, cum, length: cum[n - 1] };
}

/**
 * @param {Float64Array} xs X.
 * @param {Float64Array} zs Z.
 * @param {boolean} atEnd Heading of the last segment instead of the first.
 * @returns {number} Heading.
 */
function endHeading(xs, zs, atEnd) {
  const n = xs.length;
  return atEnd ? headingOf(xs[n - 1] - xs[n - 2], zs[n - 1] - zs[n - 2]) : headingOf(xs[1] - xs[0], zs[1] - zs[0]);
}

/**
 * Samples an edge every `SWING_SAMPLE_M` (and at its end).
 * @param {Edge} e Edge.
 * @returns {{s: number[], x: number[], z: number[]}} Samples.
 */
function samples(e) {
  const out = { s: /** @type {number[]} */ ([]), x: /** @type {number[]} */ ([]), z: /** @type {number[]} */ ([]) };
  const p = { x: 0, z: 0, heading: 0 };
  const n = Math.max(1, Math.ceil(e.length / SWING_SAMPLE_M));
  for (let i = 0; i <= n; i += 1) {
    const s = (e.length * i) / n;
    edgePoint(e, s, p);
    out.s.push(s);
    out.x.push(p.x);
    out.z.push(p.z);
  }
  return out;
}

/**
 * Adds swing zones between connectors of the same junction that the map does not list as
 * conflicting and that leave different lanes, wherever their centrelines come within
 * `swingConflictM`. Each zone spans every sample of either connector that is that close.
 * @param {Edge[]} edges Edges.
 * @param {number} laneCount First connector index.
 * @param {number} swingConflictM Swing distance.
 * @returns {void}
 */
function addSwingConflicts(edges, laneCount, swingConflictM) {
  const conns = edges.slice(laneCount);
  const sampled = conns.map(samples);
  const lim2 = swingConflictM * swingConflictM;
  for (let i = 0; i < conns.length; i += 1) {
    for (let j = i + 1; j < conns.length; j += 1) {
      const a = conns[i];
      const b = conns[j];
      if (a.junctionIndex !== b.junctionIndex || a.fromEdge === b.fromEdge) continue;
      if (a.conflicts.some((c) => c.other === b.index)) continue;
      const sa = sampled[i];
      const sb = sampled[j];
      let aFrom = Infinity;
      let aTo = -Infinity;
      let bFrom = Infinity;
      let bTo = -Infinity;
      for (let p = 0; p < sa.s.length; p += 1) {
        for (let q = 0; q < sb.s.length; q += 1) {
          const dx = sa.x[p] - sb.x[q];
          const dz = sa.z[p] - sb.z[q];
          if (dx * dx + dz * dz >= lim2) continue;
          aFrom = Math.min(aFrom, sa.s[p]);
          aTo = Math.max(aTo, sa.s[p]);
          bFrom = Math.min(bFrom, sb.s[q]);
          bTo = Math.max(bTo, sb.s[q]);
        }
      }
      if (aFrom === Infinity) continue;
      a.conflicts.push({ other: b.index, fromS: aFrom, toS: aTo, otherFromS: bFrom, otherToS: bTo, swing: true });
      b.conflicts.push({ other: a.index, fromS: bFrom, toS: bTo, otherFromS: aFrom, otherToS: aTo, swing: true });
      a.clearS = Math.max(a.clearS, aTo);
      b.clearS = Math.max(b.clearS, bTo);
    }
  }
}

/**
 * Moves each lane's hold point back until an agent waiting there stays clear of the sweep of a
 * long vehicle turning through the same junction from another lane. A 10.5 m bus on a 5 m right
 * turn swings over the opposing lane's stop line; real stop lines sit back for this, so waiting
 * agents never block the turn and are never swept.
 * @param {Edge[]} edges Edges.
 * @param {number} laneCount First connector index.
 * @param {SweepOptions} sweep Sizes.
 * @param {number} maxHoldBackM Furthest move-back.
 * @returns {void}
 */
function holdBackFromSweeps(edges, laneCount, sweep, maxHoldBackM) {
  const long = sweep.longVehicle;
  if (!long) return;
  /** @type {Map<number, {poly: Vec2[], from: number}[]>} */
  const sweeps = new Map();
  const p = { x: 0, z: 0, heading: 0 };
  for (const c of edges.slice(laneCount)) {
    if (c.turn === 'straight') continue;
    const list = sweeps.get(c.junctionIndex) ?? [];
    for (let s = 0; s <= c.length + 1e-9; s += SWING_SAMPLE_M) {
      edgePoint(c, s, p);
      list.push({ poly: footprint({ x: p.x, z: p.z }, p.heading, long.lengthM, long.widthM), from: c.fromEdge });
    }
    sweeps.set(c.junctionIndex, list);
  }
  for (const lane of edges.slice(0, laneCount)) {
    if (lane.next.length === 0) continue;
    const junction = edges[lane.next[0]].junctionIndex;
    const polys = (sweeps.get(junction) ?? []).filter((x) => x.from !== lane.index);
    if (polys.length === 0) continue;
    for (let back = 0; back <= maxHoldBackM; back += SWING_SAMPLE_M) {
      const front = lane.holdS - back;
      const mid = Math.max(0, front - sweep.waitLengthM / 2);
      edgePoint(lane, mid, p);
      const box = footprint({ x: p.x, z: p.z }, p.heading, sweep.waitLengthM, 2 * sweep.waitHalfWidthM);
      if (!polys.some((x) => polygonsIntersect(box, x.poly))) {
        lane.holdS = Math.max(0, front);
        break;
      }
    }
  }
}

/**
 * Builds the lane graph of a map. Throws when a connector, conflict, source or sink names an
 * unknown lane or connector (`assertMap` checks references, so this only fires on unchecked maps).
 * @param {GameMap} map Map.
 * @param {GraphParams} params Shaping values.
 * @param {SweepOptions} [sweep] Vehicle sizes; without it no hold point moves back.
 * @returns {LaneGraph} Graph.
 */
export function buildLaneGraph(map, params, sweep) {
  /** @type {Edge[]} */
  const edges = [];
  /** @type {Map<string, number>} */
  const edgeIndex = new Map();
  const roadIds = map.roads.map((r) => r.id);
  const sinks = new Set(map.traffic?.sinks ?? []);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;

  map.roads.forEach((road, roadIndex) => {
    for (const lane of road.lanes) {
      const arr = polylineArrays(lane.centerline);
      // With several stop lines (a crosswalk line before the junction one), hold at the last.
      /** @type {import('../../contracts/map.js').StopLine | null} */
      let stop = null;
      let stopS = -Infinity;
      for (const sl of map.stopLines) {
        if (!sl.laneIds.includes(lane.id)) continue;
        const s = stopLineS(lane.centerline, sl.segment);
        if (s > stopS) {
          stop = sl;
          stopS = s;
        }
      }
      const signalIndex = stop && stop.control === 'signal' ? map.signals.findIndex((s) => s.id === stop.signalId) : -1;
      edgeIndex.set(lane.id, edges.length);
      edges.push({
        index: edges.length,
        id: lane.id,
        kind: 'lane',
        points: lane.centerline,
        ...arr,
        roadIndex,
        startHeading: endHeading(arr.xs, arr.zs, false),
        endHeading: endHeading(arr.xs, arr.zs, true),
        next: [],
        sink: sinks.has(lane.id),
        deadEnd: false,
        holdS: stop ? Math.min(arr.length, Math.max(0, stopS)) : arr.length,
        control: stop ? stop.control : null,
        signalIndex,
        limitKmh: laneLimit(map, lane.id),
        turnSpeedMps: Infinity,
        turn: null,
        fromEdge: -1,
        toEdge: -1,
        junctionIndex: -1,
        siblings: [],
        conflicts: [],
        clearS: 0,
      });
    }
  });
  const laneCount = edges.length;

  for (const c of map.connectors ?? []) {
    const fromEdge = edgeIndex.get(c.fromLaneId);
    const toEdge = edgeIndex.get(c.toLaneId);
    if (fromEdge === undefined || toEdge === undefined) throw new Error(`Connector ${c.id} names an unknown lane`);
    const arr = polylineArrays(c.centerline);
    const start = endHeading(arr.xs, arr.zs, false);
    const end = endHeading(arr.xs, arr.zs, true);
    const swept = Math.abs(angleDiff(edges[fromEdge].endHeading, edges[toEdge].startHeading));
    // Radius of the arc that turns `swept` over the connector length.
    const turnSpeed =
      c.turn === 'straight' || swept < 1e-3
        ? Infinity
        : Math.max(params.minTurnSpeedMps, Math.sqrt(params.turnLateralMps2 * (arr.length / swept)));
    const index = edges.length;
    edgeIndex.set(c.id, index);
    edges.push({
      index,
      id: c.id,
      kind: 'connector',
      points: c.centerline,
      ...arr,
      roadIndex: edges[fromEdge].roadIndex,
      startHeading: start,
      endHeading: end,
      next: [toEdge],
      sink: false,
      deadEnd: false,
      holdS: 0,
      control: null,
      signalIndex: -1,
      limitKmh: edges[fromEdge].limitKmh,
      turnSpeedMps: turnSpeed,
      turn: c.turn,
      fromEdge,
      toEdge,
      junctionIndex: map.junctions.findIndex((j) => j.id === c.junctionId),
      siblings: [],
      conflicts: [],
      clearS: 0,
    });
    edges[fromEdge].next.push(index);
  }

  for (const e of edges) {
    if (e.kind === 'lane') e.deadEnd = !e.sink && e.next.length === 0;
    else e.siblings = edges[e.fromEdge].next.filter((i) => i !== e.index);
    for (let i = 0; i < e.xs.length; i += 1) {
      minX = Math.min(minX, e.xs[i]);
      maxX = Math.max(maxX, e.xs[i]);
      minZ = Math.min(minZ, e.zs[i]);
      maxZ = Math.max(maxZ, e.zs[i]);
    }
  }

  for (const cf of map.conflicts ?? []) {
    const a = edgeIndex.get(cf.a);
    const b = edgeIndex.get(cf.b);
    if (a === undefined || b === undefined || a < laneCount || b < laneCount) {
      throw new Error(`Conflict ${cf.id} names an unknown connector`);
    }
    edges[a].conflicts.push({ other: b, fromS: cf.aFromS, toS: cf.aToS, otherFromS: cf.bFromS, otherToS: cf.bToS, swing: false });
    edges[b].conflicts.push({ other: a, fromS: cf.bFromS, toS: cf.bToS, otherFromS: cf.aFromS, otherToS: cf.aToS, swing: false });
    edges[a].clearS = Math.max(edges[a].clearS, cf.aToS);
    edges[b].clearS = Math.max(edges[b].clearS, cf.bToS);
  }
  addSwingConflicts(edges, laneCount, params.swingConflictM);
  if (sweep) holdBackFromSweeps(edges, laneCount, sweep, params.maxHoldBackM);
  for (const e of edges) e.conflicts.sort((p, q) => p.fromS - q.fromS || p.other - q.other);

  if (edges.length === 0) {
    minX = 0;
    minZ = 0;
    maxX = 0;
    maxZ = 0;
  }
  return { edges, laneCount, edgeIndex, roadIds, bounds: { minX, minZ, maxX, maxZ } };
}

/**
 * Scratch output of `edgePoint`.
 * @typedef {{x: number, z: number, heading: number}} EdgePoint
 */

/**
 * Point and heading at distance `s` along an edge, clamped to the edge, written into `out`.
 * @param {Edge} edge Edge.
 * @param {number} s Distance along it.
 * @param {EdgePoint} out Output, overwritten.
 * @returns {EdgePoint} `out`.
 */
export function edgePoint(edge, s, out) {
  const { xs, zs, cum } = edge;
  const n = xs.length;
  let i = 0;
  if (s <= 0) i = 0;
  else if (s >= edge.length) i = n - 2;
  else while (i < n - 2 && cum[i + 1] < s) i += 1;
  const seg = cum[i + 1] - cum[i];
  const f = seg > 0 ? Math.max(0, Math.min(1, (s - cum[i]) / seg)) : 0;
  const dx = xs[i + 1] - xs[i];
  const dz = zs[i + 1] - zs[i];
  out.x = xs[i] + dx * f;
  out.z = zs[i] + dz * f;
  out.heading = headingOf(dx, dz);
  return out;
}
