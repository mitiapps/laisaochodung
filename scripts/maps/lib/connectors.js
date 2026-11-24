/**
 * Lane graph of a compiled map: which lane ends meet a junction, continue into another road at a
 * plain join, or leave the map; the junction connectors (one cubic Bézier per permitted lane to
 * lane movement); and the conflict zones between connectors of the same junction.
 *
 * It reads only the map contract (`src/contracts/map.js`), so it runs on any built map: lane
 * centrelines, junction polygons, stop lines, restrictions and no-entry lines.
 */

import {
  angleDiff,
  distance,
  headingOf,
  pointAtDistance,
  pointInPolygon,
  polylineLength,
  projectOntoPolyline,
  segmentIntersection,
} from '../../../src/geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/map.js').Lane} Lane */
/** @typedef {import('../../../src/contracts/map.js').Connector} Connector */
/** @typedef {import('../../../src/contracts/map.js').Conflict} Conflict */

/** A lane end this close to a junction polygon of its road belongs to that junction (m). */
export const JUNCTION_END_M = 3;
/** A lane end this close to the start of a lane on another road continues into it (m). */
export const JOIN_M = 0.1;
/** Largest heading change across a plain join (rad). */
const JOIN_MAX_TURN_RAD = Math.PI / 4;
/** Largest heading change that still counts as going straight on (rad), a game value. */
export const STRAIGHT_MAX_RAD = Math.PI / 4;
/**
 * Two connector paths closer than this share road space (m): about one car width plus a margin,
 * a game value (`paramBasis: design`).
 */
export const CONFLICT_CLEARANCE_M = 2.5;
/** Sampling step along a connector when measuring conflict spans (m). */
const CONFLICT_STEP_M = 0.25;
/** Tangent and chord within this angle make a two-point straight connector (rad). */
const COLLINEAR_RAD = (0.5 * Math.PI) / 180;

/**
 * Lane end that leaves the map, meets a junction, runs on into another road at a plain join, or
 * is a taper: an unpaired lane beside a join, where the road widens or narrows.
 * @typedef {{kind: 'boundary'} | {kind: 'junction', junctionId: string} | {kind: 'join', laneId: string} | {kind: 'taper'}} LaneEnd
 */

/** @typedef {import('../../../src/contracts/map.js').LaneJoin} PlainJoin Plain join, as the map contract records it. */

/**
 * @typedef {object} LaneGraph
 * @property {Connector[]} connectors Junction connectors, sorted by id.
 * @property {Conflict[]} conflicts Conflict zones, sorted by id.
 * @property {PlainJoin[]} joins Plain joins, sorted by lane ids.
 * @property {Map<string, LaneEnd>} starts Where each lane starts, by lane id.
 * @property {Map<string, LaneEnd>} ends Where each lane ends, by lane id.
 */

/**
 * Distance from a point to a polygon, 0 inside.
 * @param {Vec2} p Point.
 * @param {Vec2[]} polygon Ring.
 * @returns {number} Distance.
 */
export function distanceToPolygon(p, polygon) {
  if (pointInPolygon(p, polygon)) return 0;
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    best = Math.min(best, projectOntoPolyline(p, [polygon[j], polygon[i]]).distance);
  }
  return best;
}

/**
 * Heading at the start or end of a polyline.
 * @param {Vec2[]} line Polyline.
 * @param {'start' | 'end'} at Which end.
 * @returns {number} Heading.
 */
function endHeading(line, at) {
  const [a, b] = at === 'start' ? [line[0], line[1]] : [line[line.length - 2], line[line.length - 1]];
  return headingOf(b[0] - a[0], b[1] - a[1]);
}

/**
 * Lane key: road and direction.
 * @param {string} roadId Road id.
 * @param {Lane} lane Lane.
 * @returns {string} Group key.
 */
function groupKey(roadId, lane) {
  return `${roadId}:${lane.dir}`;
}

/**
 * Where every lane starts and ends.
 * @param {GameMap} map Map.
 * @returns {{starts: Map<string, LaneEnd>, ends: Map<string, LaneEnd>, joins: PlainJoin[]}} Ends and plain joins.
 */
