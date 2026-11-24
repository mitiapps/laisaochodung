import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../public/maps/osm-pasteur.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
/** The ego parked off the road between the Pasteur junctions, so the ring keeps them full. */
const EGO = Object.freeze({ pos: { x: -40, z: -120 }, heading: 2.4, speed: 0, lengthM: 4.5, widthM: 1.8 });

// The band is checked over 50 seeds x 5 simulated minutes with TRAFFIC_LONG=1; the default suite
// runs 12 seeds of the same length to stay fast.
const { env } = process;
const SEEDS = env.TRAFFIC_LONG ? 50 : 12;
const MINUTES = 5;

describe('NPC incident rate on osm-pasteur at full density', () => {
  it(`stays inside incidentBand over ${SEEDS} seeds x ${MINUTES} min, every incident with a cause`, () => {
    let incidents = 0;
    /** @type {string[]} */
    const uncaused = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const st = createTraffic(MAP, PARAMS, seed);
      for (let i = 0; i < Math.round((MINUTES * 60) / DT); i += 1) {
        const t = i * DT;
        const step = stepTraffic(st, { ego: EGO, egoReset: false, scripted: [], lights: trafficLightStates(MAP, t), egoContacts: [], t });
        for (const inc of step.incidents) {
          incidents += 1;
          if (inc.causes.length === 0) uncaused.push(`seed ${seed} ${inc.agentIds.join('/')}@${t.toFixed(2)}`);
        }
      }
    }
    const perMin = incidents / (SEEDS * MINUTES);
    expect(uncaused).toEqual([]);
    expect(perMin).toBeGreaterThanOrEqual(PARAMS.incidentBand.minPerMin);
    expect(perMin).toBeLessThanOrEqual(PARAMS.incidentBand.maxPerMin);
  }, 900_000);
});
