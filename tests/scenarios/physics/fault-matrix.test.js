/**
 * The fault table end to end through the Rapier sim on `tutorial-02-nga-tu`, with real contacts
 * against scripted cars on the straight western approach (lane `tay-f0`, eastbound at z = 1.75).
 * Traffic runs, so collision events carry the striker, the from-behind flag and the other party's
 * violations, but no agent spawns, so each contact is the one the scenario stages. Being struck
 * from behind cannot be staged here: a scripted car holds for anything in its path. The fault
 * unit tests cover that row, and traffic produces it in play.
 *
 * A deduction happens only through a contributing ego episode, the ego running into the car ahead
 * in its lane, or the ego striking a party with no excusing violation. Everything else is a notice.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { breachesOf, loadShippedMap, straightLine } from '../kinematic/drive.js';
import { drivePhysics, initRapier } from './driver.js';
import { PARAMS } from './traffic-harness.js';

/** @typedef {import('../../../src/contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/index.js').MapActor} MapActor */
/** @typedef {Awaited<ReturnType<typeof drivePhysics>>} Run */

const LANE_Z = 1.75;
const START_X = -185;

beforeAll(async () => {
  await initRapier();
});

/**
 * Tutorial 02 with only the given scripted cars and a traffic block that spawns nothing.
 * @param {Array<Partial<MapActor> & {id: string, path: [number, number][], speed: number}>} cars Cars.
 * @returns {GameMap} Map.
 */
function stage(cars) {
  const map = structuredClone(loadShippedMap('tutorial-02-nga-tu'));
  const traffic = /** @type {NonNullable<GameMap['traffic']>} */ (map.traffic);
  map.traffic = {
    ...traffic,
    densityPerKm: Object.fromEntries(Object.keys(traffic.densityPerKm).map((k) => [k, 0])),
    sources: traffic.sources.map((s) => ({ ...s, ratePerH: 0 })),
  };
  map.actors = cars.map((c) => ({ kind: 'car', model: 'npc-sedan', lengthM: 4.5, widthM: 1.8, loop: false, trigger: { atS: 0 }, ...c }));
  return map;
}

/**
 * Drives the ego east along `tay-f0` at a fixed cruise, blind to the staged cars.
 * @param {GameMap} map Map.
 * @param {number} cruiseMps Cruise speed.
 * @param {number} [toX] Where the drive stops.
 * @returns {Promise<Run>} Run.
 */
function driveEast(map, cruiseMps, toX = -40) {
  return drivePhysics(map, 'car-sedan', {
    sim: { traffic: 'map', runSeed: 1, params: PARAMS },
    aware: false,
    cruiseMps,
    path: straightLine(START_X, toX, LANE_Z),
    maxS: toX - START_X,
  });
}

/**
 * First collision event of a run with a scripted car.
 * @param {Run} run Run.
 * @returns {{t: number, tick: number, e: import('../../../src/contracts/index.js').CollisionEvent}} Contact.
 */
function firstCarContact(run) {
  for (const f of run.frames) {
    for (const e of f.events) if (e.type === 'collision' && e.otherKind === 'car') return { t: f.t, tick: f.tick, e };
  }
  throw new Error('The staged contact never happened');
}

/**
 * Asserts the replay equals the live fold.
 * @param {Run} run Run.
 */
function expectReplayEqual(run) {
  expect(JSON.stringify(run.replay)).toBe(JSON.stringify(run.live));
}

describe('fault table end to end on tutorial 02', () => {
  it('running into the slower car ahead in the lane is a deduction', async () => {
    const run = await driveEast(stage([{ id: 'slow-ahead', path: [[-150, LANE_Z], [-20, LANE_Z]], speed: 2 }]), 8.3);
    expectReplayEqual(run);
    const hit = firstCarContact(run);
    expect(hit.e.sameLaneAhead).toBe(true);
    expect(hit.e.striker).not.toBe('other');
    expect(breachesOf(run.live, 'crash').some((b) => b.tick === hit.tick)).toBe(true);
    expect(run.live.notices).toEqual([]);
  }, 120_000);

  it('striking a car parked facing the wrong way, which carries no flag, is a deduction', async () => {
    // The car drives west to its path end in the ego lane and parks there: inactive, so no flag.
    const run = await driveEast(stage([{ id: 'parked', path: [[-140, LANE_Z], [-150, LANE_Z]], speed: 5 }]), 6);
    expectReplayEqual(run);
    const hit = firstCarContact(run);
    expect(hit.e.otherViolations).toEqual([]);
    expect(hit.e.striker).toBe('ego');
    expect(breachesOf(run.live, 'crash').some((b) => b.tick === hit.tick)).toBe(true);
    expect(run.live.notices).toEqual([]);
  }, 120_000);

  it('a car driving head-on in the ego lane carries wrong-way, and striking it is a notice', async () => {
    const run = await driveEast(stage([{ id: 'head-on', path: [[-90, LANE_Z], [-215, LANE_Z]], speed: 4 }]), 6);
    expectReplayEqual(run);
    const hit = firstCarContact(run);
    expect(hit.e.otherViolations).toContain('wrong-way');
    expect(breachesOf(run.live, 'crash')).toEqual([]);
    expect(run.live.notices.length).toBeGreaterThan(0);
    expect(run.live.notices[0].violations).toContain('wrong-way');
  }, 120_000);

  it('a contributing ego episode makes even a wrong-way contact a deduction', async () => {
    // Far over the limit on the approach: the speeding episode is active at the contact.
    const run = await driveEast(stage([{ id: 'head-on', path: [[-20, LANE_Z], [-215, LANE_Z]], speed: 4 }]), 22, -30);
    expectReplayEqual(run);
    const hit = firstCarContact(run);
    expect(hit.e.otherViolations).toContain('wrong-way');
    expect(breachesOf(run.live, 'speeding').length).toBeGreaterThan(0);
    const crash = breachesOf(run.live, 'crash').find((b) => b.tick === hit.tick);
    expect(crash?.cause).toBe('speeding');
    expect(run.live.notices).toEqual([]);
  }, 120_000);

  it('the legal driver keeps its distance behind a car that stops dead, with no contact', async () => {
    // The scripted car stops at its path end in one step, harder than any braking limit.
    const map = stage([{ id: 'stops-dead', path: [[-170, LANE_Z], [-90, LANE_Z]], speed: 7 }]);
    const run = await drivePhysics(map, 'car-sedan', {
      sim: { traffic: 'map', runSeed: 1, params: PARAMS },
      cruiseMps: 8.3,
      path: straightLine(START_X, -60, LANE_Z),
      maxS: 125,
    });
    expectReplayEqual(run);
    expect(run.frames.flatMap((f) => f.events.filter((e) => e.type === 'collision'))).toEqual([]);
    expect(run.live.breaches).toEqual([]);
    const last = /** @type {import('../../../src/contracts/index.js').Frame} */ (run.frames.at(-1));
    expect(last.ego.speed).toBeLessThan(0.2);
    expect(last.ego.pos.x).toBeLessThan(-90 - 4.5);
  }, 120_000);
});
