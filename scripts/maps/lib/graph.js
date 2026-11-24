/**
 * Road network model shared by tutorial and OSM sources, the OSM corridor extraction, and the
 * split of a network into roads (between junctions) and junction clusters.
 *
 * A network way is an ordered list of nodes. Its reference direction is the node order; one-way
 * ways always travel forward (OSM `oneway=-1` ways are reversed on import). Positions along a way
 * are distances `s` from its first node, measured on the untrimmed polyline.
 */

import { cumulativeLengths, offsetPolyline, polygonsIntersect, slicePolyline } from '../../../src/geometry/index.js';

/** @typedef {[number, number]} Vec2 */

/**
 * One stretch of a painted line along a way, in way distances.
 * @typedef {object} LineStretch
 * @property {number} fromS Start distance along the way.
 * @property {number} toS End distance along the way (Infinity for the way end).
 * @property {'dashed' | 'solid' | 'double-solid' | 'mixed'} type Marking kind.
 * @property {'both' | 'left-to-right' | 'right-to-left' | 'none'} crossable Lawful crossing direction.
 */

/**
 * @typedef {object} NetWay
 * @property {string} id Way id, unique in the network.
 * @property {number} [osmWayId] Source OSM way id.
 * @property {string} cls Road class.
 * @property {string[]} nodeIds Node ids in order.
 * @property {boolean} oneway One-way (all lanes forward).
 * @property {boolean} divided Physically divided.
 * @property {boolean} priority Priority road (I.401) at unsignalised junctions.
 * @property {number} forward Forward lane count.
 * @property {number} backward Backward lane count (0 when one-way).
 * @property {LineStretch[]} centerLine Centre line between directions (two-way only).
 * @property {LineStretch[]} laneLine Lines between lanes of the same direction.
 * @property {{left: number, right: number}} pavement Pavement widths left and right of the reference direction.
 */

/**
 * @typedef {object} NetNode
 * @property {string} id Node id.
 * @property {Vec2} pos Position.
 * @property {Record<string, string>} [tags] OSM tags of the node.
 */

/**
 * @typedef {object} Network
 * @property {Map<string, NetNode>} nodes Nodes by id.
 * @property {NetWay[]} ways Ways.
 * @property {Set<string>} [signalNodes] OSM traffic-signal node ids (OSM maps).
 */

/**
 * A road: one stretch of a way between junctions (or way ends), trimmed back from junctions.
 * @typedef {object} TopoRoad
 * @property {string} id Road id.
 * @property {NetWay} way Source way.
 * @property {number} s0 Way distance of the trimmed start.
 * @property {number} s1 Way distance of the trimmed end.
 * @property {Vec2[]} points Trimmed reference polyline.
 * @property {string} startNode Node at the untrimmed start.
 * @property {string} endNode Node at the untrimmed end.
 * @property {string | null} startJunction Junction id at the start, if any.
 * @property {string | null} endJunction Junction id at the end, if any.
 */

/**
 * @typedef {object} TopoJunction
 * @property {string} id Junction id.
 * @property {string[]} nodeIds Network nodes merged into it.
 * @property {Vec2} centre Mean node position.
 * @property {number} trimM Distance roads are cut back from their junction node.
 */

/**
 * @typedef {object} Topology
 * @property {Network} network Network.
 * @property {TopoRoad[]} roads Roads in way order.
 * @property {TopoJunction[]} junctions Junctions.
 * @property {Map<string, string>} junctionOfNode Junction id per junction node.
 */

/** Distance below which two junction nodes joined by a way merge into one junction (m). */
export const CLUSTER_M = 15;
/** Shortest road kept between two junction trims (m). */
export const MIN_ROAD_M = 2;
/** Margin added to the widest half carriageway when trimming roads at a junction (m). */
export const TRIM_MARGIN_M = 1;

/**
 * Polyline of a way.
 * @param {Network} network Network.
 * @param {NetWay} way Way.
 * @returns {Vec2[]} Points.
 */
