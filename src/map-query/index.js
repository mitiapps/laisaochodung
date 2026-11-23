/**
 * Pure map lookups for the scorer, built on `src/geometry/`. Each map gets a grid spatial index,
 * built on first use and cached per map object, so a lookup tests only the elements in the cells
 * it touches.
 *
 * Conventions: positions are `{x, z}` or `[x, z]`; lane membership is point-in-polygon; a lane's
 * travel heading at a point comes from its centreline, which runs in the direction of travel.
 */

import { pointInPolygon, projectOntoPolyline, segmentCrossesPolyline, angleDiff } from '../geometry/index.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../contracts/index.js').Pos2} Pos2 */
/** @typedef {import('../contracts/index.js').Lane} Lane */
/** @typedef {import('../contracts/index.js').Road} Road */
/** @typedef {import('../contracts/index.js').Zone} Zone */
/** @typedef {import('../contracts/index.js').LaneLine} LaneLine */
/** @typedef {import('../contracts/index.js').StopLine} StopLine */
/** @typedef {import('../contracts/index.js').Entry} Entry */
/** @typedef {import('../contracts/index.js').Junction} Junction */
/** @typedef {import('../contracts/index.js').Crosswalk} Crosswalk */
/** @typedef {import('../contracts/index.js').Pavement} Pavement */
/** @typedef {import('../contracts/index.js').MapSign} MapSign */

/**
 * @typedef {object} Location
 * @property {string | null} roadId Road of the lane under the point.
 * @property {string | null} laneId Lane under the point.
 * @property {'forward' | 'backward' | null} laneDir Direction of that lane.
 * @property {string | null} junctionId Junction under the point.
 */

/**
 * @template T
 * @typedef {{item: T, fromSide: 'left' | 'right', point: Vec2, t: number}} Crossing
 */

/**
 * @typedef {object} Crossings
 * @property {(Crossing<LaneLine> & {roadId: string})[]} laneLines Lane lines crossed, by `t`.
 * @property {Crossing<StopLine>[]} stopLines Stop lines crossed, by `t`.
 * @property {Crossing<Entry>[]} entries Entry lines crossed, by `t`.
 */

/** Grid cell size in metres. */
export const CELL_M = 10;

/**
 * Uniform grid over item bounding boxes.
 * @template T
 */
class Grid {
  constructor() {
    /** @type {Map<string, number[]>} */
    this.cells = new Map();
    /** @type {T[]} */
    this.items = [];
  }

  /**
   * @param {T} item Item.
   * @param {Vec2[]} points Points whose bounding box the item covers.
   */
  insert(item, points) {
    const index = this.items.length;
    this.items.push(item);
    const [x0, z0, x1, z1] = bbox(points);
    for (let i = Math.floor(x0 / CELL_M); i <= Math.floor(x1 / CELL_M); i += 1) {
      for (let j = Math.floor(z0 / CELL_M); j <= Math.floor(z1 / CELL_M); j += 1) {
        const key = `${i},${j}`;
        const list = this.cells.get(key);
        if (list) list.push(index);
        else this.cells.set(key, [index]);
      }
    }
  }

  /**
   * Items whose cells overlap the box, in insertion order.
   * @param {number} x0 Min x.
   * @param {number} z0 Min z.
   * @param {number} x1 Max x.
   * @param {number} z1 Max z.
   * @returns {T[]} Candidates.
   */
  query(x0, z0, x1, z1) {
    /** @type {Set<number>} */
    const found = new Set();
    for (let i = Math.floor(x0 / CELL_M); i <= Math.floor(x1 / CELL_M); i += 1) {
      for (let j = Math.floor(z0 / CELL_M); j <= Math.floor(z1 / CELL_M); j += 1) {
        for (const k of this.cells.get(`${i},${j}`) ?? []) found.add(k);
      }
    }
    return [...found].sort((a, b) => a - b).map((k) => this.items[k]);
  }

  /**
   * @param {Vec2} p Point.
   * @param {number} [r] Radius.
   * @returns {T[]} Candidates near the point.
   */
  near(p, r = 0) {
    return this.query(p[0] - r, p[1] - r, p[0] + r, p[1] + r);
  }
}

