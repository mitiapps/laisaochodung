/**
 * Pure building layout for the procedural streetscape: no three.js, so Node tests run it as is.
 *
 * Every random draw comes from `streamFor(hashString(map.id), map.id, buildingIndex)`, so the
 * same map always looks the same and no traffic or run seed ever reaches the scenery.
 *
 * A building's street face is its front edge: `frontEdge` when the map sets it, otherwise the
 * footprint edge whose midpoint lies nearest a lane centreline. The facade frame puts `s` along
 * that edge and `d` into the building, so a tube-house row is a run of lots `[s0, s1]` along it.
 *
 * Dimensions (all `paramBasis: design` unless a source is named):
 *
 * | Value | Range | Basis |
 * | --- | --- | --- |
 * | Lot width | 3.5–5 m | design, around the ~4 m frontage of a tube house (Wikipedia, "Tube house") |
 * | Tube-house storeys | 3–5 | design |
 * | Ground floor | 3.6–4.2 m | design, at or above the 3.6 m clear height of TCVN 9411:2012 (secondhand) |
 * | Upper floor | 3.3 m | design |
 * | Balcony depth | 0.6–1.2 m | design; QCVN 01:2021/BXD sets no figure |
 * | Civic storey | 4.5 m | design; matches the Saigon Central Post Office, 13.5 m (OSM `height`) over 3 levels |
 * | Tower storey | 3.8 m | design |
 * | Tower podium | 1–4 storeys of 4.5 m | design |
 */

import { headingOf, polygonCentroid, projectOntoPolyline } from '../../geometry/index.js';
import { hashString, pick, range, streamFor, uniform } from '../../world/random.js';
import { SHOP_NAMES } from './shop-names.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/map.js').Obstacle} Obstacle */
/** @typedef {import('../../world/random.js').RandomStream} RandomStream */
/** @typedef {[number, number]} Vec2 */

/** Lot widths along a tube-house frontage. */
export const LOT_WIDTH_M = Object.freeze({ min: 3.5, max: 5 });
/** Storeys of a tube house when the map gives no `floors`. */
export const SHOPHOUSE_STOREYS = Object.freeze({ min: 3, max: 5 });
/** Ground-floor height range of a tube house. */
export const GROUND_FLOOR_M = Object.freeze({ min: 3.6, max: 4.2 });
/** Upper-floor height of a tube house. */
export const UPPER_FLOOR_M = 3.3;
/** Balcony depth range. */
export const BALCONY_M = Object.freeze({ min: 0.6, max: 1.2 });
/** Storey height of colonial civic buildings. */
export const CIVIC_STOREY_M = 4.5;
/** Storey height of towers. */
export const TOWER_STOREY_M = 3.8;

/** Facade paints of tube houses (sRGB): HCMC pastels, cream, white and bright accents. */
export const SHOPHOUSE_PAINTS = Object.freeze([
  0xf3e2a9, 0xb9e0c9, 0xf5c6c6, 0xaed2ec, 0xf4ecd8, 0xf2f2ee, 0xf6b26b, 0xd5c3e8, 0xe9f08a, 0x9fd8d3,
]);
/** Colonial civic render, trim, shutters and roof tiles. */
export const CIVIC_COLORS = Object.freeze({ render: 0xe9cf73, trim: 0xf7f4ea, shutter: 0x2f6b3f, roof: 0xa4512f });
/** Landmark colour when the map gives none: fired brick. */
export const LANDMARK_RENDER = 0xc8694a;

/**
 * Street face of a building in a local frame: `s` runs from `a` along `along`, `d` into the
 * building (against `out`). `out` is always `(−along.z, along.x)`, the local +Z of a frame
 * turned by `yaw` (three.js `rotation.y`), so facade pieces can be built as local boxes.
 * @typedef {object} FacadeFrame
 * @property {Vec2} a Start of the front edge.
 * @property {Vec2} along Unit vector along the front edge.
 * @property {Vec2} out Unit outward normal of the front edge (towards the street).
 * @property {number} yaw Yaw of the frame.
 * @property {number} length Front edge length.
 * @property {number} depth Deepest footprint point behind the front edge.
 */