export function wayPoints(network, way) {
  return way.nodeIds.map((id) => {
    const node = network.nodes.get(id);
    if (!node) throw new Error(`way ${way.id}: unknown node ${id}`);
    return node.pos;
  });
}

/**
 * Lateral extent of a way's carriageway, positive to the left of the reference direction.
 * Two-way: forward lanes on the right of the reference line, backward on the left. One-way:
 * centred on the reference line.
 * @param {NetWay} way Way.
 * @param {number} laneWidth Lane width.
 * @returns {{lo: number, hi: number}} Lateral bounds.
 */
export function carriageway(way, laneWidth) {
  if (way.oneway) {
    const half = (way.forward * laneWidth) / 2;
    return { lo: -half, hi: half };
  }
  return { lo: -way.forward * laneWidth, hi: way.backward * laneWidth };
}

/**
 * Lateral extent of one direction's lanes.
 * @param {NetWay} way Way.
 * @param {'forward' | 'backward'} dir Direction.
 * @param {number} laneWidth Lane width.
 * @returns {{lo: number, hi: number}} Lateral bounds.
 */
export function directionSpan(way, dir, laneWidth) {
  const cw = carriageway(way, laneWidth);
  if (dir === 'forward') return { lo: cw.lo, hi: cw.lo + way.forward * laneWidth };
  if (way.backward === 0) throw new Error(`way ${way.id} has no backward lanes`);
  return { lo: cw.hi - way.backward * laneWidth, hi: cw.hi };
}

/**
 * Lateral extent of one lane. Index 0 is next to the right kerb of its own direction.
 * @param {NetWay} way Way.
 * @param {'forward' | 'backward'} dir Direction.
 * @param {number} index Lane index.
 * @param {number} laneWidth Lane width.
 * @returns {{lo: number, hi: number}} Lateral bounds.
 */
export function laneSpan(way, dir, index, laneWidth) {
  const count = dir === 'forward' ? way.forward : way.backward;
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`way ${way.id}: no ${dir} lane ${index}`);
  }
  const span = directionSpan(way, dir, laneWidth);
  if (dir === 'forward') return { lo: span.lo + index * laneWidth, hi: span.lo + (index + 1) * laneWidth };
  return { lo: span.hi - (index + 1) * laneWidth, hi: span.hi - index * laneWidth };
}

/**
 * Splits a network at junction nodes into trimmed roads and junction clusters.
 * @param {Network} network Network.
 * @param {{laneWidth: number, junctionTrims?: Map<string, number>}} options Lane width and per-node trim overrides.
 * @returns {Topology} Topology.
 */
