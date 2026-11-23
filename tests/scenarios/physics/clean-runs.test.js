import { beforeAll, describe, expect, it } from 'vitest';
import { footprint, polygonsIntersect } from '../../../src/geometry/index.js';
import { breachesOf, laneLineCrossings, loadShippedMap, vehicleOf } from '../kinematic/drive.js';
import { drivePhysics, initRapier } from './driver.js';

beforeAll(async () => {
  await initRapier();
});

/**
 * Asserts a clean physics run: score 10, no breach, finished, and the live fold equals the replay.
 * @param {Awaited<ReturnType<typeof drivePhysics>>} run Run.
 */
function expectCleanFinish(run) {
  expect(run.live.breaches).toEqual([]);
  expect(run.live.score).toBe(10);
  expect(run.live.endedBy).toBe('finish');
  expect(JSON.stringify(run.live)).toBe(JSON.stringify(run.replay));
}

/**
 * Sides of the lane-line crossings the ego actually drove.
 * @param {import('../../../src/contracts/index.js').GameMap} map Map.
 * @param {Awaited<ReturnType<typeof drivePhysics>>} run Run.
 * @returns {string[]} Sides, in order.
 */
function laneChanges(map, run) {
  /** @type {[number, number][]} */
  const track = [];
  for (const f of run.frames) {
    const last = track.at(-1);
    if (!last || Math.hypot(f.ego.pos.x - last[0], f.ego.pos.z - last[1]) > 0.2) track.push([f.ego.pos.x, f.ego.pos.z]);
  }
  return laneLineCrossings(map, track).map((c) => c.side);
}

describe('physics clean runs', () => {
  it('car on tutorial 01 finishes at 10, with one signalled move to the kerb lane past the road works', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const run = await drivePhysics(map, 'car-sedan');
    expectCleanFinish(run);
    expect(laneChanges(map, run)).toEqual(['right']);
  }, 120000);

  it('car on tutorial 02 finishes at 10, stopping at the red light and the STOP line', async () => {
    const map = loadShippedMap('tutorial-02-nga-tu');
    const run = await drivePhysics(map, 'car-sedan');
    expectCleanFinish(run);
    expect(breachesOf(run.live, 'red-light')).toEqual([]);
    expect(breachesOf(run.live, 'stop-sign')).toEqual([]);

    // The two right turns (j3 onto the one-way street, j4 onto cuoi) go kerb lane to kerb lane:
    // the whole body stays off the pavements and out of the other lanes, with no contact.
    const veh = vehicleOf('car-sedan');
    const pavements = map.pavements.map((p) => p.polygon);
    const lanes = map.roads.flatMap((r) => r.lanes);
    const otherLanes = ['mot-chieu-f1', 'cuoi-b0'].map((id) => {
      const lane = lanes.find((l) => l.id === id);
      if (!lane) throw new Error(`No lane ${id}`);
      return lane.polygon;
    });
    const corners = map.junctions.filter((j) => j.id === 'j-j3' || j.id === 'j-j4');
    expect(corners).toHaveLength(2);
    let checked = 0;
    for (const f of run.frames) {
      const near = corners.some((j) => j.polygon.some(([x, z]) => Math.hypot(f.ego.pos.x - x, f.ego.pos.z - z) < 15));
      if (!near) continue;
      checked += 1;
      const body = footprint(f.ego.pos, f.ego.heading, veh.lengthM, veh.widthM);
      expect(pavements.some((p) => polygonsIntersect(body, p)), `body on a pavement at t ${f.t.toFixed(2)}`).toBe(false);
      expect(otherLanes.some((p) => polygonsIntersect(body, p)), `body in another lane at t ${f.t.toFixed(2)}`).toBe(false);
      expect(f.events.filter((e) => e.type === 'collision'), `contact at t ${f.t.toFixed(2)}`).toEqual([]);
    }
    expect(checked).toBeGreaterThan(100);
  }, 180000);

  it('car on tutorial 03 finishes at 10 at night in the rain', async () => {
    expectCleanFinish(await drivePhysics(loadShippedMap('tutorial-03-ban-dem'), 'car-sedan'));
  }, 120000);

  it('scooter on tutorial 01 finishes at 10, with one signalled lane change', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const run = await drivePhysics(map, 'scooter');
    expectCleanFinish(run);
    expect(laneChanges(map, run)).toEqual(['right']);
  }, 120000);

  it('car on osm-pasteur finishes at 10, moving to the kerb lane before the right turn', async () => {
    const map = loadShippedMap('osm-pasteur');
    const run = await drivePhysics(map, 'car-sedan');
    expectCleanFinish(run);
    expect(laneChanges(map, run)).toEqual(['right']);
  }, 180000);

  it('replays the same frames for the same run', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const a = await drivePhysics(map, 'car-sedan', { maxS: 150 });
    const b = await drivePhysics(map, 'car-sedan', { maxS: 150 });
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
  }, 120000);
});
