import { describe, expect, it } from 'vitest';
import { breachesOf, constantPlan, loadShippedMap, runPlan, straightLine, vehicleOf } from './drive.js';

const CAR = vehicleOf('car-sedan');
const V = 8.33;

/**
 * A collision event at `t`.
 * @param {number} t Time in seconds.
 * @param {Partial<import('../../../src/contracts/index.js').CollisionEvent>} fields Fields.
 * @returns {import('../../../src/testing/frame-builder.js').ForcedEvent} Event.
 */
function hit(t, fields) {
  return {
    t,
    event: { type: 'collision', otherKind: 'car', otherId: null, impulse: 2000, egoSpeed: V, relSpeed: V, sameLaneAhead: false, ...fields },
  };
}

describe('crash', () => {
  it('breaches a hit on a pedestrian, which ends the run with score 0', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const plan = constantPlan(map, CAR, straightLine(20, 200, 2), V, { events: [hit(3, { otherKind: 'pedestrian', otherId: 'ped-hep' })] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'crash').length).toBeGreaterThan(0);
    expect(report.score).toBe(0);
  });

  it('breaches a light contact with the car ahead, below accidentRelSpeed', async () => {
    const map = loadShippedMap('tutorial-03-ban-dem');
    const relSpeed = 10 / 3.6;
    const plan = constantPlan(map, CAR, straightLine(20, 200, 2), V, {
      lights: 'low',
      events: [hit(3, { otherKind: 'car', otherId: 'npc-ahead', sameLaneAhead: true, relSpeed })],
    });
    const { report } = await runPlan(map, 'car-sedan', plan);
    const hits = breachesOf(report, 'crash');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].tierIndex).toBe(0);
  });

  it('breaches an accident with an NPC car at or above accidentRelSpeed', async () => {
    const map = loadShippedMap('tutorial-03-ban-dem');
    const relSpeed = 25 / 3.6;
    const plan = constantPlan(map, CAR, straightLine(20, 200, 2), V, {
      lights: 'low',
      events: [hit(3, { otherKind: 'car', otherId: 'npc-oncoming-1', relSpeed })],
    });
    const { report } = await runPlan(map, 'car-sedan', plan);
    const hits = breachesOf(report, 'crash');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].tierIndex).toBe(1);
  });

  it('breaches a hit on a static obstacle at speed', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const plan = constantPlan(map, CAR, straightLine(20, 200, 2), V, { events: [hit(3, { otherKind: 'static', relSpeed: 3 })] });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'crash').length).toBeGreaterThan(0);
  });

  it('stays quiet for a contact while the car is stopped, which the policy ignores', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const plan = constantPlan(map, CAR, straightLine(20, 200, 2), 0, {
      durationS: 6,
      events: [hit(3, { otherKind: 'car', egoSpeed: 0, relSpeed: 0 })],
    });
    const { report } = await runPlan(map, 'car-sedan', plan);
    expect(breachesOf(report, 'crash')).toEqual([]);
  });

  it('stays quiet on the clean run', async () => {
    const map = loadShippedMap('tutorial-01-co-ban');
    const { report } = await runPlan(map, 'car-sedan', constantPlan(map, CAR, straightLine(20, 200, 2), V));
    expect(breachesOf(report, 'crash')).toEqual([]);
  });
});
