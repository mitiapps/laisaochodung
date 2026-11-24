/**
 * Tube-house (nhà ống) rows from a `ShophouseLayout`. Each lot is built in its own facade frame:
 * local +X along the street, +Y up, +Z out towards the street, origin at the lot's front corner.
 *
 * Per lot: bare concrete side and back walls (so a taller neighbour shows a party wall), a painted
 * front with a roller-shutter shop, a sign board from the atlas, balconies with railings, windows
 * (some lit at night), air-conditioner units, a parapet, and roof extras (water tank, tôn shed).
 * Awnings are returned as instances for the prop layer.
 */

import { localToWorld, outwardNormal } from '../triangle-soup.js';
import { atlasCellUv } from './sign-atlas.js';
import { fromFrame, toFrame } from './lots.js';

/** @typedef {import('./lots.js').ShophouseLayout} ShophouseLayout */
/** @typedef {import('./lots.js').Lot} Lot */
/** @typedef {import('./chunks.js').ChunkedSoups} ChunkedSoups */
/** @typedef {[number, number]} Vec2 */

/**
 * One awning to instance: the middle of its top edge on the facade, the facade yaw and its width.
 * @typedef {object} AwningInstance
 * @property {number} x X.
 * @property {number} y Height of the top edge.
 * @property {number} z Z.
 * @property {number} yaw Facade yaw (awning projects along local +Z).
 * @property {number} width Width along the facade.
 * @property {number} color Canvas colour.
 */

/** Colours of the unpainted parts. */
export const SHOPHOUSE_COLORS = Object.freeze({
  bare: 0xa9a59c,
  roof: 0x8f8c86,
  interior: 0x1d1a17,
  shutter: 0x9aa0a6,
  iron: 0x2a2a2a,
  signBox: 0x3a3a3a,
  ac: 0xe7e7e2,
  tank: 0xc9ccd0,
  tonRoof: 0x5b86a8,
  window: 0x3b4a55,
  white: 0xffffff,
});

/** Awning canvas colours (design). */
const AWNING_COLORS = Object.freeze([0x2f6fb5, 0xd23b2f, 0x2f9a57, 0xe8a317, 0x8c8c8c]);

/** Width of the pillars beside the shop opening. */
const PILLAR_M = 0.3;
/** Height of the lintel band (and sign board) above the shop opening. */
const LINTEL_M = 1;

/**
 * Builds the lots of a tube-house row into the chunked soups.
 * @param {ShophouseLayout} layout Row layout.
 * @param {ChunkedSoups} soups Scenery soups.
 * @returns {AwningInstance[]} Awnings.
 */
