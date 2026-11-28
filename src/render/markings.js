/**
 * Pure road-marking geometry (QCVN 41:2024 Phụ lục G codes) as ground quads. A quad is four
 * `[x, z]` corners in ring order; `road-mesh.js` turns quads into triangles.
 *
 * Values from QCVN 41:2024 Phụ lục G (official annex of TT 51/2024/TT-BGTVT,
 * https://datafiles.chinhphu.vn/cpp/files/vbpq/2024/11/51-bgtvt-kem.pdf):
 * - vạch 1.1, 1.2, 1.3, 2.1 and 2.2 are 15 cm wide; only centre lines (1.x) are yellow;
 * - vạch 1.1 dashes 1–3 m with 2–6 m gaps at 1:2 (3 m and 6 m here);
 * - vạch 2.1 dashes 1–3 m with 3–9 m gaps at 1:3 (2 m and 6 m here);
 * - vạch 1.3 is two 15 cm lines with a 15–50 cm inner gap (15 cm here);
 * - vạch 7.1 is 20, 30 or 40 cm wide (30 cm here, for urban streets);
 * - vạch 7.3 Mẫu 1 stripes are 40 cm wide with 60 cm gaps;
 * - vạch 9.3 lane arrows are white, 300 cm long (320 cm combined) with a 15 cm shaft;
 * - vạch 9.5a: the word STOP, letters 1.6 m high on low-speed urban roads, strokes 12–18 cm, its
 *   top 2.0–3.0 m before the stop line.
 * Sizes read from the annex drawings rather than its text (Hình G.49 give-way, Hình G.73 arrows)
 * are marked as such; the 2019 text equals the 2026 draft, and the annex is not on the 2024 change
 * list.
 *
 * Lane and centre lines stop at the stop line, or at the zebra edge where there is no stop line;
 * nothing is painted through a zebra (Hình G.43, G.47). `lineCuts` gives the areas to leave bare.
 */

import {
  headingOf,
  headingVector,
  leftVector,
  offsetPolyline,
  pointInPolygon,
  polylineLength,
  projectOntoPolyline,
  slicePolyline,
} from '../geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {[Vec2, Vec2, Vec2, Vec2]} Quad */
/** @typedef {import('../contracts/map.js').LaneLine} LaneLine */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {import('../contracts/map.js').StopLine} StopLine */
/** @typedef {import('../contracts/map.js').LaneArrow} LaneArrow */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */

/** Width of centre and lane lines in metres (15 cm for vạch 1.1–1.3, 2.1 and 2.2). */
export const LINE_WIDTH_M = 0.15;
/** Centre-to-centre spacing of the two strands of a double or mixed line: a 15 cm inner gap. */
export const DOUBLE_SPACING_M = 0.3;
/** Dash pattern of a dashed centre line (vạch 1.1, ratio 1:2). */
export const CENTRE_DASH = Object.freeze({ dash: 3, gap: 6 });
/** Dash pattern of a dashed lane line (vạch 2.1, ratio 1:3). */
export const LANE_DASH = Object.freeze({ dash: 2, gap: 6 });
/** Stop line width (vạch 7.1: 20, 30 or 40 cm). */
export const STOP_LINE_WIDTH_M = 0.3;
/**
 * Give-way line (vạch 7.2 Mẫu 1), read from Hình G.49: two 20 cm dashed lines with a 20 cm gap
 * between them (40 cm centre to centre), dashes 60 cm with 20 cm gaps.
 */
export const GIVE_WAY = Object.freeze({ width: 0.2, spacing: 0.4, dash: 0.6, gap: 0.2 });
/**
 * Inverted give-way triangle of vạch 7.2 Mẫu 1, read from Hình G.49: 1.2 m base, 3.0 m long, a
 * 15 cm border. Its base lies `setback` before the line's near edge (design), its point towards
 * the driver.
 */
export const GIVE_WAY_TRIANGLE = Object.freeze({ base: 1.2, length: 3, border: 0.15, setback: 2.5 });
/**
 * The word STOP (vạch 9.5a): letters 1.6 m high along the lane, 15 cm strokes, its top 2.5 m
 * before the stop line's near edge. Letter width and spacing are design; the word shrinks across
 * a lane too narrow for it.
 */
