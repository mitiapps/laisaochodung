/**
 * How each sign of `data/signs/signs.yaml` is drawn: plate size in metres (QCVN 41:2024 Điều 12,
 * Bảng 1: round D 700, triangle L 700, octagon D 600; other shapes are drawing choices) and
 * whether a map value is painted on at runtime. The art is `public/signs/<code>.svg`, keyed by the
 * code exactly as written. This table holds drawing data only, never a sign's meaning.
 */

/**
 * @typedef {object} SignArt
 * @property {'round' | 'triangle-down' | 'octagon' | 'rect' | 'diamond'} shape Plate outline.
 * @property {number} widthM Plate width in metres.
 * @property {number} heightM Plate height in metres.
 * @property {{color: string, bandOver?: SignBand} | null} value Paints the map sign `value` in this
 *   colour; `bandOver` redraws a stripe band on top of it, as the official figure layers it.
 */

/**
 * @typedef {object} SignBand
 * @property {number} viewBox Side of the square SVG viewBox the line coordinates use.
 * @property {number} strokeWidth Line width in viewBox units.
 * @property {string} color Line colour.
 * @property {number[][]} lines Lines as `[x1, y1, x2, y2]` in viewBox units.
 */

/** @type {Readonly<Record<string, SignArt>>} */
export const SIGN_ART = Object.freeze({
  'P.101': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.102': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.123a': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.124a': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.127': { shape: 'round', widthM: 0.7, heightM: 0.7, value: { color: '#000000' } },
  'DP.134': {
    shape: 'round',
    widthM: 0.7,
    heightM: 0.7,
    // QCVN 41 Phụ lục M: black number under the stripe band; lines match public/signs/DP.134.svg.
    value: {
      color: '#000000',
      bandOver: {
        viewBox: 700,
        strokeWidth: 10,
        color: '#000000',
        lines: [
          [109.6, 533.8, 533.8, 109.6],
          [123.7, 548.0, 548.0, 123.7],
          [137.9, 562.1, 562.1, 137.9],
          [152.0, 576.3, 576.3, 152.0],
          [166.1, 590.4, 590.4, 166.1],
        ],
      },
    },
  },
  'P.130': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'R.122': { shape: 'octagon', widthM: 0.6, heightM: 0.6, value: null },
  // Phụ lục M plate 24z × 20z at z = 50 mm.
  'R.420': { shape: 'rect', widthM: 1.2, heightM: 1.0, value: null },
  'W.208': { shape: 'triangle-down', widthM: 0.7, heightM: 0.606, value: null },
  'I.401': { shape: 'diamond', widthM: 0.7, heightM: 0.7, value: null },
  'I.407a': { shape: 'rect', widthM: 0.6, heightM: 0.6, value: null },
});

/** Pixel size of the longer side of a sign texture. */
export const SIGN_TEXTURE_PX = 512;

/**
 * Path of a sign's art relative to the public root.
 * @param {string} code Sign code, e.g. `P.127`.
 * @returns {string} Path such as `signs/P.127.svg`.
 */
export function signArtPath(code) {
  return `signs/${code}.svg`;
}

/**
 * Drawing data of a sign code.
 * @param {string} code Sign code.
 * @returns {SignArt} Art record.
 * @throws {RangeError} For a code outside the sign table.
 */
export function signArt(code) {
  const art = SIGN_ART[code];
  if (!art) throw new RangeError(`No sign art for code ${code}; codes come from data/signs/signs.yaml`);
  return art;
}

/**
 * Text painted on a sign, or null when the sign carries no runtime value.
 * @param {string} code Sign code.
 * @param {number | undefined} value Map sign value.
 * @returns {string | null} Text.
 */
export function signValueText(code, value) {
  const art = signArt(code);
  if (!art.value || value === undefined || !Number.isFinite(value)) return null;
  return String(Math.round(value));
}
