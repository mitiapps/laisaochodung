/**
 * Typed buildings (`Obstacle` of kind `building` with `use`, `floors` and `frontEdge`).
 *
 * - OSM maps import every `building` footprint of the extract. Height comes from `height`, else
 *   `building:levels` times the storey height of the building's type, else a type default;
 *   `building:part` heights lift an outline that has no height of its own. Landmarks are named in
 *   `overrides.yaml`. A footprint that overlaps a lane or a junction is dropped and logged; when
 *   more than `MAX_DROPPED_SHARE` of them would be dropped the build stops.
 * - Tutorial rows written in `source.yaml` become shophouse rows, and every pavement edge left
 *   without a building gets generated shophouse rows from a seed of the map id. Some rows stand
 *   back behind a shop forecourt, where motorbikes park.
 *
 * Uses: `shophouse` a row of tube houses (nhà ống), `civic` a public or heritage building,
 * `tower` seven storeys or more, `compound` any other large or non-residential block, and
 * `landmark` a building named in the overrides.
 */

import { pointInPolygon, polygonCentroid, polygonSignedArea, polygonsIntersect, projectOntoPolyline } from '../../../src/geometry/index.js';
import { hash32, hashString, range, uniform } from '../../../src/world/random.js';
import { band } from './lanes.js';
import { sideStream } from './props.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('../../../src/contracts/map.js').Obstacle} Obstacle */
/** @typedef {NonNullable<Obstacle['use']>} BuildingUse */
/** @typedef {import('./props.js').RoadSide} RoadSide */
/** @typedef {import('./props.js').Blockers} Blockers */
/** @typedef {import('./props.js').Forecourt} Forecourt */
/** @typedef {import('./source.js').SourceYaml} SourceYaml */

/** Above this share of dropped OSM footprints the build stops instead of logging. */
export const MAX_DROPPED_SHARE = 0.1;

/** Storey heights by type (m, design): civic and heritage, office and residential towers, others. */
export const STOREY_M = Object.freeze({ civic: 4.5, office: 3.8, other: 3.4 });

/** Shophouse ground floor and upper storey heights (m, design inside TCVN 9411 ranges). */
export const SHOPHOUSE_GROUND_M = 3.9;
export const SHOPHOUSE_UPPER_M = 3.3;

/** Storeys from which a building is a tower. */
export const TOWER_FLOORS = 7;

/** Footprint area above which a non-civic, non-tower building is a compound (m², design). */
const COMPOUND_AREA_M2 = 1500;

/** Height of a `building=roof` canopy (m, design). */
const CANOPY_M = 4.5;

/** A front edge is only set within this distance of a road (m). */
const FRONT_EDGE_RANGE_M = 40;

/** OSM `building` values of civic buildings. */
const CIVIC_BUILDINGS = new Set([
  'civic',
  'government',
  'public',
  'church',
  'cathedral',
  'chapel',
  'temple',
  'palace',
  'courthouse',
  'townhall',
  'school',
  'hospital',
  'museum',
  'university',
]);
/** OSM `amenity` values of civic buildings. */
const CIVIC_AMENITIES = new Set([
  'townhall',
  'courthouse',
  'post_office',
  'place_of_worship',
  'school',
  'hospital',
  'police',
  'library',
  'university',
  'college',
]);
/** OSM `building` values with office-like storeys. */
const OFFICE_BUILDINGS = new Set(['office', 'hotel', 'apartments', 'commercial', 'retail']);
/** OSM `building` values that are compounds whatever their size. */
const COMPOUND_BUILDINGS = new Set(['roof', 'retail', 'commercial', 'industrial', 'warehouse', 'garage', 'garages', 'service']);

/** Generated tutorial rows (m and storeys, design). */
const ROW = Object.freeze({
  setbackM: 0.5,
  forecourtM: 2.5,
  forecourtShare: 0.35,
  depthM: [10, 16],
  lengthM: [18, 40],
  minM: 6,
  floors: [3, 5],
  stepM: 1,
});