/**
 * @typedef {object} Lot
 * @property {number} s0 Start along the frontage.
 * @property {number} s1 End along the frontage.
 * @property {Vec2[]} polygon Footprint of the lot (the building footprint cut to `[s0, s1]`).
 * @property {number} storeys Storeys including the ground floor.
 * @property {number} groundM Ground-floor height.
 * @property {number} upperM Upper-floor height.
 * @property {number} heightM Roof height.
 * @property {number} paint Facade colour.
 * @property {number} balconyM Balcony depth.
 * @property {'iron' | 'solid'} railing Balcony railing.
 * @property {'open' | 'closed' | 'half'} shutter Roller shutter state.
 * @property {number | null} sign Index into `SHOP_NAMES`, or null for no board.
 * @property {boolean} awning Awning over the shop front.
 * @property {boolean[]} ac Air-conditioner unit per upper floor.
 * @property {boolean[]} lit Lit window per upper floor at night.
 * @property {boolean} tank Rooftop water tank.
 * @property {boolean} shed Corrugated-iron roof shed.
 */

/**
 * @typedef {object} ShophouseLayout
 * @property {'shophouse'} use Use.
 * @property {string} id Building id.
 * @property {FacadeFrame} frame Street face.
 * @property {Lot[]} lots Lots in frontage order.
 */

/**
 * @typedef {object} CivicLayout
 * @property {'civic' | 'landmark' | 'compound'} use Use.
 * @property {string} id Building id.
 * @property {Vec2[]} footprint Footprint.
 * @property {FacadeFrame} frame Street face.
 * @property {number} storeys Storeys.
 * @property {number} heightM Eaves height.
 * @property {number} render Wall colour.
 * @property {number | null} fenceM Distance of the front fence ahead of the facade, or null.
 * @property {RandomStream} rng Stream for per-window draws, already past the layout draws.
 */

/**
 * @typedef {object} TowerLayout
 * @property {'tower'} use Use.
 * @property {string} id Building id.
 * @property {Vec2[]} footprint Footprint.
 * @property {FacadeFrame} frame Street face.
 * @property {number} podiumStoreys Podium storeys.
 * @property {number} podiumM Podium height.
 * @property {number} heightM Roof height.
 * @property {number} glass Curtain-wall tint.
 * @property {RandomStream} rng Stream for per-window draws.
 */

/** @typedef {ShophouseLayout | CivicLayout | TowerLayout} BuildingLayout */

/**
 * The scenery stream of one building.
 * @param {string} mapId Map id.
 * @param {number} index Building index among the map's building obstacles.
 * @returns {RandomStream} Stream.
 */
export function sceneryStream(mapId, index) {
  return streamFor(hashString(mapId), mapId, index);
}

/**
 * Integer draw in `[min, max]`.
 * @param {RandomStream} rng Stream.
 * @param {number} min Lowest value.
 * @param {number} max Highest value.
 * @returns {number} Value.
 */
function intIn(rng, min, max) {
  return Math.min(max, min + Math.floor(uniform(rng) * (max - min + 1)));
}

/**
 * Index of the footprint edge facing the street: the map's `frontEdge`, otherwise the edge whose
 * midpoint is nearest a lane centreline (edge 0 on a map without lanes).
 * @param {Obstacle} building Building obstacle.
 * @param {GameMap} map Map.
 * @returns {number} Edge index.
 */