export function splitNetwork(network, options) {
  const { laneWidth } = options;
  const ids = new Set();
  for (const way of network.ways) {
    if (ids.has(way.id)) throw new Error(`duplicate way id ${way.id}`);
    ids.add(way.id);
    if (way.nodeIds.length < 2) throw new Error(`way ${way.id} needs at least 2 nodes`);
  }

  /** @type {Map<string, number>} */
  const incidence = new Map();
  for (const way of network.ways) {
    way.nodeIds.forEach((id, i) => {
      const add = i === 0 || i === way.nodeIds.length - 1 ? 1 : 2;
      incidence.set(id, (incidence.get(id) ?? 0) + add);
    });
  }
  const isJunctionNode = (/** @type {string} */ id) => (incidence.get(id) ?? 0) >= 3;

  // Pieces between junction nodes (or way ends).
  /** @type {Array<{way: NetWay, i0: number, i1: number, sa: number, sb: number}>} */
  const pieces = [];
  for (const way of network.ways) {
    const cum = cumulativeLengths(wayPoints(network, way));
    let start = 0;
    for (let i = 1; i < way.nodeIds.length; i += 1) {
      if (i === way.nodeIds.length - 1 || isJunctionNode(way.nodeIds[i])) {
        pieces.push({ way, i0: start, i1: i, sa: cum[start], sb: cum[i] });
        start = i;
      }
    }
  }

  // Cluster junction nodes joined by a short piece.
  /** @type {Map<string, string>} */
  const parent = new Map();
  const find = (/** @type {string} */ x) => {
    let r = x;
    while (parent.get(r) !== r) r = /** @type {string} */ (parent.get(r));
    parent.set(x, r);
    return r;
  };
  for (const [id] of incidence) if (isJunctionNode(id)) parent.set(id, id);
  for (const p of pieces) {
    const a = p.way.nodeIds[p.i0];
    const b = p.way.nodeIds[p.i1];
    if (isJunctionNode(a) && isJunctionNode(b) && p.sb - p.sa < CLUSTER_M) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
  }
  /** @type {Map<string, string[]>} */
  const members = new Map();
  for (const id of [...parent.keys()].sort()) {
    const root = find(id);
    if (!members.has(root)) members.set(root, []);
    /** @type {string[]} */ (members.get(root)).push(id);
  }

  // Widest half carriageway at each cluster.
  /** @type {Map<string, number>} */
  const halfWidth = new Map();
  for (const way of network.ways) {
    const cw = carriageway(way, laneWidth);
    const half = Math.max(-cw.lo, cw.hi);
    for (const id of way.nodeIds) {
      if (!parent.has(id)) continue;
      const root = find(id);
      halfWidth.set(root, Math.max(halfWidth.get(root) ?? 0, half));
    }
  }

  /** @type {TopoJunction[]} */
  const junctions = [];
  /** @type {Map<string, string>} */
  const junctionOfNode = new Map();
  for (const [root, nodeIds] of members) {
    const id = `j-${root}`;
    const pts = nodeIds.map((n) => /** @type {NetNode} */ (network.nodes.get(n)).pos);
    const centre = /** @type {Vec2} */ ([
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ]);
    const override = nodeIds.map((n) => options.junctionTrims?.get(n)).find((v) => v !== undefined);
    const trimM = override ?? /** @type {number} */ (halfWidth.get(root)) + TRIM_MARGIN_M;
    junctions.push({ id, nodeIds, centre, trimM });
    for (const n of nodeIds) junctionOfNode.set(n, id);
  }
  const trimOf = new Map(junctions.map((j) => [j.id, j.trimM]));

  /** @type {TopoRoad[]} */
  const roads = [];
  /** @type {Map<string, number>} */
  const piecesPerWay = new Map();
  for (const p of pieces) {
    const a = p.way.nodeIds[p.i0];
    const b = p.way.nodeIds[p.i1];
    const ja = junctionOfNode.get(a) ?? null;
    const jb = junctionOfNode.get(b) ?? null;
    if (ja && ja === jb) continue; // inside one junction cluster
    piecesPerWay.set(p.way.id, (piecesPerWay.get(p.way.id) ?? 0) + 1);
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const p of pieces) {
    const a = p.way.nodeIds[p.i0];
    const b = p.way.nodeIds[p.i1];
    const ja = junctionOfNode.get(a) ?? null;
    const jb = junctionOfNode.get(b) ?? null;
    if (ja && ja === jb) continue;
    const k = (seen.get(p.way.id) ?? 0) + 1;
    seen.set(p.way.id, k);
    const id = piecesPerWay.get(p.way.id) === 1 ? p.way.id : `${p.way.id}-${k}`;
    const s0 = p.sa + (ja ? /** @type {number} */ (trimOf.get(ja)) : 0);
    const s1 = p.sb - (jb ? /** @type {number} */ (trimOf.get(jb)) : 0);
    if (s1 - s0 < MIN_ROAD_M) {
      throw new Error(
        `way ${p.way.osmWayId ?? p.way.id}: road ${id} is ${(p.sb - p.sa).toFixed(1)} m long, shorter than its junction trims; ` +
          'merge the junctions or set a smaller trimM in overrides',
      );
    }
    const points = slicePolyline(wayPoints(network, p.way), s0, s1);
    roads.push({ id, way: p.way, s0, s1, points, startNode: a, endNode: b, startJunction: ja, endJunction: jb });
  }

  return { network, roads, junctions, junctionOfNode };
}

