import { beforeAll, describe, expect, it } from 'vitest';
import { breachesOf, loadShippedMap } from '../kinematic/drive.js';
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

describe('physics clean runs', () => {
  it('car on tutorial 01 finishes at 10', async () => {
    expectCleanFinish(await drivePhysics(loadShippedMap('tutorial-01-co-ban'), 'car-sedan'));
  }, 120000);

  it('car on tutorial 02 finishes at 10, stopping at the red light and the STOP line', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-02-nga-tu'), 'car-sedan');
    expectCleanFinish(run);
    expect(breachesOf(run.live, 'red-light')).toEqual([]);
    expect(breachesOf(run.live, 'stop-sign')).toEqual([]);
  }, 180000);

  it('car on tutorial 03 finishes at 10 at night in the rain', async () => {
    expectCleanFinish(await drivePhysics(loadShippedMap('tutorial-03-ban-dem'), 'car-sedan'));
  }, 120000);

  it('scooter on tutorial 01 finishes at 10', async () => {
    expectCleanFinish(await drivePhysics(loadShippedMap('tutorial-01-co-ban'), 'scooter'));
  }, 120000);

  it('replays the same frames for the same run', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const a = await drivePhysics(map, 'car-sedan', { maxS: 150 });
    const b = await drivePhysics(map, 'car-sedan', { maxS: 150 });
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
  }, 120000);
});