export const STOP_WORD = Object.freeze({ height: 1.6, stroke: 0.15, letterWidth: 0.6, spacing: 0.2, setback: 2.5 });
/**
 * Lane arrow (vạch 9.3): lengths and shaft width from Hình G.73; the head size is design.
 */
export const LANE_ARROW = Object.freeze({ length: 3, combinedLength: 3.2, shaft: 0.15, headLength: 1, headWidth: 0.5 });
/** Zebra stripe width and gap (vạch 7.3 Mẫu 1). */
export const ZEBRA = Object.freeze({ stripe: 0.4, gap: 0.6 });

/**
 * @typedef {object} Strand
 * @property {number} offset Lateral offset from the line polyline, + to the left.
 * @property {boolean} dashed Dashed strand.
 */

/**
 * @typedef {object} LineStyle
 * @property {'white' | 'yellow'} color Yellow for a centre line between opposing lanes, white
 *   otherwise (lane dividers and edge lines).
 * @property {Strand[]} strands Painted strands.
 * @property {{dash: number, gap: number}} pattern Dash pattern of the dashed strands.
 */

/**
 * Drawing style of a lane line from its type and the lanes on either side.
 * @param {LaneLine} line Lane line.
 * @param {Map<string, Lane>} lanesById Lanes of the line's road.
 * @returns {LineStyle} Style.
 */
export function laneLineStyle(line, lanesById) {
  const left = line.left ? lanesById.get(line.left) : undefined;
  const right = line.right ? lanesById.get(line.right) : undefined;
  const centre = Boolean(left && right && left.dir !== right.dir);
  const color = centre ? 'yellow' : 'white';
  const pattern = centre ? CENTRE_DASH : LANE_DASH;
  const h = DOUBLE_SPACING_M / 2;
  switch (line.type) {
    case 'dashed':
      return { color, pattern, strands: [{ offset: 0, dashed: true }] };
    case 'solid':
      return { color, pattern, strands: [{ offset: 0, dashed: false }] };
    case 'double-solid':
      return {
        color,
        pattern,
        strands: [
          { offset: h, dashed: false },
          { offset: -h, dashed: false },
        ],
      };
    case 'mixed': {
      // Vạch 1.4: traffic next to the dashed strand may cross. The strand on the left of the
      // polyline borders the left lane, so it is dashed when the left lane may cross.
      const leftMay = line.crossable === 'left-to-right' || line.crossable === 'both';
      const rightMay = line.crossable === 'right-to-left' || line.crossable === 'both';
      return {
        color,
        pattern,
        strands: [
          { offset: h, dashed: leftMay },
          { offset: -h, dashed: rightMay },
        ],
      };
    }
    default:
      throw new RangeError(`Unknown lane line type: ${String(line.type)}`);
  }
}

/**
 * Dash intervals `[s0, s1]` along a line of the given length, starting with a dash at 0.
 * Pieces shorter than 5 cm at the end are dropped.
 * @param {number} length Line length.
 * @param {number} dash Dash length.
 * @param {number} gap Gap length.
 * @returns {[number, number][]} Intervals.
 */
export function dashIntervals(length, dash, gap) {
  if (!(dash > 0) || !(gap >= 0)) throw new RangeError('dashIntervals needs dash > 0 and gap ≥ 0');
  /** @type {[number, number][]} */
  const out = [];
  for (let s = 0; s < length; s += dash + gap) {
    const e = Math.min(length, s + dash);
    if (e - s >= 0.05) out.push([s, e]);
  }
  return out;
}

/**
 * Quads of a ribbon of constant width centred on a polyline.
 * @param {Vec2[]} polyline At least 2 distinct points.
 * @param {number} width Ribbon width.
 * @returns {Quad[]} One quad per segment.
 */
export function ribbonQuads(polyline, width) {
  const l = offsetPolyline(polyline, width / 2);
  const r = offsetPolyline(polyline, -width / 2);
  /** @type {Quad[]} */
  const out = [];
  for (let i = 0; i < l.length - 1; i += 1) out.push([l[i], l[i + 1], r[i + 1], r[i]]);
  return out;
}

/**
 * Quads of a solid or dashed stroke along a polyline. With `keep`, only the parts inside those
 * intervals are painted; dashes keep the phase they have on the whole line.
 * @param {Vec2[]} polyline Line.
 * @param {number} width Stroke width.
 * @param {{dash: number, gap: number} | null} pattern Dash pattern, null for solid.
 * @param {[number, number][] | null} [keep] Painted intervals along the line; null paints it all.
 * @returns {Quad[]} Quads.
 */