export function buildShophouseRow(layout, soups) {
  /** @type {AwningInstance[]} */
  const awnings = [];
  const f = layout.frame;
  layout.lots.forEach((lot, i) => {
    const w = lot.s1 - lot.s0;
    const [ox, oz] = fromFrame(f, lot.s0, 0);
    const origin = { x: ox, z: oz };
    const [cx, cz] = fromFrame(f, (lot.s0 + lot.s1) / 2, 0);
    /**
     * @param {string} m Material key.
     * @returns {import('../triangle-soup.js').TriangleSoup} Soup.
     */
    const soup = (m) => soups.at(cx, cz, m);
    const facade = soup('facade');
    // Shutters, signs boxes, railings and tanks share the facade soup: one fewer draw call per chunk.
    const metal = facade;
    const glass = soup('glass');
    const lit = soup('glass-lit');
    const H = lot.heightM;
    const gH = lot.groundM;
    const yaw = f.yaw;

    // Side and back walls, bare concrete; the front edge is the painted facade below.
    facade.setColor(SHOPHOUSE_COLORS.bare);
    const poly = lot.polygon;
    for (let k = 0; k < poly.length; k += 1) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      if (Math.abs(toFrame(f, a)[1]) < 1e-6 && Math.abs(toFrame(f, b)[1]) < 1e-6) continue;
      const n = outwardNormal(poly, k);
      if (n) facade.addWallSegment(a, b, 0, H, n);
    }
    facade.setColor(SHOPHOUSE_COLORS.roof);
    facade.addGroundPolygon(poly, H);

    // Painted front: upper wall, pillars and lintel.
    const openTop = gH - LINTEL_M;
    facade.setColor(lot.paint);
    facade.addStandingRect(origin, yaw, [0, gH, w, H], 0, 1);
    facade.addStandingRect(origin, yaw, [0, 0, PILLAR_M, gH], 0, 1);
    facade.addStandingRect(origin, yaw, [w - PILLAR_M, 0, w, gH], 0, 1);
    facade.addStandingRect(origin, yaw, [PILLAR_M, openTop, w - PILLAR_M, gH], 0, 1);

    // Shop opening and roller shutter.
    const x0 = PILLAR_M;
    const x1 = w - PILLAR_M;
    const shutterFrom = lot.shutter === 'closed' ? 0 : lot.shutter === 'half' ? openTop / 2 : openTop;
    if (shutterFrom > 0) {
      facade.setColor(SHOPHOUSE_COLORS.interior);
      facade.addStandingRect(origin, yaw, [x0, 0, x1, shutterFrom], 0, 1);
    }
    metal.setColor(SHOPHOUSE_COLORS.shutter);
    if (shutterFrom < openTop) metal.addStandingRect(origin, yaw, [x0, shutterFrom, x1, openTop], 0, 1);
    if (lot.shutter === 'open') metal.addBox(origin, yaw, [w / 2, openTop - 0.15, 0.12], [x1 - x0, 0.3, 0.24]);

    // Sign board over the opening.
    if (lot.sign !== null) {
      metal.setColor(SHOPHOUSE_COLORS.signBox);
      metal.addBox(origin, yaw, [w / 2, gH - LINTEL_M / 2, 0.06], [w - 0.3, LINTEL_M - 0.1, 0.12]);
      const signs = soup('signs');
      signs.setColor(SHOPHOUSE_COLORS.white);
      signs.addStandingRect(origin, yaw, [0.2, openTop + 0.1, w - 0.2, gH - 0.1], 0.125, 1, atlasCellUv(lot.sign));
    }
    if (lot.awning) {
      const [x, , z] = localToWorld(origin, yaw, [w / 2, 0, 0]);
      awnings.push({ x, y: openTop - 0.05, z, yaw, width: w - 0.4, color: AWNING_COLORS[i % AWNING_COLORS.length] });
    }

    // Upper floors: balcony, railing, window, air conditioner.
    for (let k = 1; k < lot.storeys; k += 1) {
      const y = gH + (k - 1) * lot.upperM;
      const bd = lot.balconyM;
      facade.setColor(lot.paint);
      facade.addBox(origin, yaw, [w / 2, y - 0.075, bd / 2], [w - 0.2, 0.15, bd]);
      if (lot.railing === 'iron') {
        metal.setColor(SHOPHOUSE_COLORS.iron);
        metal.addBox(origin, yaw, [w / 2, y + 0.5, bd - 0.03], [w - 0.2, 1, 0.04]);
      } else {
        facade.addBox(origin, yaw, [w / 2, y + 0.45, bd - 0.05], [w - 0.2, 0.9, 0.1]);
      }
      const win = lot.lit[k - 1] ? lit : glass;
      win.setColor(SHOPHOUSE_COLORS.window);
      win.addStandingRect(origin, yaw, [w * 0.18, y + 0.15, w * 0.82, y + 2.5], 0.02, 1);
      if (lot.ac[k - 1]) {
        metal.setColor(SHOPHOUSE_COLORS.ac);
        metal.addBox(origin, yaw, [w - 0.55, y + 2.65, 0.2], [0.75, 0.5, 0.3]);
      }
    }

    // Roof: parapet, water tank, tôn shed.
    facade.setColor(lot.paint);
    facade.addBox(origin, yaw, [w / 2, H + 0.45, -0.1], [w, 0.9, 0.2]);
    const back = -Math.min(3, f.depth * 0.4);
    if (lot.tank) {
      metal.setColor(SHOPHOUSE_COLORS.tank);
      /** @type {Vec2[]} */
      const ring = [];
      for (let j = 0; j < 8; j += 1) {
        const t = (j / 8) * Math.PI * 2;
        const p = localToWorld(origin, yaw, [w / 2 + Math.cos(t) * 0.55, 0, back + Math.sin(t) * 0.55]);
        ring.push([p[0], p[2]]);
      }
      metal.addPrismBetween(ring, H, H + 1.3);
    }
    if (lot.shed && f.depth > 6) {
      const d = Math.min(4, f.depth * 0.35);
      const zc = -f.depth + d / 2 + 0.3;
      facade.setColor(SHOPHOUSE_COLORS.bare);
      facade.addBox(origin, yaw, [w / 2, H + 1.1, zc], [w - 0.6, 2.2, d]);
      metal.setColor(SHOPHOUSE_COLORS.tonRoof);
      metal.addBox(origin, yaw, [w / 2, H + 2.25, zc], [w - 0.4, 0.08, d + 0.4]);
    }
  });
  return awnings;
}