/**
 * Road holding way distance `s`, and the distance along that road.
 * @param {Topology} topo Topology.
 * @param {string} wayId Way id.
 * @param {number} s Way distance.
 * @returns {{road: TopoRoad, s: number}} Road and road distance.
 */
export function locateOnWay(topo, wayId, s) {
  const roads = topo.roads.filter((r) => r.way.id === wayId);
  if (roads.length === 0) throw new Error(`unknown way ${wayId}`);
  const road = roads.find((r) => s >= r.s0 - 1e-9 && s <= r.s1 + 1e-9);
  if (!road) throw new Error(`way ${wayId}: s = ${s} m lies inside a junction or off the way`);
  return { road, s: s - road.s0 };
}

/**
 * The road that continues a road end through a non-junction node, with its direction.
 * @param {Topology} topo Topology.
 * @param {TopoRoad} road Current road.
 * @param {'forward' | 'backward'} dir Travel direction on the current road.
 * @returns {{road: TopoRoad, dir: 'forward' | 'backward'} | null} Next road, or null at a junction or dead end.
 */
export function continuation(topo, road, dir) {
  const node = dir === 'forward' ? road.endNode : road.startNode;
  if ((dir === 'forward' ? road.endJunction : road.startJunction) !== null) return null;
  for (const other of topo.roads) {
    if (other === road) continue;
    if (other.startNode === node && other.startJunction === null) return { road: other, dir: 'forward' };
    if (other.endNode === node && other.endJunction === null) {
      if (other.way.oneway) return null; // would travel against a one-way road
      return { road: other, dir: 'backward' };
    }
  }
  return null;
}

/**
 * Way distance of a node on a way.
 * @param {Network} network Network.
 * @param {NetWay} way Way.
 * @param {string} nodeId Node id.
 * @returns {number} Distance.
 */
export function nodeDistance(network, way, nodeId) {
  const i = way.nodeIds.indexOf(nodeId);
  if (i < 0) throw new Error(`way ${way.id} has no node ${nodeId}`);
  return cumulativeLengths(wayPoints(network, way))[i];
}

/**
 * @typedef {object} OsmElement
 * @property {'node' | 'way' | 'relation'} type Element type.
 * @property {number} id OSM id.
 * @property {number} [lat] Node latitude.
 * @property {number} [lon] Node longitude.
 * @property {number[]} [nodes] Way node ids.
 * @property {Array<{lat: number, lon: number}>} [geometry] Way node coordinates (`out geom`).
 * @property {Record<string, string>} [tags] Tags.
 */

/**
 * Per-way attributes decided by the caller (class defaults plus overrides).
 * @typedef {(osmWay: OsmElement, oneway: boolean) => Omit<NetWay, 'id' | 'osmWayId' | 'nodeIds' | 'oneway' | 'cls'>} WayAttributes
 */

/** Default length of the side-road stubs kept at each corridor junction (m); a map may ask for more. */
export const STUB_M = 30;
/** Step by which a stub that overlaps another road is shortened (m). */
export const STUB_SHORTEN_STEP_M = 10;
/** Lane width used for the stub overlap check when the caller gives none (m), as `LANE_WIDTH_M`. */
const DEFAULT_LANE_WIDTH_M = 3.5;

