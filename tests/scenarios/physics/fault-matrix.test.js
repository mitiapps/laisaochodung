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
import { realBundle } from '../../../scripts/rules/lib/test-support.js';
import { scoreRun } from '../../../src/scoring/index.js';

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
    // The car sets off once the ego has reached its cruise, so its wrong-way flag first shows while
    // the ego already drives at the speed it strikes with: the ego did not speed up into it.
    const run = await driveEast(stage([{ id: 'head-on', path: [[-90, LANE_Z], [-215, LANE_Z]], speed: 4, trigger: { atS: 4 } }]), 6);
    expectReplayEqual(run);
    const hit = firstCarContact(run);
    expect(hit.e.otherViolations).toContain('wrong-way');
    const bundle = await realBundle();
    const flagged = /** @type {import('../../../src/contracts/index.js').Frame} */ (
      run.frames.find((f) => f.actors.some((a) => a.id === 'head-on' && a.violations.includes('wrong-way')))
    );
    const at = /** @type {import('../../../src/contracts/index.js').Frame} */ (run.frames.find((f) => f.tick === hit.tick));
    expect(hit.e.egoSpeed - flagged.ego.speed).toBeLessThanOrEqual(/** @type {number} */ (bundle.collisionPolicy.excuseMaxSpeedGainMps));
    // A hard contact: the frame's speed after the impact is far below the speed the ego struck with.
    expect(at.ego.speed).toBeLessThan(hit.e.egoSpeed / 2);
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

  it('pulling away on green into a red-light runner crossing from the left is a notice', async () => {
    // The signal phases are swapped so the ego has green from t 0; it starts from rest 13 m before
    // its stop line. The only traffic is a stream down the northern approach whose drivers all run
    // the red. Seed 12 gives a glancing contact with a rider: the ego gains several m/s between the
    // rider's red-light flag first showing and the contact, and keeps most of its speed after it.
    const map = stage([]);
    const traffic = /** @type {NonNullable<GameMap['traffic']>} */ (map.traffic);
    traffic.sources = traffic.sources.map((s) => ({ ...s, ratePerH: s.laneId === 'bac-b0' ? 1800 : 0 }));
    for (const sig of map.signals) sig.cycle = { ...sig.cycle, offset: sig.cycle.offset === 30 ? 0 : 30 };
    const startX = -30;
    map.route.start = { ...map.route.start, pos: { x: startX, z: LANE_Z } };
    const params = structuredClone(PARAMS);
    for (const p of Object.values(params.personalities)) p.violations.redLight = 1;
    params.violations.carScale = 1;
    const run = await drivePhysics(map, 'car-sedan', {
      sim: { traffic: 'map', runSeed: 12, params },
      aware: false,
      cruiseMps: 12,
      path: straightLine(startX, 15, LANE_Z),
      maxS: 15 - startX,
    });
    expectReplayEqual(run);
    const contacts = run.frames.flatMap((f) => f.events.flatMap((e) => (e.type === 'collision' && e.otherKind !== 'static' ? [{ f, e }] : [])));
    expect(contacts.length).toBeGreaterThan(0);
    const { f: at, e: hit } = contacts[0];
    expect(hit.otherKind).toBe('motorbike');
    expect(hit.otherViolations).toContain('red-light');
    expect(hit.sameLaneAhead).toBe(false);
    expect(hit.striker).toBe('ego');
    const flagged = run.frames.find((f) => f.actors.some((a) => a.id === hit.otherId && a.violations.includes('red-light')));
    // Fast enough to be charged but for the excuse, and well faster at contact than when the flag
    // first showed, by the frame speed and by the speed the ego struck with.
    expect(at.ego.speed).toBeGreaterThan(0.5);
    expect(at.ego.speed - /** @type {NonNullable<typeof flagged>} */ (flagged).ego.speed).toBeGreaterThan(1);
    expect(hit.egoSpeed - /** @type {NonNullable<typeof flagged>} */ (flagged).ego.speed).toBeGreaterThan(1);
    // The rider is still crossing at the contact, so its red-light run keeps excusing the ego.
    const rider = at.actors.find((a) => a.id === hit.otherId);
    expect(rider?.state).toBe('moving');
    expect(rider?.speed).toBeGreaterThan((await realBundle()).scoring.contactMinEgoSpeed);
    expect(breachesOf(run.live, 'crash').some((b) => b.tick === at.tick)).toBe(false);
    expect(run.live.notices.find((n) => n.tick === at.tick)?.violations).toEqual(['red-light']);
    expect(run.live.breaches.filter((b) => b.tick <= at.tick)).toEqual([]);
    // The right-of-way exception is what makes it a notice: without it the same run is charged.
    const bundle = structuredClone(await realBundle());
    delete bundle.collisionPolicy.rightOfWayViolations;
    const without = scoreRun(bundle, map, run.vehicle, run.frames, { quit: false });
    expect(breachesOf(without, 'crash').some((b) => b.tick === at.tick)).toBe(true);
    expect(without.notices.some((n) => n.tick === at.tick)).toBe(false);
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
