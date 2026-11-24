/**
 * Office and hotel towers: a concrete podium with glazed storeys, and an inset glass shaft above
 * it with a curtain-wall grid (spandrel bands at every floor, mullions every 3 m). Some floors are
 * lit at night.
 */

import { polygonCentroid } from '../../geometry/index.js';
import { uniform } from '../../world/random.js';
import { outwardNormal } from '../triangle-soup.js';
import { CIVIC_STOREY_M, TOWER_STOREY_M, edgeFrames } from './lots.js';

/** @typedef {import('./lots.js').TowerLayout} TowerLayout */
/** @typedef {import('./chunks.js').ChunkedSoups} ChunkedSoups */
/** @typedef {[number, number]} Vec2 */

const PODIUM = 0xc9c5bd;
const FRAME = 0x4a4f55;
const ROOF = 0x8b8984;
/** Shaft inset from the podium edge, as a share of the centroid distance (design). */
const SHAFT_SCALE = 0.82;
/** Mullion spacing. */
const MULLION_M = 3;

/**
 * Builds one tower into the chunked soups.
 * @param {TowerLayout} layout Layout.
 * @param {ChunkedSoups} soups Scenery soups.
 */
export function buildTower(layout, soups) {
  const c = polygonCentroid(layout.footprint);
  const facade = soups.at(c[0], c[1], 'facade');
  const glass = soups.at(c[0], c[1], 'glass');
  const lit = soups.at(c[0], c[1], 'glass-lit');
  const P = layout.podiumM;

  for (const e of edgeFrames(layout.footprint, outwardNormal)) {
    facade.setColor(PODIUM);
    for (let k = 0; k < layout.podiumStoreys; k += 1) {
      const y = k * CIVIC_STOREY_M;
      facade.addStandingRect(e.origin, e.yaw, [0, y, e.length, y + 0.9], 0, 1);
      facade.addStandingRect(e.origin, e.yaw, [0, y + 3.9, e.length, y + CIVIC_STOREY_M], 0, 1);
      if (e.length > 1) {
        facade.addStandingRect(e.origin, e.yaw, [0, y + 0.9, 0.5, y + 3.9], 0, 1);
        facade.addStandingRect(e.origin, e.yaw, [e.length - 0.5, y + 0.9, e.length, y + 3.9], 0, 1);
      }
      glass.setColor(layout.glass);
      glass.addStandingRect(e.origin, e.yaw, [0.5, y + 0.9, Math.max(0.5, e.length - 0.5), y + 3.9], 0, 1);
    }
  }
  facade.setColor(PODIUM);
  facade.addGroundPolygon(layout.footprint, P);

  /** @type {Vec2[]} */
  const shaft = layout.footprint.map(([x, z]) => [c[0] + (x - c[0]) * SHAFT_SCALE, c[1] + (z - c[1]) * SHAFT_SCALE]);
  const floors = Math.max(1, Math.round((layout.heightM - P) / TOWER_STOREY_M));
  const top = P + floors * TOWER_STOREY_M;
  for (const e of edgeFrames(shaft, outwardNormal)) {
    for (let k = 0; k < floors; k += 1) {
      const y = P + k * TOWER_STOREY_M;
      const win = uniform(layout.rng) < 0.35 ? lit : glass;
      win.setColor(layout.glass);
      win.addStandingRect(e.origin, e.yaw, [0, y, e.length, y + TOWER_STOREY_M], 0, 1);
      facade.setColor(FRAME);
      facade.addBox(e.origin, e.yaw, [e.length / 2, y + 0.25, 0.05], [e.length, 0.5, 0.1]);
    }
    const mullions = Math.floor(e.length / MULLION_M);
    for (let m = 1; m < mullions; m += 1) {
      facade.addBox(e.origin, e.yaw, [m * MULLION_M, (P + top) / 2, 0.06], [0.12, top - P, 0.12]);
    }
  }
  facade.setColor(ROOF);
  facade.addGroundPolygon(shaft, top);
}
