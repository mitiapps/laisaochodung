/**
 * Traffic stays populated around a player driving `osm-pasteur`: a ghost ego (perceived by traffic,
 * never touching it) drives the route at up to 8 m/s, slowing for bends, then stands at the finish. After the first 30 s the
 * active count never falls below 30, and no agent is spawned only to be despawned at once, for
 * being behind the ego or beyond the ring, within 1 s of its spawn.
 */

import { describe, expect, it } from 'vitest';
import { DT } from '../../../src/contracts/units.js';
import { angleDiff, headingOf } from '../../../src/geometry/index.js';
import { trafficLightStates } from '../../../src/world/signals.js';
import { createTraffic, stepTraffic } from '../../../src/world/traffic/index.js';
import { loadShippedMap, routePath } from '../kinematic/drive.js';
import { PARAMS } from './traffic-harness.js';

/** @typedef {import('../../../src/contracts/index.js').Vec2} Vec2 */

const MAP = loadShippedMap('osm-pasteur');
const SEEDS = [1, 2, 3, 4, 5];
const SPEED_MPS = 8;
/** The ghost slows for bends, as a driver does: lateral acceleration at most this, m/s². */
const LATERAL_MPS2 = 3;
/** Bend curvature is measured over this stretch of the path either side, metres. */
const BEND_SPAN_M = 3;
/** Standing at the finish after the drive, seconds. */
const PARKED_S = 30;
/** The count is checked from this time on, seconds. */
const SETTLE_S = 30;
const MIN_ACTIVE = 30;
/** A despawn this soon after the spawn means the spawn was wasted, seconds. */
const WASTED_S = 1;

/**
 * Pose on a polyline at distance `d` (clamped to its end).
 * @param {Vec2[]} line Polyline.
 * @param {number[]} cum Distance at each vertex.
 * @param {number} d Distance.
 * @returns {{x: number, z: number, heading: number}} Pose.
 */
function poseAt(line, cum, d) {
  let i = 1;
  while (i < line.length - 1 && cum[i] < d) i += 1;
  const a = line[i - 1];
  const b = line[i];
  const f = Math.min(1, Math.max(0, (d - cum[i - 1]) / (cum[i] - cum[i - 1])));
  return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, heading: headingOf(b[0] - a[0], b[1] - a[1]) };
}

describe('traffic population around a player on osm-pasteur', () => {
  const line = routePath(MAP);
  /** @type {number[]} */
  const cum = [0];
  for (let i = 1; i < line.length; i += 1) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const total = cum[cum.length - 1];

  it.each(SEEDS)(`seed %i keeps at least ${MIN_ACTIVE} agents and wastes no spawn`, (seed) => {
    const st = createTraffic(MAP, PARAMS, seed);
    /** @type {Map<string, number>} */
    const bornAt = new Map();
    // Agents of the pre-roll were born before the run.
    for (let i = 0; i < st.activeCount; i += 1) bornAt.set(`npc-${st.spawnIndex[st.active[i]]}`, -Infinity);
    let lowest = Infinity;
    let lowestAt = 0;
    /** @type {string[]} */
    const wasted = [];
    let d = 0;
    let parkedFor = 0;
    for (let i = 0; parkedFor < PARKED_S; i += 1) {
      const t = i * DT;
      // Heading along the chord through the path ahead and behind, so it turns smoothly.
      const p = poseAt(line, cum, d);
      const ahead = poseAt(line, cum, d + BEND_SPAN_M);
      const behind = poseAt(line, cum, Math.max(0, d - BEND_SPAN_M));
      p.heading = headingOf(ahead.x - behind.x, ahead.z - behind.z);
      const turn = Math.abs(angleDiff(ahead.heading, behind.heading));
      const speed = d < total ? Math.min(SPEED_MPS, Math.sqrt(LATERAL_MPS2 / Math.max(1e-6, turn / (2 * BEND_SPAN_M)))) : 0;
      const ego = { pos: { x: p.x, z: p.z }, heading: p.heading, speed, lengthM: 4.5, widthM: 1.8 };
      d = Math.min(total, d + speed * DT);
      if (speed === 0) parkedFor += DT;
      const behindBefore = st.stats.despawned.behind;
      const before = behindBefore + st.stats.despawned.ring;
      const ids = new Set(bornAt.keys());
      const { poses } = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(MAP, t), egoContacts: [], t });
      for (const pose of poses) {
        ids.delete(pose.id);
        if (!bornAt.has(pose.id)) bornAt.set(pose.id, t);
      }
      // Agents gone this step: if more left for being behind or beyond the ring than had lived
      // longer than WASTED_S, a young one was among them.
      let old = 0;
      for (const id of ids) {
        if (t - /** @type {number} */ (bornAt.get(id)) > WASTED_S - DT / 2) old += 1;
        bornAt.delete(id);
      }
      const removed = st.stats.despawned.behind + st.stats.despawned.ring - before;
      if (removed > old) wasted.push(`${removed - old} at ${t.toFixed(2)} s (${st.stats.despawned.behind > behindBefore ? 'behind' : 'ring'})`);
      if (t >= SETTLE_S && st.activeCount < lowest) {
        lowest = st.activeCount;
        lowestAt = t;
      }
    }
    expect(lowest, `seed ${seed}: lowest count, at ${lowestAt.toFixed(0)} s`).toBeGreaterThanOrEqual(MIN_ACTIVE);
    expect(wasted, `seed ${seed}: spawns despawned at once`).toEqual([]);
  }, 120_000);
});