export function laneEnds(map) {
  const lanes = map.roads.flatMap((road) => road.lanes.map((lane) => ({ road, lane })));
  /**
   * @param {string} roadId Road id.
   * @param {Vec2} p Lane end point.
   * @returns {string | null} Junction id.
   */
  const junctionAt = (roadId, p) => {
    let best = null;
    let bestD = JUNCTION_END_M;
    for (const j of map.junctions) {
      if (!j.roadIds.includes(roadId)) continue;
      const d = distanceToPolygon(p, j.polygon);
      if (d <= bestD) {
        bestD = d;
        best = j.id;
      }
    }
    return best;
  };
  /** @type {Map<string, LaneEnd>} */
  const starts = new Map();
  /** @type {Map<string, LaneEnd>} */
  const ends = new Map();
  /** @type {PlainJoin[]} */
  const joins = [];
  for (const { road, lane } of lanes) {
    const cl = lane.centerline;
    const endJ = junctionAt(road.id, cl[cl.length - 1]);
    if (endJ) ends.set(lane.id, { kind: 'junction', junctionId: endJ });
    else {
      const next = lanes.find(
        (o) =>
          o.road.id !== road.id &&
          distance(o.lane.centerline[0], cl[cl.length - 1]) <= JOIN_M &&
          Math.abs(angleDiff(endHeading(cl, 'end'), endHeading(o.lane.centerline, 'start'))) <= JOIN_MAX_TURN_RAD,
      );
      if (next) {
        ends.set(lane.id, { kind: 'join', laneId: next.lane.id });
        joins.push({ fromLaneId: lane.id, toLaneId: next.lane.id });
      } else ends.set(lane.id, { kind: 'boundary' });
    }
    const startJ = junctionAt(road.id, cl[0]);
    if (startJ) starts.set(lane.id, { kind: 'junction', junctionId: startJ });
    else {
      const prev = lanes.find(
        (o) =>
          o.road.id !== road.id &&
          distance(o.lane.centerline[o.lane.centerline.length - 1], cl[0]) <= JOIN_M &&
          Math.abs(angleDiff(endHeading(o.lane.centerline, 'end'), endHeading(cl, 'start'))) <= JOIN_MAX_TURN_RAD,
      );
      starts.set(lane.id, prev ? { kind: 'join', laneId: prev.lane.id } : { kind: 'boundary' });
    }
  }
  // An unpaired lane whose siblings (same road and direction) join another road at that end is a
  // taper inside the map, not a way in or out of it.
  for (const { road, lane } of lanes) {
    const siblings = road.lanes.filter((l) => l.dir === lane.dir && l.id !== lane.id);
    for (const table of [starts, ends]) {
      if (table.get(lane.id)?.kind !== 'boundary') continue;
      if (siblings.some((l) => table.get(l.id)?.kind === 'join')) table.set(lane.id, { kind: 'taper' });
    }
  }
  joins.sort((a, b) => cmp(`${a.fromLaneId} ${a.toLaneId}`, `${b.fromLaneId} ${b.toLaneId}`));
  return { starts, ends, joins };
}

/**
 * Code-unit string order, as in the serialiser.
 * @param {string} a String.
 * @param {string} b String.
 * @returns {number} Order.
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Manoeuvre from an approach heading to an exit heading (positive heading change is a left turn).
 * @param {number} from Approach heading at the lane end.
 * @param {number} to Exit heading at the lane start.
 * @returns {'straight' | 'left' | 'right'} Manoeuvre.
 */
export function classifyTurn(from, to) {
  const d = angleDiff(from, to);
  if (Math.abs(d) <= STRAIGHT_MAX_RAD) return 'straight';
  return d > 0 ? 'left' : 'right';
}

/**
 * Lane pairs `[fromIndex, toIndex]` of one movement. Right turns go kerb lane to kerb lane, left
 * turns innermost to innermost; straight on keeps the lane index, the inner lanes merging where
 * the exit is narrower and the innermost lane feeding the extra lanes where it is wider.
 * @param {'straight' | 'left' | 'right'} turn Manoeuvre.
 * @param {number} nFrom Approach lane count.
 * @param {number} nTo Exit lane count.
 * @returns {Array<[number, number]>} Index pairs.
 */
export function lanePairs(turn, nFrom, nTo) {
  if (turn === 'right') return [[0, 0]];
  if (turn === 'left') return [[nFrom - 1, nTo - 1]];
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let i = 0; i < nFrom; i += 1) out.push([i, Math.min(i, nTo - 1)]);
  for (let j = nFrom; j < nTo; j += 1) out.push([nFrom - 1, j]);
  return out;
}