/** Highway classes that become side-road stubs; driveways and parking aisles are left out. */
export const STUB_CLASSES = Object.freeze([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

/**
 * OSM one-way state of a way.
 * @param {Record<string, string>} tags Tags.
 * @returns {'yes' | 'no' | 'reverse'} One-way state.
 */
export function osmOneway(tags) {
  const v = tags.oneway;
  if (v === '-1' || v === 'reverse') return 'reverse';
  if (v === 'yes' || v === 'true' || v === '1') return 'yes';
  if (v === undefined && (tags.junction === 'roundabout' || tags.highway === 'motorway')) return 'yes';
  return 'no';
}

/**
 * A side-road stub shorter than the length the map asked for, and why.
 * @typedef {object} StubNote
 * @property {number} osmWayId Side road OSM way id.
 * @property {string} nodeId Route node the stub hangs from.
 * @property {'in' | 'out'} side `in` runs towards the route node, `out` away from it.
 * @property {number} lengthM Kept length.
 * @property {string} reason Why it is shorter.
 */

/**
 * @typedef {object} StubPlan
 * @property {OsmElement} w Side road.
 * @property {NetWay} way Network way, node ids filled in last.
 * @property {string} nodeId Route node.
 * @property {'in' | 'out'} side Side.
 * @property {Vec2[]} points Available polyline, outward from the route node.
 * @property {number} lengthM Length to keep.
 * @property {string | null} reason Why it is shorter than asked, or null.
 */

/**
 * Builds the corridor network from an Overpass extract: the route's ways in order, plus a stub of
 * every side road that meets a route node. A stub is `options.stubM` long (default `STUB_M`) where
 * the street continues: along its own way, then along a way of the same name and one-way state
 * that shares its end node. It stops at the middle of the street towards another route node, and
 * the part beyond `STUB_M` is shortened where it would overlap another road. No whole-network
 * conversion.
 * @param {{elements: OsmElement[]}} raw Overpass JSON (`out body geom`).
 * @param {number[]} routeWayIds Route ways in driving order.
 * @param {import('./project.js').Projection} proj Projection.
 * @param {WayAttributes} attributes Lane and line attributes per way.
 * @param {{stubM?: number, laneWidth?: number}} [options] Stub length and the lane width for its overlap check.
 * @returns {{network: Network, routeDirs: Map<string, 'forward' | 'backward'>, osmNodes: Map<string, OsmElement>, stubNotes: StubNote[]}}
 *   Network, travel direction per route way id, tagged OSM nodes by network node id, and the
 *   stubs kept shorter than asked.
 */
export function osmCorridor(raw, routeWayIds, proj, attributes, options = {}) {
  if (!Array.isArray(raw?.elements)) throw new Error('raw extract has no elements array');
  /** @type {Map<number, OsmElement>} */
  const ways = new Map();
  /** @type {Map<string, OsmElement>} */
  const osmNodes = new Map();
  for (const e of raw.elements) {
    if (e.type === 'way' && e.tags?.highway) {
      if (!Array.isArray(e.nodes) || !Array.isArray(e.geometry) || e.nodes.length !== e.geometry.length) {
        throw new Error(`OSM way ${e.id}: missing nodes or geometry (fetch with "out body geom")`);
      }
      ways.set(e.id, e);
    } else if (e.type === 'node' && e.tags) osmNodes.set(`n${e.id}`, e);
  }
  if (routeWayIds.length === 0) throw new Error('route.ways is empty');

  /** @type {Map<string, NetNode>} */
  const nodes = new Map();
  /**
   * @param {string} id Node id.
   * @param {{lat: number, lon: number}} g Coordinates.
   */
  const addNode = (id, g) => {
    if (!nodes.has(id)) nodes.set(id, { id, pos: proj.toXZ(g.lat, g.lon), tags: osmNodes.get(id)?.tags });
  };

  /**
   * @param {OsmElement} w OSM way.
   * @param {string} id Network way id.
   * @param {string[]} nodeIds Node ids in reference order.
   * @returns {NetWay} Network way.
   */
  const toNetWay = (w, id, nodeIds) => {
    const tags = /** @type {Record<string, string>} */ (w.tags);
    const oneway = osmOneway(tags) !== 'no';
    return { id, osmWayId: w.id, cls: tags.highway, nodeIds, oneway, ...attributes(w, oneway) };
  };

  /** @type {NetWay[]} */
  const netWays = [];
  /** @type {Map<string, 'forward' | 'backward'>} */
  const routeDirs = new Map();
  /** @type {Set<string>} */
  const routeNodes = new Set();
  /** @type {string[][]} */
  const routeNodeLists = [];
  for (const wid of routeWayIds) {
    const w = ways.get(wid);
    if (!w) throw new Error(`route way ${wid} is not in the extract`);
    const ids = /** @type {number[]} */ (w.nodes).map((n) => `n${n}`);
    const geom = /** @type {Array<{lat: number, lon: number}>} */ (w.geometry);
    ids.forEach((id, i) => addNode(id, geom[i]));
    const reverse = osmOneway(/** @type {Record<string, string>} */ (w.tags)) === 'reverse';
    const nodeIds = reverse ? [...ids].reverse() : ids;
    netWays.push(toNetWay(w, `w${wid}`, nodeIds));
    routeNodeLists.push(nodeIds);
    for (const id of nodeIds) routeNodes.add(id);
  }

  // Travel direction of each route way from its shared end with the next (or previous) way.
  for (let i = 0; i < routeNodeLists.length; i += 1) {
    const cur = routeNodeLists[i];
    const way = netWays[i];
    /** @type {'forward' | 'backward'} */
    let dir;
    if (routeNodeLists.length === 1) dir = 'forward';
    else if (i < routeNodeLists.length - 1) {
      const next = routeNodeLists[i + 1];
      const shared = cur.find((n) => next[0] === n || next[next.length - 1] === n);
      if (shared === cur[cur.length - 1]) dir = 'forward';
      else if (shared === cur[0]) dir = 'backward';
      else throw new Error(`route ways ${routeWayIds[i]} and ${routeWayIds[i + 1]} do not share an end node`);
    } else {
      const prev = routeNodeLists[i - 1];
      const entry = routeDirs.get(netWays[i - 1].id) === 'forward' ? prev[prev.length - 1] : prev[0];
      if (entry === cur[0]) dir = 'forward';
      else if (entry === cur[cur.length - 1]) dir = 'backward';
      else throw new Error(`route ways ${routeWayIds[i - 1]} and ${routeWayIds[i]} do not share an end node`);
    }
    if (dir === 'backward' && way.oneway) {
      throw new Error(`route way ${routeWayIds[i]} is one-way and the route drives it backwards`);
    }
    if (i > 0) {
      const prev = routeNodeLists[i - 1];
      const exit = routeDirs.get(netWays[i - 1].id) === 'forward' ? prev[prev.length - 1] : prev[0];
      const entry = dir === 'forward' ? cur[0] : cur[cur.length - 1];
      if (exit !== entry) throw new Error(`route breaks between ways ${routeWayIds[i - 1]} and ${routeWayIds[i]}`);
    }
    routeDirs.set(way.id, dir);
  }

  // Stubs of side roads at route nodes, longest first where the street continues in the extract.
  const routeIds = new Set(routeWayIds);
  /** @type {Map<string, OsmElement[]>} side ways by end node, for same-street continuations */
  const sideWaysAt = new Map();
  /** @type {OsmElement[]} */
  const sideWays = [];
  for (const w of [...ways.values()].sort((a, b) => a.id - b.id)) {
    if (routeIds.has(w.id) || !STUB_CLASSES.includes(/** @type {Record<string, string>} */ (w.tags).highway)) continue;
    sideWays.push(w);
    const ns = /** @type {number[]} */ (w.nodes);
    for (const n of [ns[0], ns[ns.length - 1]]) {
      const key = `n${n}`;
      if (!sideWaysAt.has(key)) sideWaysAt.set(key, []);
      /** @type {OsmElement[]} */ (sideWaysAt.get(key)).push(w);
    }
  }
  const stubM = options.stubM ?? STUB_M;
  const laneWidth = options.laneWidth ?? DEFAULT_LANE_WIDTH_M;

  /** @type {StubPlan[]} */
  const plans = [];
  for (const w of sideWays) {
    const { ids, geom } = travelOrder(w);
    ids.forEach((id, i) => {
      if (!routeNodes.has(id)) return;
      addNode(id, geom[i]);
      for (const side of /** @type {const} */ (['in', 'out'])) {
        const chain = outwardChain(w, i, side, { proj, routeNodes, sideWaysAt, limitM: stubM });
        // Stop at the middle of the street towards another route node, but never below today's stub.
        const lengthM = Math.min(stubM, chain.lengthM, Math.max(Math.min(STUB_M, chain.lengthM), chain.routeNodeAtM / 2));
        if (lengthM < 1) continue;
        const way = toNetWay(w, `w${w.id}-${id.slice(1)}-${side}`, []);
        const reason = lengthM < stubM - 1e-6 ? chain.reason : null;
        plans.push({ w, way, nodeId: id, side, points: chain.points, lengthM, reason });
      }
    });
  }

  // The stretch of a stub beyond today's `STUB_M` must not overlap another road: shorten it in
  // `STUB_SHORTEN_STEP_M` steps until it does not. Stubs are settled in order; one not yet settled
  // counts at its `STUB_M` length.
  const routeNet = { nodes, ways: netWays };
  const routeBands = netWays.map((way) => ({ id: way.id, ring: wayBand(way, wayPoints(routeNet, way), laneWidth) }));
  plans.forEach((plan, k) => {
    const others = [
      ...routeBands,
        ...plans.flatMap((o, q) => {
        if (q === k) return [];
        const len = q < k ? o.lengthM : Math.min(o.lengthM, STUB_M);
        return [{ id: o.way.id, ring: wayBand(o.way, slicePolyline(o.points, 0, len), laneWidth) }];
      }),
    ];
    while (plan.lengthM > STUB_M + 1e-6) {
      const ext = wayBand(plan.way, slicePolyline(plan.points, STUB_M, plan.lengthM), laneWidth);
      const hit = others.find((o) => polygonsIntersect(ext, o.ring));
      if (!hit) break;
      plan.lengthM = Math.max(STUB_M, plan.lengthM - STUB_SHORTEN_STEP_M);
      plan.reason = `shortened to ${plan.lengthM.toFixed(0)} m: a longer stub overlaps ${hit.id}`;
    }
  });

  /** @type {StubNote[]} */
  const stubNotes = [];
  for (const plan of plans) {
    const piece = slicePolyline(plan.points, 0, plan.lengthM);
    const base = `n${plan.w.id}@${plan.nodeId.slice(1)}-${plan.side}`;
    // Outward from the route node: the cut point last; intermediate vertices get their own ids so
    // that no OSM node outside the corridor (a signal or crossing elsewhere) enters the network.
    /** @type {string[]} */
    const outIds = [plan.nodeId];
    for (let k = 1; k < piece.length; k += 1) {
      const nid = k === piece.length - 1 ? base : `${base}-p${k}`;
      nodes.set(nid, { id: nid, pos: piece[k] });
      outIds.push(nid);
    }
    plan.way.nodeIds = plan.side === 'in' ? outIds.reverse() : outIds;
    netWays.push(plan.way);
    if (plan.reason) {
      stubNotes.push({ osmWayId: plan.w.id, nodeId: plan.nodeId, side: plan.side, lengthM: plan.lengthM, reason: plan.reason });
    }
  }

  return { network: { nodes, ways: netWays }, routeDirs, osmNodes, stubNotes };
}

/**
 * Node ids and coordinates of an OSM way in its travel order (`oneway=-1` reversed).
 * @param {OsmElement} w OSM way.
 * @returns {{ids: string[], geom: Array<{lat: number, lon: number}>}} Ordered ids and coordinates.
 */
function travelOrder(w) {
  const ids = /** @type {number[]} */ (w.nodes).map((n) => `n${n}`);
  const geom = /** @type {Array<{lat: number, lon: number}>} */ (w.geometry);
  const reverse = osmOneway(/** @type {Record<string, string>} */ (w.tags)) === 'reverse';
  return reverse ? { ids: [...ids].reverse(), geom: [...geom].reverse() } : { ids, geom };
}

/**
 * The street away from a route node, up to `limitM`: along the side road's own way, then through
 * each end node onto the one way of the same name and one-way state that continues it in the same
 * travel direction (lowest OSM id first). Walking stops at another route node.
 * @param {OsmElement} w Side road.
 * @param {number} i Index of the route node in the travel order of `w`.
 * @param {'in' | 'out'} side `out` walks along the travel order, `in` against it.
 * @param {{proj: import('./project.js').Projection, routeNodes: Set<string>, sideWaysAt: Map<string, OsmElement[]>, limitM: number}} ctx Context.
 * @returns {{points: Vec2[], lengthM: number, routeNodeAtM: number, reason: string}} Points outward
 *   from the route node, their length, the distance to the next route node (Infinity when none)
 *   and why the street ends where it does.
 */
function outwardChain(w, i, side, ctx) {
  const { ids, geom } = travelOrder(w);
  /** @type {Vec2[]} */
  const points = [ctx.proj.toXZ(geom[i].lat, geom[i].lon)];
  let lengthM = 0;
  let routeNodeAtM = Infinity;
  const visited = new Set([w.id]);
  let cur = { w, ids, geom, k: i, step: side === 'out' ? 1 : -1 };
  const name = /** @type {Record<string, string>} */ (w.tags).name;
  const oneway = osmOneway(/** @type {Record<string, string>} */ (w.tags)) !== 'no';
  for (;;) {
    const next = cur.k + cur.step;
    if (next < 0 || next >= cur.ids.length) {
      // The way ends at the route node itself: the street beyond is the stub of its own way.
      if (lengthM === 0) return { points, lengthM, routeNodeAtM, reason: '' };
      const end = cur.ids[cur.k];
      const candidates = (ctx.sideWaysAt.get(end) ?? []).filter((o) => {
        const tags = /** @type {Record<string, string>} */ (o.tags);
        if (visited.has(o.id) || !name || tags.name !== name || (osmOneway(tags) !== 'no') !== oneway) return false;
        const order = travelOrder(o).ids;
        // Same travel direction: walking forward we enter at its first node, backward at its last.
        if (oneway) return side === 'out' ? order[0] === end : order[order.length - 1] === end;
        return order[0] === end || order[order.length - 1] === end;
      });
      if (candidates.length === 0) {
        return { points, lengthM, routeNodeAtM, reason: `the street ends after ${lengthM.toFixed(0)} m in the extract (no continuation of ${name ?? 'the unnamed way'} ${w.id})` };
      }
      const o = candidates[0];
      visited.add(o.id);
      const order = travelOrder(o);
      const atStart = order.ids[0] === end;
      cur = { w: o, ids: order.ids, geom: order.geom, k: atStart ? 0 : order.ids.length - 1, step: atStart ? 1 : -1 };
      continue;
    }
    const g = cur.geom[next];
    const p = ctx.proj.toXZ(g.lat, g.lon);
    const last = points[points.length - 1];
    lengthM += Math.hypot(p[0] - last[0], p[1] - last[1]);
    points.push(p);
    cur.k = next;
    if (ctx.routeNodes.has(cur.ids[next])) {
      routeNodeAtM = lengthM;
      return { points, lengthM, routeNodeAtM, reason: `the street meets the route again after ${lengthM.toFixed(0)} m` };
    }
    if (lengthM >= ctx.limitM) return { points, lengthM, routeNodeAtM, reason: '' };
  }
}

/**
 * Ground band of a way, carriageway plus pavements.
 * @param {NetWay} way Way (lanes and pavements).
 * @param {Vec2[]} points Polyline.
 * @param {number} laneWidth Lane width.
 * @returns {Vec2[]} Ring.
 */
function wayBand(way, points, laneWidth) {
  const cw = carriageway(way, laneWidth);
  const right = offsetPolyline(points, cw.lo - way.pavement.right);
  const left = offsetPolyline(points, cw.hi + way.pavement.left);
  return [...right, ...left.reverse()];
}