/**
 * Height of a shophouse with a number of storeys.
 * @param {number} floors Storeys.
 * @returns {number} Height (m).
 */
export function shophouseHeight(floors) {
  return SHOPHOUSE_GROUND_M + (floors - 1) * SHOPHOUSE_UPPER_M;
}

/**
 * Storeys of a shophouse of a given height.
 * @param {number} height Height (m).
 * @returns {number} Storeys, at least 1.
 */
export function shophouseFloors(height) {
  return Math.max(1, Math.round((height - SHOPHOUSE_GROUND_M) / SHOPHOUSE_UPPER_M) + 1);
}

/**
 * Parses an OSM length such as `13.5` or `13.5 m`.
 * @param {string | undefined} v Tag value.
 * @returns {number | null} Metres, or null when absent or unreadable.
 */
function osmMetres(v) {
  if (v === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:m)?\s*$/.exec(v);
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parses `building:levels`.
 * @param {string | undefined} v Tag value.
 * @returns {number | null} Storeys, or null.
 */
function osmLevels(v) {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Whether OSM tags describe a civic or heritage building.
 * @param {Record<string, string>} tags Tags.
 * @returns {boolean} Civic.
 */
function isCivic(tags) {
  return CIVIC_BUILDINGS.has(tags.building) || CIVIC_AMENITIES.has(tags.amenity ?? '') || tags.heritage !== undefined;
}

/**
 * Type, storeys and height of an OSM building.
 * @param {Record<string, string>} tags Building tags.
 * @param {number} areaM2 Footprint area.
 * @param {number} seed Unsigned 32-bit seed for the storeys of an untagged building.
 * @param {number | null} partHeight Tallest `building:part` inside it, or null.
 * @returns {{use: BuildingUse, floors: number, height: number}} Typed building.
 */
export function typeOsmBuilding(tags, areaM2, seed, partHeight) {
  const civic = isCivic(tags);
  const storey = civic ? STOREY_M.civic : OFFICE_BUILDINGS.has(tags.building) ? STOREY_M.office : STOREY_M.other;
  const levels = osmLevels(tags['building:levels']);
  let height = osmMetres(tags.height);
  /** @type {number} */
  let floors;
  if (height !== null) floors = levels ?? Math.max(1, Math.round(height / storey));
  else if (levels !== null) {
    floors = levels;
    height = levels * storey;
  } else if (partHeight !== null) {
    height = partHeight;
    floors = Math.max(1, Math.round(height / storey));
  } else if (tags.building === 'roof') {
    floors = 1;
    height = CANOPY_M;
  } else {
    floors = tags.building === 'house' ? 4 : 3 + (seed % 3);
    height = floors * storey;
  }
  /** @type {BuildingUse} */
  let use;
  if (floors >= TOWER_FLOORS) use = 'tower';
  else if (civic) use = 'civic';
  else if (COMPOUND_BUILDINGS.has(tags.building) || OFFICE_BUILDINGS.has(tags.building) || areaM2 > COMPOUND_AREA_M2) use = 'compound';
  else use = 'shophouse';
  return { use, floors, height };
}

/**
 * A ring listed once, without repeated points, turned to the winding the converter's own bands
 * use (negative signed area in `[x, z]`).
 * @param {Vec2[]} pts Points, maybe closed.
 * @returns {Vec2[]} Ring.
 */
export function cleanRing(pts) {
  /** @type {Vec2[]} */
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-3) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-3) out.pop();
  return polygonSignedArea(out) > 0 ? out.reverse() : out;
}

/**
 * Index of the footprint edge facing the nearest road: the edge, at least a metre long, whose
 * midpoint lies closest to a road reference line, or none when no road is near.
 * @param {Vec2[]} ring Footprint.
 * @param {readonly Vec2[][]} roadLines Road reference polylines.
 * @returns {number | undefined} Edge index.
 */
export function frontEdgeOf(ring, roadLines) {
  let best = Infinity;
  /** @type {number | undefined} */
  let edge;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
    /** @type {Vec2} */
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const line of roadLines) {
      const d = projectOntoPolyline(mid, line).distance;
      if (d < best - 1e-9) {
        best = d;
        edge = i;
      }
    }
  }
  return best <= FRONT_EDGE_RANGE_M ? edge : undefined;
}