/**
 * Cubic Bézier centreline from `p0` heading `h0` to `p3` heading `h3`. The handle length makes a
 * symmetric turn of angle θ a close circular arc: `chord · (2/3) · tan(θ/4) / sin(θ/2)`, which is a
 * third of the chord when going straight. Collinear ends give a two-point line.
 * @param {Vec2} p0 Start.
 * @param {number} h0 Start heading.
 * @param {Vec2} p3 End.
 * @param {number} h3 End heading.
 * @returns {Vec2[]} Polyline.
 */
export function bezierCenterline(p0, h0, p3, h3) {
  const chord = distance(p0, p3);
  if (chord < 1e-6) throw new Error('connector ends coincide');
  const hc = headingOf(p3[0] - p0[0], p3[1] - p0[1]);
  if (Math.abs(angleDiff(h0, hc)) < COLLINEAR_RAD && Math.abs(angleDiff(h3, hc)) < COLLINEAR_RAD) return [p0, p3];
  const theta = Math.abs(angleDiff(h0, h3));
  const k = theta < 1e-3 ? 1 / 3 : ((2 / 3) * Math.tan(theta / 4)) / Math.sin(theta / 2);
  const h = chord * k;
  /** @type {Vec2} */
  const p1 = [p0[0] + Math.cos(h0) * h, p0[1] - Math.sin(h0) * h];
  /** @type {Vec2} */
  const p2 = [p3[0] - Math.cos(h3) * h, p3[1] + Math.sin(h3) * h];
  const n = Math.max(8, Math.ceil(chord / 2));
  /** @type {Vec2[]} */
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

/**
 * Whether a no-entry line bans every vehicle from driving along a lane.
 * @param {GameMap['entries'][number]} entry Entry line.
 * @param {Lane} lane Lane.
 * @returns {boolean} Banned.
 */
function entryBans(entry, lane) {
  if (!entry.bannedClasses.includes('all')) return false;
  const cl = lane.centerline;
  for (let i = 1; i < cl.length; i += 1) {
    if (!segmentIntersection(cl[i - 1], cl[i], entry.segment[0], entry.segment[1])) continue;
    const h = headingOf(cl[i][0] - cl[i - 1][0], cl[i][1] - cl[i - 1][1]);
    if (Math.abs(angleDiff(h, entry.heading)) < Math.PI / 2) return true;
  }
  return false;
}

/**
 * Junction connectors for every permitted movement: approach lanes ending at a junction to exit
 * lanes starting there, on another road (U-turns are not built). A movement is dropped when a
 * restriction bans it from the approach lane, or when a no-entry line bans every vehicle from the
 * exit lane. One-way roads need no check: they have no lane that leaves a junction against them.
 * @param {GameMap} map Map.
 * @param {Map<string, LaneEnd>} starts Lane starts.
 * @param {Map<string, LaneEnd>} ends Lane ends.
 * @returns {Connector[]} Connectors, sorted by id.
 */
export function buildConnectors(map, starts, ends) {
  /** @type {Map<string, {roadId: string, lanes: Lane[]}>} */
  const groups = new Map();
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const key = groupKey(road.id, lane);
      if (!groups.has(key)) groups.set(key, { roadId: road.id, lanes: [] });
      /** @type {{lanes: Lane[]}} */ (groups.get(key)).lanes.push(lane);
    }
  }
  for (const g of groups.values()) g.lanes.sort((a, b) => a.index - b.index);
  const stopLineOf = new Map(map.stopLines.flatMap((sl) => sl.laneIds.map((id) => [id, sl.id])));
  const bannedExit = new Set(
    map.roads.flatMap((r) => r.lanes.filter((l) => map.entries.some((e) => entryBans(e, l))).map((l) => l.id)),
  );

  /** @type {Connector[]} */
  const out = [];
  for (const j of map.junctions) {
    const atJ = (/** @type {LaneEnd | undefined} */ e) => e?.kind === 'junction' && e.junctionId === j.id;
    const groupList = [...groups.values()];
    const approaches = groupList.filter((g) => g.lanes.every((l) => atJ(ends.get(l.id))));
    const exits = groupList.filter((g) => g.lanes.every((l) => atJ(starts.get(l.id))));
    for (const a of approaches) {
      for (const e of exits) {
        if (e.roadId === a.roadId) continue;
        const fromRef = a.lanes[0].centerline;
        const toRef = e.lanes[0].centerline;
        const turn = classifyTurn(endHeading(fromRef, 'end'), endHeading(toRef, 'start'));
        for (const [fi, ti] of lanePairs(turn, a.lanes.length, e.lanes.length)) {
          const from = a.lanes[fi];
          const to = e.lanes[ti];
          if (bannedExit.has(to.id)) continue;
          if (map.restrictions.some((r) => r.junctionId === j.id && r.fromLaneIds.includes(from.id) && r.banned.includes(turn))) continue;
          const fc = from.centerline;
          const tc = to.centerline;
          out.push({
            id: `c-${from.id}-${to.id}`,
            fromLaneId: from.id,
            toLaneId: to.id,
            junctionId: j.id,
            centerline: bezierCenterline(fc[fc.length - 1], endHeading(fc, 'end'), tc[0], endHeading(tc, 'start')),
            turn,
            stopLineId: stopLineOf.get(from.id) ?? null,
          });
        }
      }
    }
  }
  return out.sort((x, y) => cmp(x.id, y.id));
}

