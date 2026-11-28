import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { zonesAt } from '../../map-query/index.js';
import { limitFor } from '../../scoring/context.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';
import { buildLaneGraph, edgeLimitKmh } from './lane-graph.js';
import { lawfulParams } from './lawful-params.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('./lane-graph.js').LimitClass} LimitClass */

const MAPS_DIR = new URL('../../../public/maps/', import.meta.url);
/** @type {GameMap[]} */
const MAPS = readdirSync(MAPS_DIR)
  .filter((/** @type {string} */ n) => n.endsWith('.json') && n !== 'index.json')
  .sort()
  .map((/** @type {string} */ n) => JSON.parse(readFileSync(new URL(n, MAPS_DIR), 'utf8')));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/rule.js').RulesBundle} */
const BUNDLE = JSON.parse(readFileSync(new URL('../../generated/rules.json', import.meta.url), 'utf8'));
/** @type {GameMap} */
const JUNCTION = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));

/** @type {readonly LimitClass[]} */
const CLASSES = ['car', 'motorbike'];
/** Interior stations along each lane, as shares of its length. */
const STATIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

/**
 * A point at a share of a polyline's length.
 * @param {[number, number][]} line Polyline.
 * @param {number} share Share of the length.
 * @returns {[number, number]} Point.
 */
function pointAt(line, share) {
  const lens = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]));
  let left = share * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i += 1) {
    if (left <= lens[i] || i === lens.length - 1) {
      const f = lens[i] > 0 ? Math.min(1, left / lens[i]) : 0;
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f];
    }
    left -= lens[i];
  }
  return line[0];
}

/**
 * The limit the scorer applies to a vehicle of this class at a point of a lane.
 * @param {GameMap} map Map.
 * @param {string} laneId Lane.
 * @param {[number, number]} pos Point.
 * @param {LimitClass} legalClass Class.
 * @returns {number | null} Limit in km/h.
 */
function scorerLimit(map, laneId, pos, legalClass) {
  const env = /** @type {import('../../scoring/context.js').ScorerEnv} */ (/** @type {unknown} */ ({ map, bundle: BUNDLE, vehicle: { legalClass } }));
  const zones = zonesAt(map, pos, laneId);
  const builtUp = zones.some((z) => z.type === 'built-up');
  const loc = /** @type {import('../../map-query/index.js').Location} */ (/** @type {unknown} */ ({ laneId, junctionId: null }));
  return limitFor(env, loc, zones, builtUp)?.kmh ?? null;
}

