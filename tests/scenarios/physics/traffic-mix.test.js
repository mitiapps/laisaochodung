/**
 * The traffic mix on `osm-pasteur`: motorbikes make up 70–80% of spawns, riders bunch side by side
 * at a red light within a few metres of the stop line, and the active count never exceeds the
 * map's derived `maxAgents`. Tutorial 03 spawns the same share.
 */

import { describe, expect, it } from 'vitest';
import { headingVector, pointInPolygon, projectOntoPolyline } from '../../../src/geometry/index.js';
import { trafficLightStates } from '../../../src/world/index.js';
import { loadShippedMap } from '../kinematic/drive.js';
import { runTraffic } from './traffic-harness.js';

const MAP = loadShippedMap('osm-pasteur');
const SEEDS = 20;
const SECONDS = 180;
/** Front of a stopped rider within this distance of the stop line counts as at the line, metres. */
const AT_LINE_M = 6;
/** Riders that must stand at one red line together. */
const SIDE_BY_SIDE = 4;

/** Signal stop lines with the polygons of the lanes they control. */
const RED_LINES = MAP.stopLines
  .filter((sl) => sl.control === 'signal')
  .map((sl) => ({
    signalId: /** @type {string} */ (sl.signalId),
    segment: sl.segment,
    lanes: MAP.roads.flatMap((r) => r.lanes).filter((l) => sl.laneIds.includes(l.id)).map((l) => l.polygon),
  }));

/**
 * Riders standing with their front within `AT_LINE_M` behind a red stop line, most at one line.
 * @param {import('../../../src/contracts/index.js').ActorPose[]} poses Poses.
 * @param {Record<string, string>} lights Light states.
 * @returns {number} Largest count at one line.
 */
function ridersAtRed(poses, lights) {
  let best = 0;
  for (const line of RED_LINES) {
    if (lights[line.signalId] !== 'red') continue;
    let n = 0;
    for (const p of poses) {
      if (p.kind !== 'motorbike' || p.speed > 0.1) continue;
      const at = /** @type {[number, number]} */ ([p.pos.x, p.pos.z]);
      if (!line.lanes.some((poly) => pointInPolygon(at, poly))) continue;
      const pr = projectOntoPolyline(at, line.segment);
      const [hx, hz] = headingVector(p.heading);
      // Behind the line: the rider faces it.
      if ((pr.point[0] - at[0]) * hx + (pr.point[1] - at[1]) * hz <= 0) continue;
      if (pr.distance - p.lengthM / 2 <= AT_LINE_M) n += 1;
    }
    best = Math.max(best, n);
  }
  return best;
}

describe('traffic mix on osm-pasteur', () => {
  it(`spawns 70–80% motorbikes, bunches riders at red and stays within maxAgents over ${SEEDS} seeds`, () => {
    const maxAgents = /** @type {NonNullable<typeof MAP.traffic>} */ (MAP.traffic).maxAgents;
    let motorbikes = 0;
    let spawns = 0;
    let fewestAtRed = Infinity;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      /** @type {Set<string>} */
      const seen = new Set();
      let peakActive = 0;
      let peakAtRed = 0;
      runTraffic(MAP, seed, SECONDS, (step, t, st) => {
        peakActive = Math.max(peakActive, st.activeCount);
        for (const p of step.poses) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          spawns += 1;
          if (p.kind === 'motorbike') motorbikes += 1;
        }
        if (step.state.tick % 6 === 0) peakAtRed = Math.max(peakAtRed, ridersAtRed(step.poses, trafficLightStates(MAP, t)));
      });
      expect(peakActive, `seed ${seed}: active agents`).toBeLessThanOrEqual(maxAgents);
      fewestAtRed = Math.min(fewestAtRed, peakAtRed);
      expect(peakAtRed, `seed ${seed}: riders standing together at a red line`).toBeGreaterThanOrEqual(SIDE_BY_SIDE);
    }
    const share = motorbikes / spawns;
    console.log(`motorbike share ${(share * 100).toFixed(1)}% of ${spawns} spawns; riders at one red line, worst seed ${fewestAtRed}`);
    expect(share).toBeGreaterThanOrEqual(0.7);
    expect(share).toBeLessThanOrEqual(0.8);
  }, 600_000);

  it('spawns 70–80% motorbikes on tutorial-03-ban-dem too, its scripted cars aside', () => {
    const map = loadShippedMap('tutorial-03-ban-dem');
    // The ego stands at the route start, as a player does before driving off.
    const ego = { pos: { ...map.route.start.pos }, heading: map.route.start.heading, speed: 0, lengthM: 4.5, widthM: 1.8 };
    let motorbikes = 0;
    let spawns = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      /** @type {Set<string>} */
      const seen = new Set();
      runTraffic(
        map,
        seed,
        SECONDS,
        (step) => {
          // Traffic agents only: scripted actors are not part of the step's poses.
          for (const p of step.poses) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            spawns += 1;
            if (p.kind === 'motorbike') motorbikes += 1;
          }
        },
        ego,
      );
    }
    const share = motorbikes / spawns;
    expect(spawns).toBeGreaterThan(100);
    expect(share).toBeGreaterThanOrEqual(0.7);
    expect(share).toBeLessThanOrEqual(0.8);
  }, 600_000);
});