/**
 * @param {Vec2[]} points Points.
 * @returns {[number, number, number, number]} `[minX, minZ, maxX, maxZ]`.
 */
function bbox(points) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/**
 * @typedef {object} MapIndex
 * @property {Grid<{lane: Lane, road: Road}>} lanes Lanes with their road.
 * @property {Grid<Junction>} junctions Junctions.
 * @property {Grid<Zone>} zones Zones.
 * @property {Grid<Crosswalk>} crosswalks Crosswalks.
 * @property {Grid<Pavement>} pavements Pavements.
 * @property {Grid<{line: LaneLine, road: Road}>} laneLines Lane lines.
 * @property {Grid<StopLine>} stopLines Stop lines.
 * @property {Grid<Entry>} entries Entries.
 * @property {Map<string, {lane: Lane, road: Road}>} laneById Lanes by id.
 * @property {Map<string, Road>} roadById Roads by id.
 * @property {Map<string, Junction>} junctionById Junctions by id.
 * @property {Map<string, MapSign>} signById Signs by id.
 * @property {Map<string, StopLine[]>} stopLinesByLane Stop lines binding each lane.
 */

/** @type {WeakMap<GameMap, MapIndex>} */
const CACHE = new WeakMap();

/**
 * Index of a map, built once per map object.
 * @param {GameMap} map Map.
 * @returns {MapIndex} Index.
 */
export function mapIndex(map) {
  const cached = CACHE.get(map);
  if (cached) return cached;
  /** @type {MapIndex} */
  const idx = {
    lanes: new Grid(),
    junctions: new Grid(),
    zones: new Grid(),
    crosswalks: new Grid(),
    pavements: new Grid(),
    laneLines: new Grid(),
    stopLines: new Grid(),
    entries: new Grid(),
    laneById: new Map(),
    roadById: new Map(),
    junctionById: new Map(),
    signById: new Map(),
    stopLinesByLane: new Map(),
  };
  for (const road of map.roads) {
    idx.roadById.set(road.id, road);
    for (const lane of road.lanes) {
      idx.lanes.insert({ lane, road }, lane.polygon);
      idx.laneById.set(lane.id, { lane, road });
    }
    for (const line of road.laneLines) idx.laneLines.insert({ line, road }, line.polyline);
  }
  for (const j of map.junctions) {
    idx.junctions.insert(j, j.polygon);
    idx.junctionById.set(j.id, j);
  }
  for (const z of map.zones) idx.zones.insert(z, z.polygon);
  for (const c of map.crosswalks) idx.crosswalks.insert(c, c.polygon);
  for (const p of map.pavements) idx.pavements.insert(p, p.polygon);
  for (const s of map.stopLines) {
    idx.stopLines.insert(s, s.segment);
    for (const laneId of s.laneIds) idx.stopLinesByLane.set(laneId, [...(idx.stopLinesByLane.get(laneId) ?? []), s]);
  }
  for (const e of map.entries) idx.entries.insert(e, e.segment);
  for (const s of map.signs) idx.signById.set(s.id, s);
  CACHE.set(map, idx);
  return idx;
}

/**
 * @param {Pos2 | Vec2} p Position.
 * @returns {Vec2} Tuple.
 */
function vec(p) {
  return Array.isArray(p) ? p : [p.x, p.z];
}

/**
 * Travel heading of a lane at the point of its centreline nearest to `pos`.
 * @param {GameMap} map Map.
 * @param {string} laneId Lane id.
 * @param {Pos2 | Vec2} pos Position.
 * @returns {number} Heading θ.
 */
export function laneHeadingAt(map, laneId, pos) {
  const entry = mapIndex(map).laneById.get(laneId);
  if (!entry) throw new Error(`Unknown lane "${laneId}"`);
  return projectOntoPolyline(vec(pos), entry.lane.centerline).heading;
}