/**
 * Stretch of `a`, by distance along it, that lies within `clearance` of `b`.
 * @param {Vec2[]} a Polyline.
 * @param {Vec2[]} b Polyline.
 * @param {number} clearance Distance.
 * @returns {[number, number] | null} Span, or null when they never come that close.
 */
export function closeSpan(a, b, clearance) {
  const len = polylineLength(a);
  const n = Math.max(1, Math.ceil(len / CONFLICT_STEP_M));
  let from = Infinity;
  let to = -Infinity;
  for (let i = 0; i <= n; i += 1) {
    const s = (len * i) / n;
    if (projectOntoPolyline(pointAtDistance(a, s).point, b).distance < clearance) {
      from = Math.min(from, s);
      to = Math.max(to, s);
    }
  }
  return from <= to ? [from, to] : null;
}

/**
 * Conflict zones between connectors of the same junction: `merge` where two connectors share an
 * exit lane, `cross` where two paths into different lanes come within `CONFLICT_CLEARANCE_M`.
 * Connectors from the same approach lane only diverge; they follow each other on that lane and
 * get no conflict. Ids are `cf-<junction>-<n>`, numbered in connector-id pair order.
 * @param {Connector[]} connectors Connectors.
 * @returns {Conflict[]} Conflicts, sorted by id.
 */
export function buildConflicts(connectors) {
  /** @type {Map<string, Connector[]>} */
  const byJunction = new Map();
  for (const c of connectors) {
    if (!byJunction.has(c.junctionId)) byJunction.set(c.junctionId, []);
    /** @type {Connector[]} */ (byJunction.get(c.junctionId)).push(c);
  }
  /** @type {Conflict[]} */
  const out = [];
  for (const [junctionId, list] of byJunction) {
    const sorted = [...list].sort((x, y) => cmp(x.id, y.id));
    let n = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      for (let k = i + 1; k < sorted.length; k += 1) {
        const a = sorted[i];
        const b = sorted[k];
        if (a.fromLaneId === b.fromLaneId) continue;
        const merge = a.toLaneId === b.toLaneId;
        const sa = closeSpan(a.centerline, b.centerline, CONFLICT_CLEARANCE_M);
        const sb = closeSpan(b.centerline, a.centerline, CONFLICT_CLEARANCE_M);
        if (!sa || !sb) continue;
        n += 1;
        out.push({
          id: `cf-${junctionId}-${String(n).padStart(3, '0')}`,
          a: a.id,
          b: b.id,
          aFromS: sa[0],
          aToS: sa[1],
          bFromS: sb[0],
          bToS: sb[1],
          kind: merge ? 'merge' : 'cross',
        });
      }
    }
  }
  return out.sort((x, y) => cmp(x.id, y.id));
}

/**
 * The lane graph of a map.
 * @param {GameMap} map Map.
 * @returns {LaneGraph} Graph.
 */
export function buildLaneGraph(map) {
  const { starts, ends, joins } = laneEnds(map);
  const connectors = buildConnectors(map, starts, ends);
  return { connectors, conflicts: buildConflicts(connectors), joins, starts, ends };
}