/**
 * Landmark overrides: `landmarks: [{osm: way/<id> | relation/<id>, floors?, heightM?, colour?, reason}]`,
 * `colour` being the facade colour as `#rrggbb`.
 * @param {unknown} list Value of the `landmarks` key.
 * @param {string} file File name for messages.
 * @returns {Map<string, {floors?: number, heightM?: number, colour?: string}>} By OSM key (`way/<id>`).
 */
export function parseLandmarks(list, file) {
  /** @type {Map<string, {floors?: number, heightM?: number, colour?: string}>} */
  const out = new Map();
  if (list === undefined || list === null) return out;
  if (!Array.isArray(list)) throw new Error(`${file} landmarks: expected a list`);
  list.forEach((raw, i) => {
    const w = `${file} landmarks[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${w}: expected a mapping`);
    const l = /** @type {SourceYaml} */ (raw);
    if (typeof l.reason !== 'string' || l.reason.trim() === '') throw new Error(`${w}.reason: every override needs a reason`);
    if (typeof l.osm !== 'string' || !/^(way|relation)\/[1-9]\d*$/.test(l.osm)) throw new Error(`${w}.osm: expected way/<id> or relation/<id>`);
    if (out.has(l.osm)) throw new Error(`${w}: ${l.osm} listed twice`);
    /** @type {{floors?: number, heightM?: number, colour?: string}} */
    const v = {};
    if (l.floors !== undefined) {
      if (!Number.isInteger(l.floors) || l.floors < 1) throw new Error(`${w}.floors: expected a whole number from 1`);
      v.floors = l.floors;
    }
    if (l.heightM !== undefined) {
      if (typeof l.heightM !== 'number' || !(l.heightM > 0)) throw new Error(`${w}.heightM: expected a positive height`);
      v.heightM = l.heightM;
    }
    if (l.colour !== undefined) {
      if (typeof l.colour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(l.colour)) throw new Error(`${w}.colour: expected #rrggbb`);
      v.colour = l.colour;
    }
    out.set(l.osm, v);
  });
  return out;
}

/**
 * @typedef {object} OsmBuildingElement
 * @property {'node' | 'way' | 'relation'} type Type.
 * @property {number} id Id.
 * @property {number[]} [nodes] Way node ids.
 * @property {Array<{lat: number, lon: number}>} [geometry] Way geometry.
 * @property {Array<{type: string, role: string, geometry?: Array<{lat: number, lon: number}>}>} [members] Relation members.
 * @property {Record<string, string>} [tags] Tags.
 */

/**
 * Outline ring of an OSM building way or relation (its single closed outer way), or null.
 * @param {OsmBuildingElement} e Element.
 * @param {(lat: number, lon: number) => Vec2} toXZ Projection.
 * @returns {Vec2[] | null} Ring.
 */
function outline(e, toXZ) {
  /** @type {Array<{lat: number, lon: number}> | undefined} */
  let g;
  if (e.type === 'way') g = e.geometry;
  else if (e.type === 'relation') {
    const outers = (e.members ?? []).filter((m) => m.type === 'way' && m.role === 'outer');
    if (outers.length === 1) g = outers[0].geometry;
  }
  if (!g || g.length < 4) return null;
  const first = g[0];
  const last = g[g.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) return null;
  const ring = cleanRing(g.map((q) => toXZ(q.lat, q.lon)));
  return ring.length >= 3 && Math.abs(polygonSignedArea(ring)) >= 2 ? ring : null;
}

/**
 * Imports the building footprints of an OSM extract.
 * @param {{elements: OsmBuildingElement[]}} raw Extract.
 * @param {(lat: number, lon: number) => Vec2} toXZ Projection.
 * @param {object} context Context.
 * @param {string} context.mapId Map id (seed).
 * @param {Blockers} context.lanes Lanes and junctions.
 * @param {Map<string, {floors?: number, heightM?: number, colour?: string}>} context.landmarks Landmark overrides.
 * @param {readonly Vec2[][]} context.roadLines Road reference polylines.
 * @returns {{obstacles: Obstacle[], notes: string[]}} Buildings and notes.
 */
