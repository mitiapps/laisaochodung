/**
 * Headless traffic runs for the traffic scenario tests: `stepTraffic` alone on a shipped map, with
 * the ego parked off the carriageway, no Rapier and no render, so seed sweeps stay fast.
 */

import { readFileSync } from 'node:fs';
import { DT } from '../../../src/contracts/units.js';
import { trafficLightStates } from '../../../src/world/index.js';
import { createTraffic, stepTraffic } from '../../../src/world/traffic/index.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/world/traffic/state.js').TrafficState} TrafficState */
/** @typedef {ReturnType<typeof stepTraffic>} TrafficStep */

/** @type {import('../../../src/contracts/index.js').TrafficParams} */
export const PARAMS = JSON.parse(readFileSync(new URL('../../../src/generated/traffic-params.json', import.meta.url), 'utf8'));

/** The ego parked off the road between the Pasteur junctions, as the traffic flow tests park it. */
export const PASTEUR_PARKED_EGO = Object.freeze({ pos: { x: -40, z: -120 }, heading: 2.4, speed: 0, lengthM: 4.5, widthM: 1.8 });

/**
 * Runs the traffic of one seed for `seconds`, calling `visit` after every step.
 * @param {GameMap} map Map with a traffic block.
 * @param {number} seed Run seed.
 * @param {number} seconds Simulated time.
 * @param {(step: TrafficStep, t: number, st: TrafficState) => void} visit Called after each step.
 * @param {typeof PASTEUR_PARKED_EGO} [ego] Ego, standing still; default parked on `osm-pasteur`.
 * @returns {TrafficState} Final state.
 */
export function runTraffic(map, seed, seconds, visit, ego = PASTEUR_PARKED_EGO) {
  const st = createTraffic(map, PARAMS, seed);
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const t = i * DT;
    const step = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
    visit(step, t, st);
  }
  return st;
}
