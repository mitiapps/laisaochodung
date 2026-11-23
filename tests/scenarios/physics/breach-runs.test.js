import { beforeAll, describe, expect, it } from 'vitest';
import { breachesOf, loadShippedMap, straightLine } from '../kinematic/drive.js';
import { drivePhysics, initRapier } from './driver.js';

beforeAll(async () => {
  await initRapier();
});

describe('physics breach runs', () => {
  it('speeding: 54 km/h on the 40 km/h stretch fires in the 10 to 20 km/h band, and nothing else', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-01-co-ban'), 'car-sedan', { cruiseMps: 15 });
    const hits = breachesOf(run.live, 'speeding');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].tierIndex).toBe(1);
    // The lane change past the road works is signalled and clears the barrier at this speed too.
    expect(run.live.breaches.map((b) => b.ruleId).filter((id) => id !== 'speeding')).toEqual([]);
    expect(run.frames.flatMap((f) => f.events).filter((e) => e.type === 'collision')).toEqual([]);
    expect(run.live.endedBy).toBe('finish');
    expect(JSON.stringify(run.live)).toBe(JSON.stringify(run.replay));
  }, 120000);

  it('red light: driving on through the red fires red-light', async () => {
    const run = await drivePhysics(loadShippedMap('tutorial-02-nga-tu'), 'car-sedan', { ignore: ['signal'], maxS: 260 });
    expect(breachesOf(run.live, 'red-light').length).toBeGreaterThan(0);
    expect(JSON.stringify(run.live)).toBe(JSON.stringify(run.replay));
  }, 120000);

  it('crash: a car closing on the car ahead at about 18 km/h fires crash in the heavy tier', async () => {
    const map = loadShippedMap('tutorial-03-ban-dem');
    const run = await drivePhysics(map, 'car-sedan', { cruiseMps: 14.9, path: straightLine(12, 200, 2), maxS: 120 });
    const hits = breachesOf(run.live, 'crash');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].tierIndex).toBe(1);
    expect(JSON.stringify(run.live)).toBe(JSON.stringify(run.replay));
  }, 120000);
});