export function importOsmBuildings(raw, toXZ, { mapId, lanes, landmarks, roadLines }) {
  const mapSeed = hashString(mapId);
  /** @type {Array<{ring: Vec2[], height: number}>} */
  const parts = [];
  /** @type {Array<{e: OsmBuildingElement, key: string}>} */
  const buildings = [];
  const elements = [...raw.elements].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type < b.type ? -1 : 1));
  for (const e of elements) {
    const tags = e.tags;
    if (!tags || (e.type !== 'way' && e.type !== 'relation')) continue;
    if (tags.building !== undefined && tags.building !== 'no') buildings.push({ e, key: `${e.type}/${e.id}` });
    else if (tags['building:part'] !== undefined && tags['building:part'] !== 'no') {
      const ring = outline(e, toXZ);
      const levels = osmLevels(tags['building:levels']);
      const height = osmMetres(tags.height) ?? (levels !== null ? levels * STOREY_M.other : null);
      if (ring && height !== null) parts.push({ ring, height });
    }
  }

  /** @type {Obstacle[]} */
  const obstacles = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const dropped = [];
  const found = new Set();
  for (const { e, key } of buildings) {
    const tags = /** @type {Record<string, string>} */ (e.tags);
    const label = `${key}${tags.name ? ` (${tags.name})` : ''}`;
    const ring = outline(e, toXZ);
    if (!ring) {
      notes.push(`building ${label} skipped: no single closed outline`);
      continue;
    }
    const hit = lanes.hit(ring);
    if (hit) {
      dropped.push(`${label} overlaps ${hit}`);
      continue;
    }
    const inside = parts.filter((p) => pointInPolygon(polygonCentroid(p.ring), ring));
    const partHeight = inside.length > 0 ? Math.max(...inside.map((p) => p.height)) : null;
    const typed = typeOsmBuilding(tags, Math.abs(polygonSignedArea(ring)), hash32(mapSeed, e.id), partHeight);
    const landmark = landmarks.get(key);
    if (landmark) {
      found.add(key);
      typed.use = 'landmark';
      if (landmark.floors !== undefined) typed.floors = landmark.floors;
      if (landmark.heightM !== undefined) typed.height = landmark.heightM;
    }
    /** @type {Obstacle} */
    const o = { id: `bd-osm-${e.type === 'way' ? 'w' : 'r'}${e.id}`, kind: 'building', footprint: ring, height: typed.height, use: typed.use, floors: typed.floors };
    const front = frontEdgeOf(ring, roadLines);
    if (front !== undefined) o.frontEdge = front;
    if (landmark?.colour !== undefined) o.colour = landmark.colour;
    obstacles.push(o);
  }
  for (const key of landmarks.keys()) {
    if (!found.has(key)) throw new Error(`landmark ${key} is not an imported building of the extract`);
  }
  const total = obstacles.length + dropped.length;
  for (const d of dropped) notes.push(`building ${d}: dropped`);
  if (total > 0 && dropped.length / total > MAX_DROPPED_SHARE) {
    throw new Error(`${dropped.length} of ${total} OSM buildings overlap a lane or junction, over ${MAX_DROPPED_SHARE * 100}%: ${dropped.join('; ')}`);
  }
  notes.push(`buildings: ${obstacles.length} imported from OSM, ${dropped.length} dropped`);
  return { obstacles, notes };
}

/**
 * Types tutorial building rows as shophouse rows, with storeys from their height.
 * @param {Obstacle[]} obstacles Map obstacles (changed in place).
 * @param {readonly Vec2[][]} roadLines Road reference polylines.
 */
export function typeTutorialRows(obstacles, roadLines) {
  for (const o of obstacles) {
    if (o.kind !== 'building' || o.use !== undefined) continue;
    o.use = 'shophouse';
    o.floors = shophouseFloors(o.height);
    const front = frontEdgeOf(o.footprint, roadLines);
    if (front !== undefined) o.frontEdge = front;
  }
}

