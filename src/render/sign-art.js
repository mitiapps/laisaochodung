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
 * @property {{color: string} | null} value Paints the map sign `value` in this colour.
 */

/** @type {Readonly<Record<string, SignArt>>} */
export const SIGN_ART = Object.freeze({
  'P.101': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.102': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.123a': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.124a': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'P.127': { shape: 'round', widthM: 0.7, heightM: 0.7, value: { color: '#000000' } },
  'DP.134': { shape: 'round', widthM: 0.7, heightM: 0.7, value: { color: '#6b6b6b' } },
  'P.130': { shape: 'round', widthM: 0.7, heightM: 0.7, value: null },
  'R.122': { shape: 'octagon', widthM: 0.6, heightM: 0.6, value: null },
  'R.420': { shape: 'rect', widthM: 0.84, heightM: 0.6, value: null },
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