export function frontEdgeIndex(building, map) {
  const n = building.footprint.length;
  if (building.frontEdge !== undefined) {
    if (!Number.isInteger(building.frontEdge) || building.frontEdge < 0 || building.frontEdge >= n) {
      throw new RangeError(`Building ${building.id} has frontEdge ${building.frontEdge} outside its ${n} edges`);
    }
    return building.frontEdge;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i += 1) {
    const a = building.footprint[i];
    const b = building.footprint[(i + 1) % n];
    /** @type {Vec2} */
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const road of map.roads) {
      for (const lane of road.lanes) {
        if (lane.centerline.length < 2) continue;
        const d = projectOntoPolyline(mid, lane.centerline).distance;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}

/**
 * Facade frame of a footprint edge. The edge runs so that its outward normal is the frame's +Z;
 * when the ring's winding gives the opposite, the edge is walked from its far end.
 * @param {Vec2[]} footprint Footprint ring.
 * @param {number} edge Edge index.
 * @returns {FacadeFrame} Frame.
 */
export function facadeFrame(footprint, edge) {
  const p = footprint[edge];
  const q = footprint[(edge + 1) % footprint.length];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (!(len > 1e-6)) throw new RangeError('facadeFrame needs an edge of non-zero length');
  const c = polygonCentroid(footprint);
  let a = p;
  let along = /** @type {Vec2} */ ([(q[0] - p[0]) / len, (q[1] - p[1]) / len]);
  let out = /** @type {Vec2} */ ([-along[1], along[0]]);
  // The centroid lies behind the facade; flip the walking direction when `out` points at it.
  if ((c[0] - p[0]) * out[0] + (c[1] - p[1]) * out[1] > 0) {
    a = q;
    along = [-along[0], -along[1]];
    out = [-along[1], along[0]];
  }
  let depth = 0;
  for (const v of footprint) depth = Math.max(depth, -((v[0] - a[0]) * out[0] + (v[1] - a[1]) * out[1]));
  return { a: [a[0], a[1]], along, out, yaw: headingOf(along[0], along[1]), length: len, depth };
}

/**
 * Frame coordinates `[s, d]` of a world point.
 * @param {FacadeFrame} f Frame.
 * @param {Vec2} p Point.
 * @returns {Vec2} `[s, d]`.
 */
export function toFrame(f, p) {
  const dx = p[0] - f.a[0];
  const dz = p[1] - f.a[1];
  return [dx * f.along[0] + dz * f.along[1], -(dx * f.out[0] + dz * f.out[1])];
}

/**
 * World point of frame coordinates.
 * @param {FacadeFrame} f Frame.
 * @param {number} s Along the front edge.
 * @param {number} d Into the building.
 * @returns {Vec2} World `[x, z]`.
 */
export function fromFrame(f, s, d) {
  return [f.a[0] + f.along[0] * s - f.out[0] * d, f.a[1] + f.along[1] * s - f.out[1] * d];
}

/**
 * Splits a frontage into lot intervals that tile `[0, length]` with no gap or overlap. Widths
 * stay within `LOT_WIDTH_M` whenever some lot count allows it; the few lengths no count can tile
 * so (under 3.5 m, between 5 and 7 m, between 10 and 10.5 m) get the nearest even split.
 * @param {number} length Frontage length.
 * @param {RandomStream} rng Stream.
 * @returns {[number, number][]} Intervals in order.
 */
export function splitFrontage(length, rng) {
  if (!(length > 0)) throw new RangeError(`splitFrontage needs a positive length, got ${length}`);
  const { min, max } = LOT_WIDTH_M;
  const lo = Math.max(1, Math.ceil(length / max - 1e-9));
  const hi = Math.floor(length / min + 1e-9);
  const n = lo <= hi ? intIn(rng, lo, hi) : Math.max(1, Math.round(length / ((min + max) / 2)));
  const w = new Array(n).fill(length / n);
  if (lo <= hi) {
    // Pairwise moves keep the sum and both widths inside the range.
    for (let i = 0; i + 1 < n; i += 1) {
      const up = Math.min(max - w[i], w[i + 1] - min);
      const down = Math.min(w[i] - min, max - w[i + 1]);
      const delta = range(rng, -Math.max(0, down), Math.max(0, up));
      w[i] += delta;
      w[i + 1] -= delta;
    }
  }
  /** @type {[number, number][]} */
  const out = [];
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const e = i === n - 1 ? length : s + w[i];
    out.push([s, e]);
    s = e;
  }
  return out;
}

/**
 * The part of a polygon between `s0` and `s1` along a frame (Sutherland–Hodgman against the two
 * half-planes; exact for convex footprints, and area-correct for concave ones).
 * @param {Vec2[]} polygon Ring.
 * @param {FacadeFrame} f Frame.
 * @param {number} s0 Start.
 * @param {number} s1 End.
 * @returns {Vec2[]} Clipped ring (empty when nothing is left).
 */
export function clipToStrip(polygon, f, s0, s1) {
  /**
   * @param {Vec2[]} ring Ring.
   * @param {(p: Vec2) => number} inside Signed inside distance (≥ 0 inside).
   * @returns {Vec2[]} Clipped ring.
   */
  const clip = (ring, inside) => {
    /** @type {Vec2[]} */
    const out = [];
    for (let i = 0; i < ring.length; i += 1) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const dp = inside(p);
      const dq = inside(q);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return out;
  };
  const first = clip(polygon, (p) => toFrame(f, p)[0] - s0);
  return first.length < 3 ? [] : clip(first, (p) => s1 - toFrame(f, p)[0]);
}

/**
 * Storey range of one tube-house lot.
 * @param {Obstacle} building Building.
 * @returns {{min: number, max: number}} Range.
 */
export function shophouseStoreys(building) {
  if (building.floors === undefined) return SHOPHOUSE_STOREYS;
  return { min: Math.max(1, building.floors - 1), max: building.floors + 1 };
}

/**
 * Lays out a tube-house row.
 * @param {Obstacle} building Building.
 * @param {FacadeFrame} frame Street face.
 * @param {RandomStream} rng Stream.
 * @returns {ShophouseLayout} Layout.
 */
function layoutShophouse(building, frame, rng) {
  const storeyRange = shophouseStoreys(building);
  /** @type {Lot[]} */
  const lots = [];
  const spans = splitFrontage(frame.length, rng);
  spans.forEach(([s0, s1], i) => {
    // The end lots stay open beyond the front edge, so footprint area past either end of the edge
    // (a many-cornered outline) still belongs to a lot.
    const from = i === 0 ? -Infinity : s0;
    const to = i === spans.length - 1 ? Infinity : s1;
    const storeys = intIn(rng, storeyRange.min, storeyRange.max);
    const groundM = range(rng, GROUND_FLOOR_M.min, GROUND_FLOOR_M.max);
    const upper = storeys - 1;
    lots.push({
      s0,
      s1,
      polygon: clipToStrip(building.footprint, frame, from, to),
      storeys,
      groundM,
      upperM: UPPER_FLOOR_M,
      heightM: groundM + upper * UPPER_FLOOR_M,
      paint: SHOPHOUSE_PAINTS[intIn(rng, 0, SHOPHOUSE_PAINTS.length - 1)],
      balconyM: range(rng, BALCONY_M.min, BALCONY_M.max),
      railing: uniform(rng) < 0.6 ? 'iron' : 'solid',
      shutter: /** @type {const} */ (['open', 'closed', 'half'])[pick(rng, [0.6, 0.25, 0.15])],
      sign: uniform(rng) < 0.85 ? intIn(rng, 0, SHOP_NAMES.length - 1) : null,
      awning: uniform(rng) < 0.4,
      ac: Array.from({ length: upper }, () => uniform(rng) < 0.5),
      lit: Array.from({ length: upper }, () => uniform(rng) < 0.45),
      tank: uniform(rng) < 0.7,
      shed: uniform(rng) < 0.3,
    });
  });
  return { use: 'shophouse', id: building.id, frame, lots };
}

/**
 * Distance from the facade midpoint to the nearest lane centreline, or Infinity without lanes.
 * @param {GameMap} map Map.
 * @param {FacadeFrame} frame Street face.
 * @returns {number} Distance.
 */
function streetGap(map, frame) {
  const mid = fromFrame(frame, frame.length / 2, 0);
  let best = Infinity;
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      if (lane.centerline.length >= 2) best = Math.min(best, projectOntoPolyline(mid, lane.centerline).distance);
    }
  }
  return best;
}

