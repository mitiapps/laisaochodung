/**
 * Compiles a `MapSpec` into a map JSON object (`src/contracts/map.js`): roads and junctions, then
 * zones, stop lines with one resolved control (light over sign over marking, QCVN 41 Điều 4),
 * signals, crosswalks, restrictions, entries, signs, pavements, obstacles, actors and the route.
 */

import {
  distance,
  footprint,
  headingOf,
  leftVector,
  offsetPolyline,
  pointInPolygon,
  polygonsIntersect,
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
/** @typedef {import('./zones.js').Placement} Placement */
/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/map.js').Zone} Zone */
/** @typedef {'forward' | 'backward'} Dir */

/** A traffic-signal node belongs to the nearest junction within this distance (m). */
export const SIGNAL_NODE_RANGE_M = 30;
/** A crosswalk this close to a junction edge moves the approach stop line behind it (m). */
export const STOP_LINE_CROSSWALK_RANGE_M = 15;
/** Gap between a stop line and the crosswalk or junction edge after it (m). */
export const STOP_LINE_GAP_M = 1;
/** Distance of a sign post or a signal head beyond the carriageway edge (m). */
export const POST_OFFSET_M = 1;

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
 * Compiles a spec into a map.
 * @param {MapSpec} spec Spec.
 * @returns {GameMap} Map (not yet rounded or validated).
 */
export function compileMap(spec) {
  /** @type {Map<string, number>} */
  const junctionTrims = new Map();
  for (const [node, j] of spec.junctions) if (j.trimM !== undefined) junctionTrims.set(node, j.trimM);
  const topo = splitNetwork(spec.network, { laneWidth: LANE_WIDTH_M, junctionTrims });
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
      const extent = walkExtent(topo, placement, endSignStop(placedSigns, ['DP.134'], placement));
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

  // Crosswalks.
  const crosswalks = spec.crosswalks.map((c) => {
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

  for (const j of topo.junctions) {
    const js = /** @type {import('./source.js').JunctionSpec} */ (junctionSpec.get(j.id));
    const signalized = js.signals !== null || signalizedByNode.has(j.id);
    const cycle = js.signals ?? DEFAULT_CYCLE;
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
      const near = crosswalks.filter(
        (c) =>
          c.road === road &&
          (dir === 'forward'
            ? c.s1 >= len - STOP_LINE_CROSSWALK_RANGE_M && c.s > len / 2
            : c.s0 <= STOP_LINE_CROSSWALK_RANGE_M && c.s < len / 2),
      );
      let stopS;
      if (near.length > 0) {
        stopS = dir === 'forward' ? Math.min(...near.map((c) => c.s0)) - STOP_LINE_GAP_M : Math.max(...near.map((c) => c.s1)) + STOP_LINE_GAP_M;
      } else stopS = dir === 'forward' ? len - STOP_LINE_GAP_M : STOP_LINE_GAP_M;
      if (stopS < 0 || stopS > len) throw new Error(`${spec.id}: no room for the stop line of road ${road.id} at ${j.id}`);

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
        const sameAxis = Math.abs(Math.sin(heading - axis)) < Math.SQRT1_2;
        signals.push({
          id: sigId,
          pos: pos2(head.point),
          heading,
          stopLineIds: [slId],
          cycle: { ...cycle, offset: sameAxis ? 0 : cycle.green + cycle.yellow },
        });
        for (const c of near) crosswalkSignal.set(c.id, sigId);
      }
      stopLines.push(line);
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
    return { id: a.id, kind: a.kind, model: a.model, lengthM: a.lengthM, widthM: a.widthM, path, speed: a.speed, trigger, loop: a.loop };
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
