import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assertFrame, DT } from '../contracts/index.js';
import { createSim, sanitizeInput } from '../sim/index.js';
import { buildFrames } from './index.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../world/traffic/index.js').WorldStepInput & {ego: {indicators?: string}}} RecordedInput */

/** Every `stepWorld` input of the current call site, in order. */
const recorded = /** @type {RecordedInput[]} */ ([]);

// Records the world step inputs of both the sim and the builder, and leaves the step itself alone.
vi.mock('../world/traffic/index.js', async (importOriginal) => {
  const real = /** @type {typeof import('../world/traffic/index.js')} */ (await importOriginal());
  return {
    ...real,
    /** @type {typeof real.stepWorld} */
    stepWorld: (state, input) => {
      recorded.push(structuredClone(input));
      return real.stepWorld(state, input);
    },
  };
});

/**
 * @param {string} rel Repo-relative path.
 * @returns {unknown} Parsed JSON.
 */
const json = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

const MAP = /** @type {GameMap} */ (json('public/maps/tutorial-02-nga-tu.json'));
const PARAMS = /** @type {import('../contracts/traffic.js').TrafficParams} */ (json('src/generated/traffic-params.json'));
const VEHICLES = /** @type {import('../contracts/index.js').VehicleInfo[]} */ (json('data/vehicles/vehicles.json'));
const CAR = /** @type {import('../contracts/index.js').VehicleInfo} */ (VEHICLES.find((v) => v.id === 'car-sedan'));
const SEED = 2024;
const STEPS = 600;
const SIGNAL_STEP = 30;

beforeAll(async () => {
  await RAPIER.init();
});

describe('buildFrames with traffic', () => {
  it('gives the traffic poses of a sim run when fed its ego poses and seed', () => {
    expect(MAP.traffic).toBeDefined();
    const sim = createSim(RAPIER, MAP, CAR, { traffic: 'map', params: PARAMS, runSeed: SEED });
    recorded.length = 0;
    /** @type {Frame[]} */
    const simFrames = [];
    for (let k = 0; k < STEPS; k += 1) {
      simFrames.push(
        sim.step(
          sanitizeInput({
            gearCmd: k === 0 ? 'up' : null,
            throttle: k < 240 ? 0.3 : 0,
            brakeFront: k >= 300 ? 0.8 : 0,
            signalCmd: k === SIGNAL_STEP ? 'left' : null,
          }),
        ),
      );
    }
    sim.dispose();
    const simInputs = recorded.splice(0);
    expect(simInputs).toHaveLength(STEPS);
    // The builder knows contacts only from collision events; this run must have none.
    expect(simInputs.every((i) => i.egoContacts.length === 0 && !i.egoReset)).toBe(true);
    expect(Math.max(...simFrames.map((f) => f.ego.speed))).toBeGreaterThan(2);

    const built = buildFrames({
      map: MAP,
      vehicle: CAR,
      egoTrack: simInputs.map((i) => ({ pos: { x: i.ego.pos.x, z: i.ego.pos.z }, heading: i.ego.heading, speed: i.ego.speed })),
      controls: [{ t: SIGNAL_STEP * DT, indicators: 'left' }],
      traffic: { params: PARAMS, runSeed: SEED },
      stopAtRunEnd: false,
    });
    const builtInputs = recorded.splice(0);
    expect(built).toHaveLength(STEPS);
    built.forEach((f) => assertFrame(f));

    // The same world step input, the pre-step indicator state included.
    expect(builtInputs.map((i) => i.ego.indicators)).toEqual(simInputs.map((i) => i.ego.indicators));
    expect(simInputs[SIGNAL_STEP].ego.indicators).toBe('off');
    expect(simInputs[SIGNAL_STEP + 1].ego.indicators).toBe('left');
    expect(builtInputs.map((i) => [i.t, i.lights, i.egoContacts, i.egoReset])).toEqual(simInputs.map((i) => [i.t, i.lights, i.egoContacts, i.egoReset]));

    const npc = (/** @type {Frame} */ f) => f.actors.filter((a) => a.id.startsWith('npc-'));
    expect(simFrames.some((f) => npc(f).length > 0)).toBe(true);
    for (let k = 0; k < STEPS; k += 1) {
      expect(JSON.stringify(built[k].actors), `tick ${k}`).toBe(JSON.stringify(simFrames[k].actors));
    }
  });
});
