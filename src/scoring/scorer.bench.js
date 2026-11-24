// Scorer cost with dense traffic: one `scorer.step` with 120 actors in the frame. Budget: 0.5 ms
// per step (`npx vitest bench src/scoring --run`). The ego drives above the following-distance
// speed with the high beam on, signalling a merge, so every actor-reading detector does its full
// work.

import { expect, test } from 'vitest';
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../contracts/index.js';
import { buildFrames } from '../testing/index.js';
import { junctionMap, realBundle, vehicle } from '../../scripts/rules/lib/test-support.js';
import { createScorer } from './index.js';

/** @typedef {import('../contracts/index.js').ActorPose} ActorPose */

const SPEED = 12;
const map = junctionMap();
const car = vehicle('car-sedan');
const bundle = await realBundle();

/**
 * 120 traffic poses around the ego at `t`, in the worst order for the detectors: real frames are
 * in spawn order, so the nearest vehicle in the ego's lanes comes last (every closer candidate
 * gets a lane test), and the 20 pedestrians come first, beside the road within the high-beam
 * box, so each needs its own crossing test before any oncoming car ends the search.
 * @param {number} t Time.
 * @returns {ActorPose[]} Poses.
 */
function traffic(t) {
  const egoX = -150 + SPEED * t;
  /** @type {ActorPose[]} */
  const out = [];
  /**
   * @param {string} id Id.
   * @param {'pedestrian' | 'car' | 'motorbike'} kind Kind.
   * @param {number} x X.
   * @param {number} z Z.
   * @param {number} heading Heading.
   */
  const add = (id, kind, x, z, heading) => {
    out.push({
      id,
      kind,
      pos: { x, z },
      heading,
      speed: kind === 'pedestrian' ? 1.2 : 10,
      active: true,
      model: kind,
      variant: 0,
      lengthM: kind === 'pedestrian' ? 0.5 : kind === 'motorbike' ? 1.9 : 4.5,
      widthM: kind === 'pedestrian' ? 0.5 : kind === 'motorbike' ? 0.8 : 1.8,
      lights: ACTOR_LIGHTS.off,
      state: 'moving',
      violations: NO_VIOLATIONS,
    });
  };
  // Pedestrians just off the road on the far side (z −4), ahead and within lateralM.
  for (let i = 0; i < 20; i += 1) add(`npc-${i}`, 'pedestrian', egoX + 10 + i * 6, -4, Math.PI / 2);
  // Oncoming traffic in the westbound lane.
  for (let i = 0; i < 40; i += 1) add(`npc-${20 + i}`, i % 4 ? 'motorbike' : 'car', egoX + 8 + i * 3.5, -1.75, Math.PI);
  // Same direction in both eastbound lanes, farthest first.
  for (let i = 59; i >= 0; i -= 1) {
    add(`npc-${60 + i}`, i % 4 ? 'motorbike' : 'car', egoX + 6 + i * 1.5, i % 2 ? 1.75 : 5.25, 0);
  }
  return out;
}

const frames = buildFrames({
  map,
  vehicle: car,
  path: [[-150, 1.75], [-110, 1.75], [-100, 5.25], [150, 5.25]],
  speed: SPEED,
  durationS: 8,
  controls: [{ t: 0, lights: 'high', indicators: 'right' }],
  extraActors: traffic,
});

/** Budget per step, in milliseconds. */
const BUDGET_MS = 0.5;

test('scorer step with 120 actors stays within 0.5 ms', async ({ bench }) => {
  const scorer = createScorer(bundle, map, car);
  let state = scorer.initial;
  let i = 0;
  const result = await bench('one scorer step, 120 actors', () => {
    if (i === frames.length) {
      i = 0;
      state = scorer.initial;
    }
    state = scorer.step(state, frames[i]).state;
    i += 1;
  }).run();
  const msPerStep = 1000 / result.throughput.mean;
  console.info(`scorer step, 120 actors: ${msPerStep.toFixed(3)} ms mean`);
  expect(msPerStep).toBeLessThanOrEqual(BUDGET_MS);
});