describe('traffic speed limits', () => {
  // Traffic binds a sign zone to its whole lane while the scorer binds it inside its polygon, so
  // where no sign binds the point the traffic default must match the scorer, and a lane no sign
  // binds anywhere must match it in full.
  it('give every lane of every shipped map the default limit the scorer applies where no sign binds, for both classes', () => {
    expect(MAPS.length).toBeGreaterThan(0);
    /** @type {string[]} */
    const mismatches = [];
    let checked = 0;
    for (const map of MAPS) {
      const graph = buildLaneGraph(map, PARAMS.behaviour, undefined, PARAMS.speedDefaults);
      for (const road of map.roads) {
        for (const lane of road.lanes) {
          const edge = graph.edges[/** @type {number} */ (graph.edgeIndex.get(lane.id))];
          for (const cls of CLASSES) {
            for (const share of STATIONS) {
              const pos = pointAt(lane.centerline, share);
              const signedHere = zonesAt(map, pos, lane.id).some((z) => z.type === 'speed-limit');
              if (signedHere) continue;
              const want = scorerLimit(map, lane.id, pos, cls);
              const got = edge.limitKmh === null ? edgeLimitKmh(edge, cls) : edge.defaultKmh[cls];
              checked += 1;
              if (got !== want) mismatches.push(`${map.id} ${lane.id} ${cls} @${share}: traffic ${got}, scorer ${want}`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  it('resolve the statutory default on a built-up lane no sign binds, per class, and a sign over it', () => {
    const graph = buildLaneGraph(JUNCTION, PARAMS.behaviour, undefined, PARAMS.speedDefaults);
    const signed = new Set(JUNCTION.zones.filter((z) => z.type === 'speed-limit').flatMap((z) => z.laneIds));
    const builtUp = new Set(JUNCTION.zones.filter((z) => z.type === 'built-up').flatMap((z) => z.laneIds));
    const road = JUNCTION.roads.find((r) => r.lanes.some((l) => builtUp.has(l.id) && !signed.has(l.id)));
    const lane = road?.lanes.find((l) => builtUp.has(l.id) && !signed.has(l.id));
    expect(lane).toBeDefined();
    const edge = graph.edges[/** @type {number} */ (graph.edgeIndex.get(/** @type {{id: string}} */ (lane).id))];
    expect(edge.limitKmh).toBeNull();
    const multiLane = /** @type {import('../../contracts/map.js').Road} */ (road).divided || (/** @type {import('../../contracts/map.js').Road} */ (road).oneway && /** @type {import('../../contracts/map.js').Road} */ (road).lanes.length >= 2);
    for (const cls of CLASSES) {
      const row = PARAMS.speedDefaults.find((s) => s.legalClass === cls && s.builtUp && s.multiLane === multiLane);
      expect(edgeLimitKmh(edge, cls)).toBe(row?.maxKmh);
    }
    // A connector takes its approach lane's limit.
    const connector = graph.edges.find((e) => e.kind === 'connector' && e.fromEdge === edge.index);
    if (connector) for (const cls of CLASSES) expect(edgeLimitKmh(connector, cls)).toBe(edgeLimitKmh(edge, cls));
    // A sign binds over the default.
    edge.limitKmh = 30;
    for (const cls of CLASSES) expect(edgeLimitKmh(edge, cls)).toBe(30);
  });

  /** How long the lawful run lasts, seconds. */
  const LAWFUL_SECONDS = 120;
  it.each(MAPS.filter((m) => m.traffic).map((m) => /** @type {[string, GameMap]} */ ([m.id, m])))(
    'keep lawful drivers at or under the limit of their lane on %s',
    // Two minutes of traffic on osm-pasteur takes about 2 s alone, more under the full suite.
    { timeout: 120_000 },
    (_, map) => {
      const params = lawfulParams(PARAMS);
      const st = createTraffic(map, params, 3);
      // Limits from a graph built here, so a traffic state that lost its defaults still fails.
      const limits = buildLaneGraph(map, PARAMS.behaviour, undefined, PARAMS.speedDefaults);
      const ego = { pos: { ...map.route.start.pos }, heading: map.route.start.heading, speed: 0, lengthM: 4.5, widthM: 1.8 };
      /** @type {string[]} */
      const over = [];
      /** @type {string[]} */
      const flagged = [];
      let moving = 0;
      for (let i = 0; i < Math.round(LAWFUL_SECONDS / DT); i += 1) {
        const t = i * DT;
        const step = stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
        for (const p of step.poses) if (p.violations.includes('speeding')) flagged.push(`${p.id}@${t.toFixed(2)}`);
        for (let j = 0; j < st.activeCount; j += 1) {
          const k = st.active[j];
          if (st.wreck[k]) continue;
          const edge = limits.edges[st.edge[k]];
          const limit = edgeLimitKmh(edge, st.isMoto[k] === 1 ? 'motorbike' : 'car');
          if (st.v[k] > 0.5) moving += 1;
          if (limit !== null && st.v[k] > limit / 3.6) over.push(`${st.ids[k]} on ${edge.id} at ${(st.v[k] * 3.6).toFixed(1)} km/h, limit ${limit}, t ${t.toFixed(2)}`);
        }
      }
      expect(moving).toBeGreaterThan(0);
      expect(over.slice(0, 10)).toEqual([]);
      expect(flagged.slice(0, 10)).toEqual([]);
    },
  );
});