/**
 * Road, lane and junction under a point. When lanes overlap, the one whose travel heading is
 * closest to `heading` wins.
 * @param {GameMap} map Map.
 * @param {Pos2 | Vec2} pos Position.
 * @param {number} heading Heading θ of the body at the point.
 * @returns {Location} Location; fields are null where nothing is under the point.
 */
export function locate(map, pos, heading) {
  const p = vec(pos);
  const idx = mapIndex(map);
  /** @type {{lane: Lane, road: Road} | null} */
  let best = null;
  let bestDiff = Infinity;
  for (const cand of idx.lanes.near(p)) {
    if (!pointInPolygon(p, cand.lane.polygon)) continue;
    const diff = Math.abs(angleDiff(heading, projectOntoPolyline(p, cand.lane.centerline).heading));
    if (diff < bestDiff) {
      best = cand;
      bestDiff = diff;
    }
  }
  const junction = idx.junctions.near(p).find((j) => pointInPolygon(p, j.polygon)) ?? null;
  return {
    roadId: best ? best.road.id : null,
    laneId: best ? best.lane.id : null,
    laneDir: best ? best.lane.dir : null,
    junctionId: junction ? junction.id : null,
  };
}

/**
 * Zones containing a point. A zone binds only the lanes in its `laneIds`, so with a lane given
 * only zones binding that lane are returned. With `laneId` null (in a junction or off the
 * carriageway) every zone containing the point is returned, for area-wide types such as
 * `built-up` and `lit`; callers must not take a lane-bound limit from that case.
 * @param {GameMap} map Map.
 * @param {Pos2 | Vec2} pos Position.
 * @param {string | null} laneId Lane under the point.
 * @returns {Zone[]} Zones in map order.
 */
export function zonesAt(map, pos, laneId) {
  const p = vec(pos);
  return mapIndex(map)
    .zones.near(p)
    .filter((z) => (laneId === null || z.laneIds.includes(laneId)) && pointInPolygon(p, z.polygon));
}

/**
 * Lane lines, stop lines and entry lines crossed by the move `prevPos → pos`, each sorted by the
 * crossing parameter `t` along the move. `fromSide` is the side of `prevPos` relative to the
 * crossed line's direction (see `segmentCrossesPolyline`).
 * @param {GameMap} map Map.
 * @param {Pos2 | Vec2} prevPos Previous position.
 * @param {Pos2 | Vec2} pos Current position.
 * @returns {Crossings} Crossings.
 */