/** Room kept between a civic fence and the nearest lane centreline: half a lane plus a pavement. */
const FENCE_CLEAR_M = 5;
/** Shallowest fenced forecourt worth drawing. */
const FENCE_MIN_M = 1.5;
/** Deepest fenced forecourt drawn. */
const FENCE_MAX_M = 10;

/**
 * Lays out one building.
 * @param {GameMap} map Map.
 * @param {Obstacle} building Building obstacle.
 * @param {number} index Index among the map's buildings (the stream index).
 * @returns {BuildingLayout} Layout.
 */
export function layoutBuilding(map, building, index) {
  if (building.kind !== 'building') throw new RangeError(`Obstacle ${building.id} is not a building`);
  if (building.footprint.length < 3) throw new RangeError(`Building ${building.id} has fewer than 3 corners`);
  const rng = sceneryStream(map.id, index);
  const frame = facadeFrame(building.footprint, frontEdgeIndex(building, map));
  const use = building.use ?? 'shophouse';
  if (use === 'shophouse') return layoutShophouse(building, frame, rng);
  if (use === 'tower') {
    const storeys = building.floors ?? Math.max(5, Math.round(building.height / TOWER_STOREY_M));
    const podiumStoreys = Math.min(intIn(rng, 1, 4), Math.max(1, storeys - 2));
    const podiumM = podiumStoreys * CIVIC_STOREY_M;
    return {
      use,
      id: building.id,
      footprint: building.footprint,
      frame,
      podiumStoreys,
      podiumM,
      heightM: podiumM + Math.max(1, storeys - podiumStoreys) * TOWER_STOREY_M,
      glass: [0x5f7f96, 0x4c6a78, 0x7c93a6, 0x3f5c6e][intIn(rng, 0, 3)],
      rng,
    };
  }
  const storeys = building.floors ?? Math.max(1, Math.round(building.height / CIVIC_STOREY_M));
  const gap = streetGap(map, frame) - FENCE_CLEAR_M;
  const wantsFence = use === 'compound' || uniform(rng) < 0.6;
  const fenceM = wantsFence && gap >= FENCE_MIN_M ? Math.min(gap, FENCE_MAX_M) : null;
  return {
    use,
    id: building.id,
    footprint: building.footprint,
    frame,
    storeys,
    heightM: storeys * CIVIC_STOREY_M,
    render: building.colour !== undefined ? Number.parseInt(building.colour.slice(1), 16) : use === 'landmark' ? LANDMARK_RENDER : CIVIC_COLORS.render,
    fenceM,
    rng,
  };
}

