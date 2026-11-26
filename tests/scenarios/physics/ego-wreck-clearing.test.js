/**
 * An agent the ego drives into, through the whole sim: the Rapier contact names it, traffic turns
 * it into a wreck on the next step, and it leaves the road `wreckClearS` after that, with the ego
 * standing beside it (well within `wreckClearDistM`, so the far-wreck rule is not what clears it).
 */

import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { DT } from '../../../src/contracts/units.js';
import { createSim } from '../../../src/sim/index.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/index.js').Frame} Frame */
/** @typedef {import('../../../src/contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../../../src/contracts/index.js').CollisionEvent} CollisionEvent */
/** @typedef {import('../../../src/contracts/traffic.js').TrafficParams} TrafficParams */

/** @type {GameMap} */
const JUNCTION = JSON.parse(readFileSync(new URL('../../fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../../src/generated/traffic-params.json', import.meta.url), 'utf8'));
/** @type {VehicleInfo[]} */
const VEHICLES = JSON.parse(readFileSync(new URL('../../../data/vehicles/vehicles.json', import.meta.url), 'utf8'));
const CAR = /** @type {VehicleInfo} */ (VEHICLES.find((v) => v.id === 'car-sedan'));

/** map-junction with the start mid-way along rw-e1, so traffic from the lane's source runs up behind the ego. */
const MID_LANE = structuredClone(JUNCTION);
MID_LANE.route.start = { pos: { x: -60, z: 1.75 }, heading: 0 };

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * Whether a frame's actor is a wreck.
 * @param {Frame} f Frame.
 * @param {string} id Actor id.
 * @returns {boolean} The actor is there, crashed or fallen.
 */
const isWreck = (f, id) => f.actors.some((a) => a.id === id && (a.state === 'crashed' || a.state === 'fallen'));

describe('a traffic agent the ego drives into', () => {
  it('becomes a wreck on the next step and leaves wreckClearS later', () => {
    const sim = createSim(RAPIER, MID_LANE, CAR, { traffic: 'map', params: PARAMS, runSeed: 7, assists: { autoGearbox: true, signalAutoCancel: null } });
    // Wait braked until an agent stands close behind, then reverse into it.
    /** @type {Frame} */
    let f = sim.step({ brakeFront: 1 });
    let target = null;
    for (let k = 0; k < 60 * 60 && target === null; k += 1) {
      f = sim.step({ brakeFront: 1 });
      target =
        f.actors.find(
          (a) => a.id.startsWith('npc-') && a.state === 'stopped' && Math.abs(a.pos.z - 1.75) < 1 && a.pos.x < f.ego.pos.x && f.ego.pos.x - a.pos.x < 2.25 + a.lengthM / 2 + 4,
        )?.id ?? null;
    }
    expect(target).not.toBeNull();
    const id = /** @type {string} */ (target);
    sim.step({ gearCmd: 'down' });
    sim.step({ gearCmd: 'down' });
    /** @type {CollisionEvent | null} */
    let hit = null;
    for (let k = 0; k < 600 && hit === null; k += 1) {
      f = sim.step({ throttle: 0.3 });
      hit = /** @type {CollisionEvent | undefined} */ (f.events.find((e) => e.type === 'collision')) ?? null;
    }
    expect(hit).toMatchObject({ otherId: id });
    const contactTick = f.tick;

    // From the next step on, the agent is a wreck; the ego stands braked beside it.
    const clearTicks = Math.round(PARAMS.wreckClearS / DT);
    let wreckTick = -1;
    let lastPresent = -1;
    let goneTick = -1;
    for (let k = 0; k < clearTicks + 60 && goneTick < 0; k += 1) {
      f = sim.step({ brakeFront: 1 });
      const pose = f.actors.find((a) => a.id === id);
      if (wreckTick < 0) {
        expect(f.tick).toBe(contactTick + 1);
        expect(isWreck(f, id)).toBe(true);
        wreckTick = f.tick;
      }
      if (pose) {
        lastPresent = f.tick;
        expect(Math.hypot(pose.pos.x - f.ego.pos.x, pose.pos.z - f.ego.pos.z)).toBeLessThan(PARAMS.wreckClearDistM);
      } else goneTick = f.tick;
    }
    sim.dispose();
    // Still there one step before wreckClearS has passed, gone within one step after.
    expect(lastPresent - wreckTick).toBeGreaterThanOrEqual(clearTicks - 1);
    expect(goneTick).toBeGreaterThan(0);
    expect(goneTick - wreckTick).toBeLessThanOrEqual(clearTicks + 1);
  });
});