export function crossedLines(map, prevPos, pos) {
  const a = vec(prevPos);
  const b = vec(pos);
  const idx = mapIndex(map);
  const box = /** @type {const} */ ([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
  /** @type {Crossings} */
  const out = { laneLines: [], stopLines: [], entries: [] };
  if (a[0] === b[0] && a[1] === b[1]) return out;
  for (const { line, road } of idx.laneLines.query(...box)) {
    const hit = segmentCrossesPolyline(a, b, line.polyline);
    if (hit) out.laneLines.push({ item: line, roadId: road.id, fromSide: hit.fromSide, point: hit.point, t: hit.t });
  }
  for (const s of idx.stopLines.query(...box)) {
    const hit = segmentCrossesPolyline(a, b, s.segment);
    if (hit) out.stopLines.push({ item: s, fromSide: hit.fromSide, point: hit.point, t: hit.t });
  }
  for (const e of idx.entries.query(...box)) {
    const hit = segmentCrossesPolyline(a, b, e.segment);
    if (hit) out.entries.push({ item: e, fromSide: hit.fromSide, point: hit.point, t: hit.t });
  }
  for (const list of [out.laneLines, out.stopLines, out.entries]) list.sort((x, y) => x.t - y.t);
  return out;
}

/**
 * Crosswalks containing a point.
 * @param {GameMap} map Map.
 * @param {Pos2 | Vec2} pos Position.
 * @returns {Crosswalk[]} Crosswalks.
 */
export function crosswalksAt(map, pos) {
  const p = vec(pos);
  return mapIndex(map)
    .crosswalks.near(p)
    .filter((c) => pointInPolygon(p, c.polygon));
}

/**
 * Crosswalks a body footprint overlaps (a corner inside, or the crosswalk's edge inside the body).
 * @param {GameMap} map Map.
 * @param {Vec2[]} footprint Body rectangle.
 * @returns {Crosswalk[]} Crosswalks.
 */
export function crosswalksOverlapping(map, footprint) {
  const [x0, z0, x1, z1] = bbox(footprint);
  return mapIndex(map)
    .crosswalks.query(x0, z0, x1, z1)
    .filter((c) => polygonsOverlap(footprint, c.polygon));
}

/**
 * Crosswalks within `radius` of a point (inside counts as distance 0).
 * @param {GameMap} map Map.
 * @param {Pos2 | Vec2} pos Position.
 * @param {number} radius Distance in metres.
 * @returns {Crosswalk[]} Crosswalks.
 */
export function crosswalksNear(map, pos, radius) {
  const p = vec(pos);
  return mapIndex(map)
    .crosswalks.near(p, radius)
    .filter((c) => distanceToPolygon(p, c.polygon) <= radius);
}

/**
 * Pavements containing a point.
 * @param {GameMap} map Map.
 * @param {Pos2 | Vec2} pos Position.
 * @returns {Pavement[]} Pavements.
 */
export function pavementsAt(map, pos) {
  const p = vec(pos);
  return mapIndex(map)
    .pavements.near(p)
    .filter((v) => pointInPolygon(p, v.polygon));
}

/**
 * Junctions within `radius` of any of the points (inside counts as distance 0).
 * @param {GameMap} map Map.
 * @param {Vec2[]} points Points, e.g. a footprint.
 * @param {number} radius Distance in metres.
 * @returns {Junction[]} Junctions.
 */
export function junctionsNear(map, points, radius) {
  const [x0, z0, x1, z1] = bbox(points);
  return mapIndex(map)
    .junctions.query(x0 - radius, z0 - radius, x1 + radius, z1 + radius)
    .filter((j) => points.some((p) => distanceToPolygon(p, j.polygon) <= radius) || polygonsOverlap(points, j.polygon));
}

/**
 * Distance from a point to a polygon: 0 inside, else to the nearest edge.
 * @param {Vec2} p Point.
 * @param {Vec2[]} polygon Ring.
 * @returns {number} Distance in metres.
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
 * Whether two convex-or-simple rings share area (a vertex of one inside the other or edges cross).
 * @param {Vec2[]} a Ring.
 * @param {Vec2[]} b Ring.
 * @returns {boolean} Overlap.
 */
function polygonsOverlap(a, b) {
  if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) return true;
  for (let i = 0, j = a.length - 1; i < a.length; j = i, i += 1) {
    const closed = [...b, b[0]];
    if (segmentCrossesPolyline(a[j], a[i], closed)) return true;
  }
  return false;
}

/**
 * Road and lane records by id.
 * @param {GameMap} map Map.
 * @param {string} laneId Lane id.
 * @returns {{lane: Lane, road: Road} | null} Lane with its road.
 */
export function laneById(map, laneId) {
  return mapIndex(map).laneById.get(laneId) ?? null;
}

/**
 * @param {GameMap} map Map.
 * @param {string} roadId Road id.
 * @returns {Road | null} Road.
 */
export function roadById(map, roadId) {
  return mapIndex(map).roadById.get(roadId) ?? null;
}

/**
 * @param {GameMap} map Map.
 * @param {string} junctionId Junction id.
 * @returns {Junction | null} Junction.
 */
export function junctionById(map, junctionId) {
  return mapIndex(map).junctionById.get(junctionId) ?? null;
}

/**
 * @param {GameMap} map Map.
 * @param {string} signId Sign id.
 * @returns {MapSign | null} Sign.
 */
export function signById(map, signId) {
  return mapIndex(map).signById.get(signId) ?? null;
}

/**
 * Stop lines that bind a lane.
 * @param {GameMap} map Map.
 * @param {string} laneId Lane id.
 * @returns {StopLine[]} Stop lines.
 */
export function stopLinesForLane(map, laneId) {
  return mapIndex(map).stopLinesByLane.get(laneId) ?? [];
}
