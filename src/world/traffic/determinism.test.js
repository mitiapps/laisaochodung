import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';
import { drawAgent } from './state.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));

/**
 * Runs `steps` steps with a moving ego and returns every step's poses as JSON.
 * @param {GameMap} map Map.
 * @param {number} seed Run seed.
 * @param {number} steps Steps.
 * @returns {{json: string, st: import('./state.js').TrafficState}} Poses and the final state.
 */
function record(map, seed, steps) {
  const st = createTraffic(map, PARAMS, seed);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    const t = i * DT;
    const ego = { pos: { x: -150 + 8 * t, z: 1.75 }, heading: 0, speed: 8, lengthM: 4.5, widthM: 1.8 };
    const { poses } = stepTraffic(st, { ego, egoReset: i === 1800, scripted: [], lights: trafficLightStates(map, t), egoContacts: i === 900 ? [poses0(st)] : [], t });
    out.push(JSON.stringify(poses));
  }
  return { json: out.join('\n'), st };
}

/**
 * Id of the first active agent, for an ego contact mid-run.
 * @param {import('./state.js').TrafficState} st State.
 * @returns {string} Id or ''.
 */
function poses0(st) {
  return st.activeCount > 0 ? st.ids[st.active[0]] : '';
}

describe('determinism', () => {
  it('gives the same poses for the same seed over 3,600 steps, and different traffic for another seed', () => {
    const a = record(MAP, 77, 3600);
    const b = record(MAP, 77, 3600);
    expect(a.json).toBe(b.json);
    expect(a.st.stats).toEqual(b.st.stats);
    const c = record(MAP, 78, 3600);
    expect(c.json).not.toBe(a.json);
  }, 60_000);

  it('mixes the map seed into the run seed', () => {
    const map = structuredClone(MAP);
    /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic).seed += 1;
    expect(record(map, 77, 60).json).not.toBe(record(MAP, 77, 60).json);
  });

  it('keeps agent N’s draws whatever comes after it', () => {
    // Fewer slots change when and where later agents spawn, never an agent's own draws.
    const small = structuredClone(MAP);
    /** @type {import('../../contracts/map.js').TrafficConfig} */ (small.traffic).maxAgents = 20;
    const a = createTraffic(MAP, PARAMS, 5);
    const b = createTraffic(small, PARAMS, 5);
    expect(a.seed).toBe(b.seed);
    for (let n = 0; n < 30; n += 1) {
      const lone = drawAgent(PARAMS, a.seed, MAP.id, n, 3);
      expect(drawAgent(PARAMS, b.seed, MAP.id, n, 3)).toEqual(lone);
    }
    // In a run, every live agent's stored draws equal its stand-alone draws.
    for (const st of [a, b]) {
      for (let i = 0; i < st.activeCount; i += 1) {
        const k = st.active[i];
        const model = PARAMS.models[st.modelKeys[st.model[k]]];
        const d = drawAgent(PARAMS, st.seed, MAP.id, st.spawnIndex[k], model.variants);
        expect([st.personality[k], st.v0Factor[k], st.variant[k], st.routeSeed[k]]).toEqual([d.personality, d.v0Factor, d.variant, d.routeSeed]);
      }
    }
  });

  it('draws personalities near their shares', () => {
    const counts = [0, 0, 0];
    for (let n = 0; n < 20000; n += 1) counts[drawAgent(PARAMS, 123, MAP.id, n, 1).personality] += 1;
    expect(counts[0] / 20000).toBeCloseTo(PARAMS.personalities.careful.share, 1);
    expect(counts[1] / 20000).toBeCloseTo(PARAMS.personalities.normal.share, 1);
    expect(counts[2] / 20000).toBeCloseTo(PARAMS.personalities.reckless.share, 1);
  });
});