/**
 * Band behind a pavement, between two distances from the kerb.
 * @param {RoadSide} side Side.
 * @param {number} s0 First station.
 * @param {number} s1 Last station.
 * @param {number} d0 Near distance from the kerb.
 * @param {number} d1 Far distance from the kerb.
 * @returns {Vec2[]} Ring.
 */
function sideBand(side, s0, s1, d0, d1) {
  const a = side.kerb + side.out * d0;
  const b = side.kerb + side.out * d1;
  return band(side.road.points, s0, s1, Math.min(a, b), Math.max(a, b));
}

/**
 * Generated shophouse rows along every pavement edge that has no building, from a seed of the
 * map id and the side. The edge is walked in one-metre steps; each clear run of at least
 * `ROW.minM` is cut into rows of seeded length, storeys and depth. A row with a forecourt stands
 * back so motorbikes park in front of it; a row is always given one where a frontage prop must
 * stand.
 * @param {string} mapId Map id.
 * @param {readonly RoadSide[]} sides Road sides.
 * @param {Blockers} blockers Lanes, junctions, pavements and existing obstacles; the new rows are
 *   added to it.
 * @param {readonly Vec2[][]} frontage Footprints of frontage props that must stay free.
 * @returns {{rows: Obstacle[], forecourts: Forecourt[]}} Rows and their forecourts.
 */
export function frontageRows(mapId, sides, blockers, frontage) {
  /** @type {Obstacle[]} */
  const rows = [];
  /** @type {Forecourt[]} */
  const forecourts = [];
  for (const side of sides) {
    const rng = sideStream(mapId, side.id, 'shophouse-rows');
    const depth = range(rng, ROW.depthM[0], ROW.depthM[1]);
    const near = side.widthM + ROW.setbackM;
    const far = side.widthM + ROW.forecourtM + depth;
    const steps = Math.floor(side.lengthM / ROW.stepM);
    /** @type {boolean[]} */
    const clear = [];
    for (let k = 0; k < steps; k += 1) {
      const slice = sideBand(side, k * ROW.stepM, (k + 1) * ROW.stepM, near, far);
      clear.push(blockers.hit(slice) === null);
    }
    let n = 0;
    for (let k = 0; k < steps; ) {
      if (!clear[k]) {
        k += 1;
        continue;
      }
      let end = k;
      while (end < steps && clear[end]) end += 1;
      const s0 = k * ROW.stepM;
      const s1 = end * ROW.stepM;
      k = end;
      if (s1 - s0 < ROW.minM) continue;
      for (let a = s0; a < s1 - 1e-9; ) {
        let b = a + range(rng, ROW.lengthM[0], ROW.lengthM[1]);
        if (b > s1 - ROW.minM) b = s1;
        const floors = ROW.floors[0] + Math.floor(uniform(rng) * (ROW.floors[1] - ROW.floors[0] + 1));
        const plain = sideBand(side, a, b, near, near + depth);
        let withForecourt = uniform(rng) < ROW.forecourtShare;
        if (!withForecourt && frontage.some((f) => polygonsIntersect(f, plain))) withForecourt = true;
        const setback = withForecourt ? ROW.forecourtM : ROW.setbackM;
        const ring = sideBand(side, a, b, side.widthM + setback, side.widthM + setback + depth);
        n += 1;
        const id = `bd-row-${side.id}-${n}`;
        /** @type {Obstacle} */
        const row = { id, kind: 'building', footprint: ring, height: shophouseHeight(floors), use: 'shophouse', floors };
        // The row's first edge runs along its kerb-side or far edge; the front faces the road.
        row.frontEdge = frontEdgeOf(ring, [side.road.points]);
        rows.push(row);
        blockers.add(ring, `building ${id}`);
        if (withForecourt) forecourts.push({ side, s0: a, s1: b, rowId: id });
        a = b;
      }
    }
  }
  return { rows, forecourts };
}
