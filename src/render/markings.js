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
 * - vạch 7.3 Mẫu 1 stripes are 40 cm wide with 60 cm gaps.
 * The give-way line (vạch 7.2) size is a drawing choice.
 */

import { headingVector, leftVector, offsetPolyline, polylineLength, slicePolyline } from '../geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {[Vec2, Vec2, Vec2, Vec2]} Quad */
/** @typedef {import('../contracts/map.js').LaneLine} LaneLine */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {import('../contracts/map.js').StopLine} StopLine */

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
/** Give-way line (vạch 7.2) width and dash pattern. */
export const GIVE_WAY = Object.freeze({ width: 0.3, dash: 0.6, gap: 0.6 });
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
 * Quads of a solid or dashed stroke along a polyline.
 * @param {Vec2[]} polyline Line.
 * @param {number} width Stroke width.
 * @param {{dash: number, gap: number} | null} pattern Dash pattern, null for solid.
 * @returns {Quad[]} Quads.
 */
export function strokeQuads(polyline, width, pattern) {
  if (!pattern) return ribbonQuads(polyline, width);
  const len = polylineLength(polyline);
  return dashIntervals(len, pattern.dash, pattern.gap).flatMap(([s0, s1]) =>
    ribbonQuads(slicePolyline(polyline, s0, s1), width),
  );
}

/**
 * Quads of one lane line, all strands.
 * @param {LaneLine} line Lane line.
 * @param {Map<string, Lane>} lanesById Lanes of its road.
 * @returns {{color: 'white' | 'yellow', quads: Quad[]}} Paint colour and quads.
 */
export function laneLineQuads(line, lanesById) {
  const style = laneLineStyle(line, lanesById);
  const quads = style.strands.flatMap((strand) => {
    const path = strand.offset === 0 ? line.polyline : offsetPolyline(line.polyline, strand.offset);
    return strokeQuads(path, LINE_WIDTH_M, strand.dashed ? style.pattern : null);
  });
  return { color: style.color, quads };
}

/**
 * Quads of a stop line (vạch 7.1, solid) or give-way line (vạch 7.2, dashed).
 * @param {StopLine} stopLine Stop line.
 * @returns {Quad[]} White quads.
 */
export function stopLineQuads(stopLine) {
  const path = /** @type {Vec2[]} */ ([stopLine.segment[0], stopLine.segment[1]]);
  if (stopLine.control === 'give-way') return strokeQuads(path, GIVE_WAY.width, GIVE_WAY);
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