export function strokeQuads(polyline, width, pattern, keep = null) {
  if (!pattern && !keep) return ribbonQuads(polyline, width);
  const len = polylineLength(polyline);
  /** @type {[number, number][]} */
  const pieces = pattern ? dashIntervals(len, pattern.dash, pattern.gap) : [[0, len]];
  const painted = keep ? intersectIntervals(pieces, keep) : pieces;
  return painted.filter(([s0, s1]) => s1 - s0 >= 0.05).flatMap(([s0, s1]) => ribbonQuads(slicePolyline(polyline, s0, s1), width));
}

/**
 * Overlaps of two sorted lists of disjoint intervals.
 * @param {[number, number][]} a Intervals.
 * @param {[number, number][]} b Intervals.
 * @returns {[number, number][]} Overlaps, sorted.
 */
export function intersectIntervals(a, b) {
  /** @type {[number, number][]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s0 = Math.max(a[i][0], b[j][0]);
    const s1 = Math.min(a[i][1], b[j][1]);
    if (s1 > s0) out.push([s0, s1]);
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * Quads of one lane line, all strands, leaving the `cuts` areas bare.
 * @param {LaneLine} line Lane line.
 * @param {Map<string, Lane>} lanesById Lanes of its road.
 * @param {Vec2[][]} [cuts] Areas where no line is painted (see `lineCuts`).
 * @returns {{color: 'white' | 'yellow', quads: Quad[]}} Paint colour and quads.
 */
export function laneLineQuads(line, lanesById, cuts = []) {
  const style = laneLineStyle(line, lanesById);
  const quads = style.strands.flatMap((strand) => {
    const path = strand.offset === 0 ? line.polyline : offsetPolyline(line.polyline, strand.offset);
    const keep = cuts.length > 0 ? keptIntervals(path, cuts) : null;
    return strokeQuads(path, LINE_WIDTH_M, strand.dashed ? style.pattern : null, keep);
  });
  return { color: style.color, quads };
}

/**
 * Quads of a stop line (vạch 7.1, solid) or give-way line (vạch 7.2 Mẫu 1, two dashed lines).
 * @param {StopLine} stopLine Stop line.
 * @returns {Quad[]} White quads.
 */
export function stopLineQuads(stopLine) {
  const path = /** @type {Vec2[]} */ ([stopLine.segment[0], stopLine.segment[1]]);
  if (stopLine.control === 'give-way') {
    const h = GIVE_WAY.spacing / 2;
    return [h, -h].flatMap((d) => strokeQuads(offsetPolyline(path, d), GIVE_WAY.width, GIVE_WAY));
  }
  return ribbonQuads(path, STOP_LINE_WIDTH_M);
}

/**
 * Zebra stripes (vạch 7.3) inside a crosswalk polygon. Stripes run along the travel heading and
 * repeat across it, centred in the polygon; each stripe spans the polygon at its mid line, which
 * is exact for convex polygons.
 * @param {Vec2[]} polygon Crosswalk ring.
 * @param {number} travelHeading Heading of the traffic crossing the zebra.
 * @returns {Quad[]} White quads.
 */
export function crosswalkStripes(polygon, travelHeading) {
  const f = headingVector(travelHeading);
  const l = leftVector(travelHeading);
  const uv = polygon.map((p) => [p[0] * f[0] + p[1] * f[1], p[0] * l[0] + p[1] * l[1]]);
  const vs = uv.map((p) => p[1]);
  const vMin = Math.min(...vs);
  const span = Math.max(...vs) - vMin;
  const pitch = ZEBRA.stripe + ZEBRA.gap;
  const n = Math.floor((span + ZEBRA.gap) / pitch);
  if (n <= 0) return [];
  const start = vMin + (span - (n * ZEBRA.stripe + (n - 1) * ZEBRA.gap)) / 2;
  /**
   * @param {number} u Along.
   * @param {number} v Across.
   * @returns {Vec2} World point.
   */
  const toWorld = (u, v) => [u * f[0] + v * l[0], u * f[1] + v * l[1]];
  /** @type {Quad[]} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const v0 = start + i * pitch;
    const v1 = v0 + ZEBRA.stripe;
    const vm = (v0 + v1) / 2;
    /** @type {number[]} */
    const us = [];
    for (let k = 0; k < uv.length; k += 1) {
      const a = uv[k];
      const b = uv[(k + 1) % uv.length];
      if ((a[1] - vm) * (b[1] - vm) <= 0 && a[1] !== b[1]) {
        us.push(a[0] + ((vm - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    if (us.length < 2) continue;
    const u0 = Math.min(...us);
    const u1 = Math.max(...us);
    out.push([toWorld(u0, v0), toWorld(u1, v0), toWorld(u1, v1), toWorld(u0, v1)]);
  }
  return out;
}

/** Line stubs shorter than this left between a cut and the line end are not painted (design). */
export const MIN_STUB_M = 1;
/** How far past a stop line's near edge its road's lines are cut (design: past any zebra). */
export const CUT_AHEAD_M = 20;
/** Sideways margin of a stop-line cut, so a line ending at the stop line's end is cut too. */
const CUT_PAD_M = 0.5;

/**
 * Parameters `t` in [0, 1] where segment `a b` crosses the edges of a polygon.
 * @param {Vec2} a Start.
 * @param {Vec2} b End.
 * @param {Vec2[]} polygon Ring.
 * @returns {number[]} Parameters.
 */
function edgeCrossings(a, b, polygon) {
  /** @type {number[]} */
  const ts = [];
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  for (let i = 0; i < polygon.length; i += 1) {
    const c = polygon[i];
    const d = polygon[(i + 1) % polygon.length];
    const sx = d[0] - c[0];
    const sz = d[1] - c[1];
    const denom = rx * sz - rz * sx;
    if (Math.abs(denom) < 1e-12) continue;
    const qx = c[0] - a[0];
    const qz = c[1] - a[1];
    const t = (qx * sz - qz * sx) / denom;
    const u = (qx * rz - qz * rx) / denom;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts;
}

/**
 * Intervals along a polyline that lie inside a polygon, sorted and merged.
 * @param {Vec2[]} polyline Line.
 * @param {Vec2[]} polygon Ring.
 * @returns {[number, number][]} Intervals in metres along the line.
 */
export function insideIntervals(polyline, polygon) {
  /** @type {[number, number][]} */
  const out = [];
  let acc = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg === 0) continue;
    const ts = [0, ...edgeCrossings(a, b, polygon), 1].sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k += 1) {
      const tm = (ts[k] + ts[k + 1]) / 2;
      /** @type {Vec2} */
      const mid = [a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm];
      if (ts[k + 1] - ts[k] <= 0 || !pointInPolygon(mid, polygon)) continue;
      const s0 = acc + ts[k] * seg;
      const s1 = acc + ts[k + 1] * seg;
      const last = out[out.length - 1];
      if (last && s0 - last[1] < 1e-9) last[1] = s1;
      else out.push([s0, s1]);
    }
    acc += seg;
  }
  return out;
}

/**
 * Axis-aligned bounds of a point list.
 * @param {Vec2[]} pts Points.
 * @returns {[number, number, number, number]} minX, minZ, maxX, maxZ.
 */
function bounds(pts) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

/**
 * Painted intervals of a line once the cut areas are left bare: everything outside the cuts, less
 * stubs under `MIN_STUB_M` that a cut leaves (such as the bit between a zebra and the junction).
 * @param {Vec2[]} polyline Line.
 * @param {Vec2[][]} cuts Areas to leave bare.
 * @returns {[number, number][]} Painted intervals, sorted.
 */
export function keptIntervals(polyline, cuts) {
  const len = polylineLength(polyline);
  const [lx0, lz0, lx1, lz1] = bounds(polyline);
  const inside = cuts
    .filter((c) => {
      const [x0, z0, x1, z1] = bounds(c);
      return x0 <= lx1 && x1 >= lx0 && z0 <= lz1 && z1 >= lz0;
    })
    .flatMap((c) => insideIntervals(polyline, c))
    .sort((a, b) => a[0] - b[0]);
  if (inside.length === 0) return [[0, len]];
  /** @type {[number, number][]} */
  const kept = [];
  let s = 0;
  for (const [a, b] of inside) {
    if (a > s) kept.push([s, a]);
    s = Math.max(s, b);
  }
  if (s < len) kept.push([s, len]);
  return kept.filter(([a, b]) => b - a >= MIN_STUB_M);
}

/**
 * Areas where each road's lane and centre lines are not painted: every zebra, and from each of
 * the road's stop or give-way lines (its painted near edge) `CUT_AHEAD_M` onwards across the stop line's lanes, so the
 * lines end at the stop line. A stop line belongs to the road of its first lane.
 * @param {GameMap} map Map.
 * @returns {Map<string, Vec2[][]>} Cut areas by road id.
 */
export function lineCuts(map) {
  /** @type {Map<string, {roadId: string, lane: Lane}>} */
  const lanes = new Map();
  for (const road of map.roads) for (const lane of road.lanes) lanes.set(lane.id, { roadId: road.id, lane });
  const zebras = map.crosswalks.map((c) => /** @type {Vec2[]} */ (c.polygon));
  /** @type {Map<string, Vec2[][]>} */
  const out = new Map(map.roads.map((r) => [r.id, [...zebras]]));
  for (const sl of map.stopLines) {
    const owner = lanes.get(sl.laneIds[0]);
    if (!owner) continue;
    const [a, b] = sl.segment;
    /** @type {Vec2} */
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const heading = projectOntoPolyline(mid, owner.lane.centerline).heading;
    const f = headingVector(heading);
    const l = leftVector(heading);
    const u0 = mid[0] * f[0] + mid[1] * f[1] - nearEdgeM(sl);
    const u1 = u0 + CUT_AHEAD_M;
    const vs = [a, b].map((p) => p[0] * l[0] + p[1] * l[1]);
    const v0 = Math.min(...vs) - CUT_PAD_M;
    const v1 = Math.max(...vs) + CUT_PAD_M;
    /**
     * @param {number} u Along.
     * @param {number} v Across.
     * @returns {Vec2} World point.
     */
    const w = (u, v) => [u * f[0] + v * l[0], u * f[1] + v * l[1]];
    out.get(owner.roadId)?.push([w(u0, v0), w(u1, v0), w(u1, v1), w(u0, v1)]);
  }
  return out;
}

/**
 * @typedef {object} LaneStation
 * @property {Vec2} point Where the lane centreline meets the stop line.
 * @property {number} heading Travel heading of the lane there.
 * @property {number} width Lane width at the line: the stop line's length shared by its lanes.
 */

/**
 * Where each lane of a stop line meets it. A lane whose centreline does not reach the line's
 * extension, or that is unknown, is skipped.
 * @param {StopLine} stopLine Stop line.
 * @param {Map<string, Lane>} lanesById Lanes of the map.
 * @returns {LaneStation[]} One station per lane found.
 */
export function laneStations(stopLine, lanesById) {
  const [a, b] = stopLine.segment;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const width = Math.hypot(dx, dz) / Math.max(1, stopLine.laneIds.length);
  /**
   * @param {Vec2} p Point.
   * @returns {number} Signed side of the stop line's extension.
   */
  const side = (p) => dx * (p[1] - a[1]) - dz * (p[0] - a[0]);
  /** @type {LaneStation[]} */
  const out = [];
  for (const id of stopLine.laneIds) {
    const lane = lanesById.get(id);
    if (!lane) continue;
    const cl = lane.centerline;
    for (let i = 0; i < cl.length - 1; i += 1) {
      const g0 = side(cl[i]);
      const g1 = side(cl[i + 1]);
      if (g0 === g1 || g0 * g1 > 0) continue;
      const t = g0 / (g0 - g1);
      /** @type {Vec2} */
      const point = [cl[i][0] + (cl[i + 1][0] - cl[i][0]) * t, cl[i][1] + (cl[i + 1][1] - cl[i][1]) * t];
      out.push({ point, heading: headingOf(cl[i + 1][0] - cl[i][0], cl[i + 1][1] - cl[i][1]), width });
      break;
    }
  }
  return out;
}

/**
 * Maps a lane-local frame to the ground: `u` metres ahead of the station along its heading, `v`
 * metres to its left.
 * @param {Vec2} origin Origin.
 * @param {number} heading Heading.
 * @returns {(u: number, v: number) => Vec2} Mapping.
 */
function laneFrame(origin, heading) {
  const f = headingVector(heading);
  const l = leftVector(heading);
  return (u, v) => [origin[0] + u * f[0] + v * l[0], origin[1] + u * f[1] + v * l[1]];
}

/**
 * Half the painted depth of a stop or give-way line along the travel direction.
 * @param {StopLine} stopLine Stop line.
 * @returns {number} Metres from the segment to the near edge.
 */
export function nearEdgeM(stopLine) {
  return stopLine.control === 'give-way' ? GIVE_WAY.spacing / 2 + GIVE_WAY.width / 2 : STOP_LINE_WIDTH_M / 2;
}

/** Block letters of STOP as rectangles `[x0, y0, x1, y1]` in units of letter width `w`, height `h`, stroke `s`. */
const LETTERS = Object.freeze({
  /** @type {(w: number, h: number, s: number) => number[][]} */
  S: (w, h, s) => [
    [0, h - s, w, h],
    [0, h / 2 + s / 2, s, h - s],
    [0, h / 2 - s / 2, w, h / 2 + s / 2],
    [w - s, s, w, h / 2 - s / 2],
    [0, 0, w, s],
  ],
  /** @type {(w: number, h: number, s: number) => number[][]} */
  T: (w, h, s) => [
    [0, h - s, w, h],
    [w / 2 - s / 2, 0, w / 2 + s / 2, h - s],
  ],
  /** @type {(w: number, h: number, s: number) => number[][]} */
  O: (w, h, s) => [
    [0, 0, s, h],
    [w - s, 0, w, h],
    [s, h - s, w - s, h],
    [s, 0, w - s, s],
  ],
  /** @type {(w: number, h: number, s: number) => number[][]} */
  P: (w, h, s) => [
    [0, 0, s, h],
    [s, h - s, w, h],
    [s, h * 0.45, w, h * 0.45 + s],
    [w - s, h * 0.45 + s, w, h - s],
  ],
});

/**
 * The word STOP painted in one lane before a stop-sign line (vạch 9.5a), read from the driver's
 * seat: S on the left, the tops of the letters towards the line.
 * @param {LaneStation} station Lane at the stop line.
 * @param {number} edgeM Distance from the stop-line segment to its near edge.
 * @returns {Quad[]} White quads.
 */
export function stopWordQuads(station, edgeM) {
  const { height: h, stroke, letterWidth, spacing, setback } = STOP_WORD;
  const full = 4 * letterWidth + 3 * spacing;
  const k = Math.min(1, Math.max(0.3, (station.width - 0.4) / full));
  const lw = letterWidth * k;
  const sp = spacing * k;
  const width = full * k;
  const at = laneFrame(station.point, station.heading);
  const top = -(edgeM + setback);
  /** @type {Quad[]} */
  const out = [];
  ['S', 'T', 'O', 'P'].forEach((ch, i) => {
    const x0 = -width / 2 + i * (lw + sp);
    for (const [ax, ay, bx, by] of LETTERS[/** @type {'S' | 'T' | 'O' | 'P'} */ (ch)](lw, h, stroke)) {
      // Letter x grows to the driver's right (−v); letter y grows towards the line (+u).
      const u0 = top - h + ay;
      const u1 = top - h + by;
      const v0 = -(x0 + ax);
      const v1 = -(x0 + bx);
      out.push([at(u0, v0), at(u0, v1), at(u1, v1), at(u1, v0)]);
    }
  });
  return out;
}

/**
 * The inverted give-way triangle of vạch 7.2 Mẫu 1 in one lane, as its 15 cm border.
 * @param {LaneStation} station Lane at the give-way line.
 * @param {number} edgeM Distance from the line's segment to its near edge.
 * @returns {Quad[]} Three white quads, one per side.
 */
export function giveWayTriangleQuads(station, edgeM) {
  const { base, length, border, setback } = GIVE_WAY_TRIANGLE;
  const at = laneFrame(station.point, station.heading);
  const u0 = -(edgeM + setback);
  /** @type {Vec2[]} Outer corners in lane-local (u, v): base left, base right, point. */
  const outer = [
    [u0, base / 2],
    [u0, -base / 2],
    [u0 - length, 0],
  ];
  // The inner edge is the outer one shrunk about the incentre by the border.
  const sides = outer.map((_, i) => {
    const p = outer[(i + 1) % 3];
    const q = outer[(i + 2) % 3];
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  });
  const perimeter = sides[0] + sides[1] + sides[2];
  const area = Math.abs((outer[1][0] - outer[0][0]) * (outer[2][1] - outer[0][1]) - (outer[2][0] - outer[0][0]) * (outer[1][1] - outer[0][1])) / 2;
  const r = (2 * area) / perimeter;
  /** @type {Vec2} */
  const centre = [
    (sides[0] * outer[0][0] + sides[1] * outer[1][0] + sides[2] * outer[2][0]) / perimeter,
    (sides[0] * outer[0][1] + sides[1] * outer[1][1] + sides[2] * outer[2][1]) / perimeter,
  ];
  const ratio = (r - border) / r;
  const inner = outer.map((p) => /** @type {Vec2} */ ([centre[0] + (p[0] - centre[0]) * ratio, centre[1] + (p[1] - centre[1]) * ratio]));
  return [0, 1, 2].map((i) => {
    const j = (i + 1) % 3;
    return /** @type {Quad} */ ([at(...outer[i]), at(...outer[j]), at(...inner[j]), at(...inner[i])]);
  });
}

/**
 * Rings of one lane arrow (vạch 9.3): a shaft, a head per movement, a 45° branch for each turn and
 * a hook on the left for a U-turn. The arrow's tip, its end nearest the stop line, lies on `pos`;
 * it is `LANE_ARROW.length` long, `combinedLength` when it shows more than one movement.
 * @param {LaneArrow} arrow Arrow.
 * @returns {Vec2[][]} White convex rings (quads and triangles).
 */
export function laneArrowRings(arrow) {
  const { length, combinedLength, shaft, headLength, headWidth } = LANE_ARROW;
  const turns = arrow.turns;
  const total = turns.length > 1 ? combinedLength : length;
  const straight = turns.includes('straight');
  const at = laneFrame([arrow.pos.x, arrow.pos.z], arrow.heading);
  /** @type {Vec2[][]} */
  const rings = [];
  /**
   * @param {Vec2[]} local Lane-local polyline.
   */
  const stroke = (local) => {
    rings.push(...ribbonQuads(local.map(([u, v]) => at(u, v)), shaft));
  };
  /**
   * @param {Vec2} apex Head point.
   * @param {Vec2} dir Unit direction it points in.
   */
  const head = (apex, dir) => {
    const bu = apex[0] - dir[0] * headLength;
    const bv = apex[1] - dir[1] * headLength;
    const pu = -dir[1] * (headWidth / 2);
    const pv = dir[0] * (headWidth / 2);
    rings.push([at(apex[0], apex[1]), at(bu + pu, bv + pv), at(bu - pu, bv - pv)]);
  };

  let shaftTop = -Infinity;
  if (straight) {
    head([0, 0], [1, 0]);
    shaftTop = -headLength;
  }
  // Turn branches leave the shaft at 45°; alone they reach the tip, beside a straight head they
  // sit lower on the shaft.
  const c = Math.SQRT1_2;
  const stick = 0.5;
  for (const turn of /** @type {const} */ (['left', 'right'])) {
    if (!turns.includes(turn)) continue;
    const sign = turn === 'left' ? 1 : -1;
    const knee = straight ? -2.2 : -(stick + headLength) * c;
    /** @type {Vec2} */
    const dir = [c, sign * c];
    /** @type {Vec2} */
    const end = [knee + dir[0] * stick, dir[1] * stick];
    stroke([[knee, 0], end]);
    head([end[0] + dir[0] * headLength, end[1] + dir[1] * headLength], dir);
    shaftTop = Math.max(shaftTop, knee);
  }
  if (turns.includes('uturn')) {
    // A hook over to the left, with its head pointing back; its outer edge reaches the tip when
    // nothing else does.
    const radius = 0.35;
    const alone = !straight && !turns.includes('left') && !turns.includes('right');
    const centreU = (alone ? 0 : -0.95) - radius - shaft / 2;
    /** @type {Vec2[]} */
    const hook = [];
    for (let k = 0; k <= 8; k += 1) {
      const phi = -Math.PI / 2 + (Math.PI * k) / 8;
      hook.push([centreU + radius * Math.cos(phi), radius + radius * Math.sin(phi)]);
    }
    hook.push([centreU - 0.3, 2 * radius]);
    stroke(hook);
    head([centreU - 0.3 - headLength, 2 * radius], [-1, 0]);
    shaftTop = Math.max(shaftTop, centreU);
  }
  stroke([
    [-total, 0],
    [shaftTop, 0],
  ]);
  return rings;
}
