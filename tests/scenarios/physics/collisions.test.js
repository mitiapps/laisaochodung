import { beforeAll, describe, expect, it } from 'vitest';
import { breachesOf, loadShippedMap, straightLine } from '../kinematic/drive.js';
import { drivePhysics, initRapier } from './driver.js';

/** Closing speed of a contact that the accident threshold (scoring.yaml accidentRelSpeed) splits. */
const ACCIDENT_REL_MPS = 4.2;

beforeAll(async () => {
  await initRapier();
});

/**
 * The map with the route start moved to `(x, z)`, heading east, so a physics run can begin there.
 * @param {import('../../../src/contracts/index.js').GameMap} map Map.
 * @param {number} x Start x.
 * @param {number} z Start z.
 * @returns {import('../../../src/contracts/index.js').GameMap} Map.
 */
function startAt(map, x, z) {
  return { ...structuredClone(map), route: { ...map.route, start: { pos: { x, z }, heading: 0 } } };
}

/**
 * The live fold of a run equals the replay of its recorded frames, endedBy included.
 * @param {Awaited<ReturnType<typeof drivePhysics>>} run Run.
 */
function expectReplayEqual(run) {
  expect(JSON.stringify(run.live)).toBe(JSON.stringify(run.replay));
}

/**
 * The first contact of a run with an actor: its time, the other kind, and the closing speed.
 * @param {Awaited<ReturnType<typeof drivePhysics>>} run Run.
 * @returns {{t: number, otherKind: string, relSpeed: number, egoSpeed: number} | null} Contact.
 */
function firstContact(run) {
  for (const f of run.frames) {
    for (const e of f.events) {
      if (e.type === 'collision') return { t: f.t, otherKind: e.otherKind, relSpeed: e.relSpeed, egoSpeed: e.egoSpeed };
    }
  }
  return null;
}

/**
 * The crash breach raised by the contact at `hit`, which must exist and be the only one at that time.
 * @param {Awaited<ReturnType<typeof drivePhysics>>} run Run.
 * @param {{t: number}} hit Contact.
 * @returns {import('../../../src/contracts/index.js').Breach} Breach.
 */
function crashAtContact(run, hit) {
  const hits = breachesOf(run.live, 'crash').filter((b) => Math.abs(b.t - hit.t) < 0.05);
  expect(hits.length).toBeGreaterThan(0);
  return hits[0];
}

describe('physics contacts with the NPC car ahead on tutorial 03', () => {
  it('car closing at about 10 km/h on the car ahead is a light contact, tier 0', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-03-ban-dem'), 'car-sedan', { cruiseMps: 10.8, path: straightLine(12, 200, 2), maxS: 120 });
    expectReplayEqual(run);
    const hit = firstContact(run);
    expect(hit?.otherKind).toBe('car');
    expect(hit.relSpeed).toBeLessThan(ACCIDENT_REL_MPS);
    expect(crashAtContact(run, hit).tierIndex).toBe(0);
  }, 120000);

  it('car closing at about 18 km/h on the car ahead is an accident, tier 1', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-03-ban-dem'), 'car-sedan', { cruiseMps: 14.9, path: straightLine(12, 200, 2), maxS: 120 });
    expectReplayEqual(run);
    const hit = firstContact(run);
    expect(hit.relSpeed).toBeGreaterThanOrEqual(ACCIDENT_REL_MPS);
    expect(crashAtContact(run, hit).tierIndex).toBe(1);
  }, 120000);

  it('scooter closing at about 10 km/h on the car ahead is a light contact, tier 0', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-03-ban-dem'), 'scooter', { cruiseMps: 10.8, path: straightLine(12, 200, 2), maxS: 120 });
    expectReplayEqual(run);
    const hit = firstContact(run);
    expect(hit?.otherKind).toBe('car');
    expect(hit.relSpeed).toBeLessThan(ACCIDENT_REL_MPS);
    expect(crashAtContact(run, hit).tierIndex).toBe(0);
  }, 120000);

  it('scooter closing at about 21 km/h on the car ahead is an accident, tier 1', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-03-ban-dem'), 'scooter', { cruiseMps: 14.9, path: straightLine(12, 200, 2), maxS: 120 });
    expectReplayEqual(run);
    const hit = firstContact(run);
    expect(hit.relSpeed).toBeGreaterThanOrEqual(ACCIDENT_REL_MPS);
    expect(crashAtContact(run, hit).tierIndex).toBe(1);
  }, 120000);
});

describe('physics contacts with the road-works barrier on tutorial 01', () => {
  it('a light hit on the barrier at about 9 km/h is tier 0', async () => {
    const map = startAt(loadShippedMap('tutorial-01-co-ban'), 230, 5);
    const run = await drivePhysics(map, 'car-sedan', { cruiseMps: 2.5, path: straightLine(230, 340, 5), maxS: 110 });
    expectReplayEqual(run);
    const hit = firstContact(run);
    expect(hit?.otherKind).toBe('static');
    expect(hit.relSpeed).toBeLessThan(ACCIDENT_REL_MPS);
    expect(crashAtContact(run, hit).tierIndex).toBe(0);
  }, 120000);

  it('a heavy hit on the barrier at 30 km/h is tier 1', async () => {
    const map = startAt(loadShippedMap('tutorial-01-co-ban'), 230, 5);
    const run = await drivePhysics(map, 'car-sedan', { cruiseMps: 8.33, path: straightLine(230, 340, 5), maxS: 110 });
    expectReplayEqual(run);
    const hit = firstContact(run);
    expect(hit?.otherKind).toBe('static');
    expect(hit.relSpeed).toBeGreaterThanOrEqual(ACCIDENT_REL_MPS);
    expect(crashAtContact(run, hit).tierIndex).toBe(1);
  }, 120000);
});
