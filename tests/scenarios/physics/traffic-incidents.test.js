/**
 * NPC–NPC incidents on `osm-pasteur` at full density: the rate stays inside the design band over 20
 * seeds of 5 minutes, every incident names at least one latched violation as its cause, and every
 * wreck is cleared within `wreckClearS` of the incident that made it.
 */

import { describe, expect, it } from 'vitest';
import { loadShippedMap } from '../kinematic/drive.js';
import { PARAMS, runTraffic } from './traffic-harness.js';

const MAP = loadShippedMap('osm-pasteur');
const SEEDS = 20;
const MINUTES = 5;
/** Slack on the clearing time for the step the wreck is removed on, seconds. */
const CLEAR_SLACK_S = 0.1;

describe('NPC incidents on osm-pasteur', () => {
  it(`stay inside the band over ${SEEDS} seeds x ${MINUTES} min, each with a cause, and their wrecks clear`, () => {
    let incidents = 0;
    /** @type {string[]} */
    const uncaused = [];
    /** @type {string[]} */
    const lingering = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      /** Time each wrecked agent was first seen wrecked, by pose id. */
      const wreckedAt = new Map();
      let lastT = 0;
      runTraffic(MAP, seed, MINUTES * 60, (step, t) => {
        lastT = t;
        for (const inc of step.incidents) {
          incidents += 1;
          expect(inc.agentIds.length, `seed ${seed} incident at ${t.toFixed(2)}`).toBeGreaterThan(0);
          if (inc.causes.length === 0) uncaused.push(`seed ${seed} ${inc.agentIds.join('/')} at ${inc.t.toFixed(2)}`);
        }
        /** @type {Set<string>} */
        const present = new Set();
        for (const p of step.poses) {
          if (p.state !== 'crashed' && p.state !== 'fallen') continue;
          present.add(p.id);
          if (!wreckedAt.has(p.id)) wreckedAt.set(p.id, t);
        }
        for (const [id, since] of wreckedAt) {
          if (present.has(id)) {
            if (t - since > PARAMS.wreckClearS + CLEAR_SLACK_S) {
              lingering.push(`seed ${seed} ${id} wrecked at ${since.toFixed(2)}`);
              wreckedAt.delete(id);
            }
          } else wreckedAt.delete(id);
        }
      });
      expect(lastT).toBeGreaterThan(MINUTES * 60 - 1);
    }
    const perMin = incidents / (SEEDS * MINUTES);
    console.log(`NPC incidents: ${incidents} over ${SEEDS * MINUTES} min, ${perMin.toFixed(2)} per minute`);
    expect(uncaused).toEqual([]);
    expect(lingering).toEqual([]);
    expect(perMin).toBeGreaterThanOrEqual(PARAMS.incidentBand.minPerMin);
    expect(perMin).toBeLessThanOrEqual(PARAMS.incidentBand.maxPerMin);
  }, 900_000);
});
