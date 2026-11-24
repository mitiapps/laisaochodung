/**
 * Cross traffic on `osm-pasteur` keeps moving: agents from each signalled cross-street source reach
 * their junction within the first 2 minutes of the run, for every one of 10 seeds. The ego parks
 * off the carriageway near the junction under test, so the spawn ring and the behind-the-ego
 * despawn keep that junction's sources alive. The longest wait of any agent from a source to its
 * junction is logged as a measurement.
 */

import { describe, expect, it } from 'vitest';
import { headingOf, pointInPolygon, polygonCentroid, projectOntoPolyline } from '../../../src/geometry/index.js';
import { loadShippedMap } from '../kinematic/drive.js';
import { PARAMS, PASTEUR_PARKED_EGO, runTraffic } from './traffic-harness.js';

/** @typedef {import('../../../src/contracts/index.js').Vec2} Vec2 */

const MAP = loadShippedMap('osm-pasteur');
const SEEDS = 10;
/** Time by which each source must have delivered an agent to its junction, seconds. */
const REACH_S = 120;
/** An agent first seen this close to the start of a source lane came from that source, metres. */
const SOURCE_START_M = 25;
/** The ego parks this far from the junction centroid, off every lane and junction, metres. */
const PARK_M = [70, 80, 90, 100];

const LANES = new Map(MAP.roads.flatMap((r) => r.lanes).map((l) => [l.id, l]));
const AREAS = [...LANES.values()].map((l) => l.polygon).concat(MAP.junctions.map((j) => j.polygon));

/** Signalled sources: the source lane and the junction its signal stop line guards. */
const SOURCES = (MAP.traffic?.sources ?? []).flatMap((src) => {
  const line = MAP.stopLines.find((sl) => sl.control === 'signal' && sl.laneIds.includes(src.laneId));
  const lane = LANES.get(src.laneId);
  if (!line || !lane) return [];
  const mid = /** @type {Vec2} */ ([(line.segment[0][0] + line.segment[1][0]) / 2, (line.segment[0][1] + line.segment[1][1]) / 2]);
  let junction = MAP.junctions[0];
  let best = Infinity;
  for (const j of MAP.junctions) {
    const c = polygonCentroid(j.polygon);
    const d = Math.hypot(c[0] - mid[0], c[1] - mid[1]);
    if (d < best) {
      best = d;
      junction = j;
    }
  }
  return [{ laneId: src.laneId, lane, junction }];
});

const JUNCTIONS = [...new Set(SOURCES.map((s) => s.junction))];

/**
 * A parked ego off the carriageway near a junction, facing it, and far enough from every source
 * lane start that the spawner keeps feeding them (`sourceMinEgoDistM`).
 * @param {import('../../../src/contracts/index.js').Junction} j Junction.
 * @returns {typeof PASTEUR_PARKED_EGO} Ego.
 */
function parkedNear(j) {
  const c = polygonCentroid(j.polygon);
  const starts = SOURCES.map((s) => s.lane.centerline[0]);
  for (const r of PARK_M) {
    for (let k = 0; k < 16; k += 1) {
      const a = (k * Math.PI) / 8;
      const p = /** @type {Vec2} */ ([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      if (AREAS.some((poly) => pointInPolygon(p, poly))) continue;
      if (starts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < PARAMS.sourceMinEgoDistM + 5)) continue;
      return { ...PASTEUR_PARKED_EGO, pos: { x: p[0], z: p[1] }, heading: headingOf(c[0] - p[0], c[1] - p[1]) };
    }
  }
  throw new Error(`No parking spot off the carriageway near ${j.id}`);
}

describe('cross traffic on osm-pasteur', () => {
  it('has signalled cross-street sources at more than one junction', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(4);
    expect(JUNCTIONS.length).toBeGreaterThanOrEqual(2);
  });

  describe.each(JUNCTIONS.map((j) => [j.id, j]))('at %s', (_id, junction) => {
    const sources = SOURCES.filter((s) => s.junction === junction);
    const ego = parkedNear(junction);

    it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))(`seed %i: every source delivers an agent within ${REACH_S / 60} min`, (seed) => {
      /** Followed agents by pose id: source index and first-seen time. */
      const followed = new Map();
      /** @type {Set<string>} */
      const seen = new Set();
      /** @type {Array<number | null>} */
      const firstArrival = sources.map(() => null);
      let longestWait = 0;
      runTraffic(
        MAP,
        seed,
        REACH_S,
        (step, t) => {
          for (const p of step.poses) {
            const at = /** @type {Vec2} */ ([p.pos.x, p.pos.z]);
            if (!seen.has(p.id)) {
              seen.add(p.id);
              const k = sources.findIndex((s) => pointInPolygon(at, s.lane.polygon) && projectOntoPolyline(at, s.lane.centerline).s <= SOURCE_START_M);
              if (k >= 0) followed.set(p.id, { k, since: t });
              continue;
            }
            const f = followed.get(p.id);
            if (!f) continue;
            if (pointInPolygon(at, junction.polygon)) {
              firstArrival[f.k] ??= t;
              followed.delete(p.id);
            } else longestWait = Math.max(longestWait, t - f.since);
          }
        },
        ego,
      );
      console.log(`${junction.id} seed ${seed}: first arrivals ${firstArrival.map((x) => (x === null ? 'none' : `${x.toFixed(0)} s`)).join(', ')}; longest wait ${longestWait.toFixed(0)} s`);
      sources.forEach((s, k) => expect(firstArrival[k], `seed ${seed}: an agent from ${s.laneId} reaches ${junction.id}`).not.toBeNull());
    }, 300_000);
  });
});
