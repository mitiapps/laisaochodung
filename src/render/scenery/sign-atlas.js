/**
 * One canvas atlas of shop sign boards, drawn once at load: cell `i` holds `SHOP_NAMES[i]`. The
 * cell layout is pure, so geometry gets its UVs without a DOM; the texture itself is null under
 * Node, where boards keep their plain material colour.
 */

import { CanvasTexture, SRGBColorSpace } from 'three';
import { HAS_DOM } from '../assets.js';
import { SHOP_NAMES } from './shop-names.js';

/** Atlas grid: columns and rows of cells (4 × 8 holds up to 32 names). */
export const ATLAS_GRID = Object.freeze({ cols: 4, rows: 8 });
/** Pixel size of one cell (a 4:1 board). */
export const ATLAS_CELL_PX = Object.freeze({ w: 256, h: 64 });

if (SHOP_NAMES.length > ATLAS_GRID.cols * ATLAS_GRID.rows) {
  throw new RangeError('SHOP_NAMES has more entries than the sign atlas has cells');
}

/**
 * UV rectangle of an atlas cell, with a small inset so mipmaps do not bleed between cells.
 * @param {number} index Cell index.
 * @returns {[number, number, number, number]} `[u0, v0, u1, v1]`, `v` up.
 */
export function atlasCellUv(index) {
  if (!Number.isInteger(index) || index < 0 || index >= SHOP_NAMES.length) {
    throw new RangeError(`No sign atlas cell ${index}`);
  }
  const col = index % ATLAS_GRID.cols;
  const row = Math.floor(index / ATLAS_GRID.cols);
  const du = 1 / ATLAS_GRID.cols;
  const dv = 1 / ATLAS_GRID.rows;
  const eu = du * 0.01;
  const ev = dv * 0.02;
  // Canvas rows run down; texture v runs up.
  const v1 = 1 - row * dv;
  return [col * du + eu, v1 - dv + ev, (col + 1) * du - eu, v1 - ev];
}

/**
 * Draws the atlas.
 * @returns {CanvasTexture | null} Texture, or null without a DOM.
 */
export function createSignAtlasTexture() {
  if (!HAS_DOM) return null;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_GRID.cols * ATLAS_CELL_PX.w;
  canvas.height = ATLAS_GRID.rows * ATLAS_CELL_PX.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const { w, h } = ATLAS_CELL_PX;
  SHOP_NAMES.forEach((name, i) => {
    const x = (i % ATLAS_GRID.cols) * w;
    const y = Math.floor(i / ATLAS_GRID.cols) * h;
    ctx.fillStyle = name.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = name.fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    ctx.fillStyle = name.fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = h * 0.55;
    ctx.font = `bold ${Math.round(size)}px Arial, Helvetica, sans-serif`;
    const width = ctx.measureText(name.text).width;
    if (width > w - 20) {
      size *= (w - 20) / width;
      ctx.font = `bold ${Math.round(size)}px Arial, Helvetica, sans-serif`;
    }
    ctx.fillText(name.text, x + w / 2, y + h / 2 + size * 0.05);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