/**
 * Wall frame of one footprint edge, built like a facade frame: local +X along the edge, +Z along
 * the outward normal, origin at the edge end the frame starts from.
 * @typedef {object} EdgeFrame
 * @property {{x: number, z: number}} origin Frame origin.
 * @property {number} yaw Yaw.
 * @property {number} length Edge length.
 * @property {Vec2} normal Outward normal.
 */

/**
 * Wall frames of every edge of a ring, skipping zero-length edges.
 * @param {Vec2[]} ring Ring.
 * @param {(ring: Vec2[], i: number) => Vec2 | null} normalOf Outward normal of edge `i`.
 * @returns {EdgeFrame[]} Frames.
 */
export function edgeFrames(ring, normalOf) {
  /** @type {EdgeFrame[]} */
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    const n = normalOf(ring, i);
    if (!n) continue;
    let a = ring[i];
    let b = ring[(i + 1) % ring.length];
    // Walk the edge so that (−along.z, along.x) is the outward normal.
    if ((a[1] - b[1]) * n[0] + (b[0] - a[0]) * n[1] < 0) [a, b] = [b, a];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    out.push({ origin: { x: a[0], z: a[1] }, yaw: headingOf(b[0] - a[0], b[1] - a[1]), length, normal: n });
  }
  return out;
}
