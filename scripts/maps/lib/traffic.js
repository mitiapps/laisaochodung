/**
 * Per-map traffic block (`GameMap.traffic`) from the `traffic` key of a map's `source.yaml` and
 * the built lane graph, and the time limit of a map with traffic.
 *
 * Source format (every key but the three first is optional):
 *
 * ```yaml
 * traffic:
 *   densityPerKm: 30        # agents per lane-kilometre on every road (design)
 *   spawnRingM: [60, 150]   # inner and outer ring spawner radius around the ego
 *   mix: [{ model: motorbike, share: 0.75 }, ...]   # shares sum to 1
 *   seed: 123               # map seed; default: a hash of the map id
 *   roadDensityPerKm: { <road id>: 10 }             # per-road density overrides
 *   sourceRatePerH: { <lane id>: 0 }                # per-source rate overrides
 * ```
 *
 * Driver and vehicle parameters never come here: they live in `data/traffic/params.yaml`.
 */

import { angleDiff, distance, headingOf, polylineLength, projectOntoPolyline } from '../../../src/geometry/index.js';
import { LANE_WIDTH_M } from './lanes.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/map.js').TrafficConfig} TrafficConfig */
/** @typedef {import('./connectors.js').LaneGraph} LaneGraph */
/** @typedef {import('./source.js').SourceYaml} SourceYaml */

/**
 * Free speed of traffic entering at a source, km/h: a source emits `densityPerKm × this` agents
 * per hour, the flow of its lane at that density (`paramBasis: design`).
 */
export const SOURCE_FREE_SPEED_KMH = 25;
/** Spacing of the ego positions along the route at which the ring population is measured (m). */
export const RING_SAMPLE_STEP_M = 10;
/**
 * Mean speed of a legal driver along a route in traffic, km/h (`paramBasis: design`; inner-city
 * HCMC peak traffic, to be confirmed by the phase 9 autopilot).
 */
export const TRAFFIC_MEAN_SPEED_KMH = 15;
/** Wait added per unsignalled junction on the route, s (`paramBasis: design`). */
export const UNSIGNALLED_WAIT_S = 10;
/** Margin factor on the traffic time estimate (`paramBasis: design`). */
export const TIME_MARGIN = 1.25;
/** Time limits round up to a multiple of this, s. */
export const TIME_STEP_S = 10;

/**
 * Parsed `traffic` key of a source file.
 * @typedef {object} TrafficSource
 * @property {number} densityPerKm Default agents per lane-kilometre.
 * @property {[number, number]} spawnRingM Ring spawner radii.
 * @property {{model: string, share: number}[]} mix Model shares.
 * @property {number | null} seed Map seed, or null for the id hash.
 * @property {Record<string, number>} roadDensityPerKm Per-road density overrides.
 * @property {Record<string, number>} sourceRatePerH Per-source rate overrides.
 */

/**
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @param {{min?: number, max?: number, integer?: boolean}} [o] Bounds.
 * @returns {number} Number.
 */
function num(v, where, o = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: expected a number`);
  if (o.integer && !Number.isInteger(v)) throw new Error(`${where}: expected an integer`);
  if (o.min !== undefined && v < o.min) throw new Error(`${where}: must be ≥ ${o.min}`);
  if (o.max !== undefined && v > o.max) throw new Error(`${where}: must be ≤ ${o.max}`);
  return v;
}

/**
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @returns {Record<string, number>} Mapping of non-negative numbers.
 */
function numberMap(v, where) {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: expected a mapping`);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = num(x, `${where}.${k}`, { min: 0 });
  return out;
}

/**
 * Validates the `traffic` key of a source file.
 * @param {SourceYaml} raw Value of the key.
 * @param {string} where File name for messages.
 * @returns {TrafficSource} Parsed block.
 */
export function parseTrafficSource(raw, where) {
  const w = `${where} traffic`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${w}: expected a mapping`);
  const known = ['densityPerKm', 'spawnRingM', 'mix', 'seed', 'roadDensityPerKm', 'sourceRatePerH'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) throw new Error(`${w}: unknown key ${k}`);
  if (!Array.isArray(raw.spawnRingM) || raw.spawnRingM.length !== 2) throw new Error(`${w}.spawnRingM: expected [inner, outer]`);
  const inner = num(raw.spawnRingM[0], `${w}.spawnRingM[0]`, { min: 0 });
  const outer = num(raw.spawnRingM[1], `${w}.spawnRingM[1]`, { min: 0 });
  if (outer <= inner) throw new Error(`${w}.spawnRingM: the outer radius must exceed the inner one`);
  if (!Array.isArray(raw.mix) || raw.mix.length === 0) throw new Error(`${w}.mix: expected a non-empty list`);
  const mix = raw.mix.map((/** @type {SourceYaml} */ e, /** @type {number} */ i) => {
    if (typeof e?.model !== 'string' || e.model.length === 0) throw new Error(`${w}.mix[${i}].model: expected a model key`);
    return { model: e.model, share: num(e.share, `${w}.mix[${i}].share`, { min: 0, max: 1 }) };
  });
  const sum = mix.reduce((/** @type {number} */ s, /** @type {{share: number}} */ e) => s + e.share, 0);
  if (Math.abs(sum - 1) > 1e-6) throw new Error(`${w}.mix: shares sum to ${sum}, expected 1`);
  return {
    densityPerKm: num(raw.densityPerKm, `${w}.densityPerKm`, { min: 0 }),
    spawnRingM: [inner, outer],
    mix,
    seed: raw.seed === undefined ? null : num(raw.seed, `${w}.seed`, { integer: true, min: 0, max: 0xffffffff }),
    roadDensityPerKm: numberMap(raw.roadDensityPerKm, `${w}.roadDensityPerKm`),
    sourceRatePerH: numberMap(raw.sourceRatePerH, `${w}.sourceRatePerH`),
  };
}

/**
 * 32-bit FNV-1a hash of a string (UTF-16 code units), the default map seed.
 * @param {string} s String.
 * @returns {number} Unsigned 32-bit hash.
 */
export function mapSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Length of a polyline inside a disc.
 * @param {Vec2[]} line Polyline.
 * @param {Vec2} c Disc centre.
 * @param {number} r Radius.
 * @returns {number} Length inside.
 */
export function lengthInDisc(line, c, r) {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [ax, az] = line[i - 1];
    const dx = line[i][0] - ax;
    const dz = line[i][1] - az;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) continue;
    // |a + t·d − c|² = r² for t in [0, 1].
    const fx = ax - c[0];
    const fz = az - c[1];
    const b = 2 * (fx * dx + fz * dz);
    const q = fx * fx + fz * fz - r * r;
    const disc = b * b - 4 * len2 * q;
    if (disc <= 0) continue;
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, (-b - sq) / (2 * len2));
    const t1 = Math.min(1, (-b + sq) / (2 * len2));
    if (t1 > t0) total += (t1 - t0) * Math.sqrt(len2);
  }
  return total;
}

/**
 * Points every `step` metres along the route legs (start, checkpoints, finish centre).
 * @param {GameMap} map Map.
 * @param {number} step Spacing.
 * @returns {Vec2[]} Ego positions.
 */
function routeSamples(map, step) {
  const f = map.route.finish.polygon;
  /** @type {Vec2[]} */
  const pts = [map.route.start.pos, ...map.route.checkpoints.map((c) => c.pos)].map((p) => [p.x, p.z]);
  pts.push([f.reduce((s, p) => s + p[0], 0) / f.length, f.reduce((s, p) => s + p[1], 0) / f.length]);
  /** @type {Vec2[]} */
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) {
    const d = distance(pts[i - 1], pts[i]);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k += 1) {
      const t = k / n;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
    }
  }
  return out;
}

/**
 * Most agents the ring spawner can hold at once (K5): over ego positions along the route, the
 * largest sum of `densityPerKm(road) × lane length within the outer ring radius`, rounded up.
 * @param {GameMap} map Map.
 * @param {Record<string, number>} densityPerKm Density per road id.
 * @param {number} outerM Outer ring radius.
 * @returns {number} Agent cap.
 */
export function maxAgentsFor(map, densityPerKm, outerM) {
  let best = 0;
  for (const p of routeSamples(map, RING_SAMPLE_STEP_M)) {
    let sum = 0;
    for (const road of map.roads) {
      const k = densityPerKm[road.id] ?? 0;
      if (k === 0) continue;
      for (const lane of road.lanes) sum += (k * lengthInDisc(lane.centerline, p, outerM)) / 1000;
    }
    best = Math.max(best, sum);
  }
  return Math.ceil(best - 1e-9);
}

/**
 * Lane under a route point, travelling within 60° of `heading`.
 * @param {GameMap} map Map.
 * @param {Vec2} p Point.
 * @param {number} heading Travel heading.
 * @param {string} what Point name for messages.
 * @returns {{roadId: string, laneId: string, dir: string, s: number, lengthM: number}} Lane and position.
 */
function locateRoutePoint(map, p, heading, what) {
  let best = null;
  let bestD = LANE_WIDTH_M / 2 + 0.05;
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const pr = projectOntoPolyline(p, lane.centerline);
      if (pr.distance > bestD || Math.abs(angleDiff(pr.heading, heading)) > Math.PI / 3) continue;
      bestD = pr.distance;
      best = { roadId: road.id, laneId: lane.id, dir: lane.dir, s: pr.s, lengthM: polylineLength(lane.centerline) };
    }
  }
  if (!best) throw new Error(`${map.id}: the route ${what} lies on no lane`);
  return best;
}

/**
 * The route through the lane graph: legs from the start through every checkpoint to the finish
 * centre, each the shortest drive over lanes (lane changes within a direction are free), junction
 * connectors and plain joins.
 * @param {GameMap} map Map.
 * @param {LaneGraph} graph Lane graph.
 * @returns {{lengthM: number, connectorIds: string[]}} Driven length and connectors used.
 */
export function routeThroughGraph(map, graph) {
  /** @type {Map<string, string>} lane id → road:dir */
  const groupOf = new Map();
  /** @type {Map<string, number>} road:dir → length */
  const groupLen = new Map();
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const g = `${road.id}:${lane.dir}`;
      groupOf.set(lane.id, g);
      if (lane.index === 0) groupLen.set(g, polylineLength(lane.centerline));
    }
  }
  /** @type {Array<{from: string, to: string, lengthM: number, connectorId: string | null}>} */
  const edges = [
    ...graph.connectors.map((c) => ({
      from: /** @type {string} */ (groupOf.get(c.fromLaneId)),
      to: /** @type {string} */ (groupOf.get(c.toLaneId)),
      lengthM: polylineLength(c.centerline),
      connectorId: c.id,
    })),
    ...graph.joins.map((j) => ({
      from: /** @type {string} */ (groupOf.get(j.fromLaneId)),
      to: /** @type {string} */ (groupOf.get(j.toLaneId)),
      lengthM: 0,
      connectorId: null,
    })),
  ];

  const f = map.route.finish.polygon;
  /** @type {Array<{p: Vec2, heading: number | null, what: string}>} */
  const marks = [
    { p: [map.route.start.pos.x, map.route.start.pos.z], heading: map.route.start.heading, what: 'start' },
    ...map.route.checkpoints.map((c, i) => ({ p: /** @type {Vec2} */ ([c.pos.x, c.pos.z]), heading: c.heading, what: `checkpoint ${i}` })),
    { p: [f.reduce((s, q) => s + q[0], 0) / f.length, f.reduce((s, q) => s + q[1], 0) / f.length], heading: null, what: 'finish' },
  ];
  const located = marks.map((m, i) => {
    const prev = marks[i - 1];
    const heading = m.heading ?? headingOf(m.p[0] - prev.p[0], m.p[1] - prev.p[1]);
    return locateRoutePoint(map, m.p, heading, m.what);
  });

  let lengthM = 0;
  /** @type {string[]} */
  const connectorIds = [];
  for (let i = 1; i < located.length; i += 1) {
    const a = located[i - 1];
    const b = located[i];
    const ga = `${a.roadId}:${a.dir}`;
    const gb = `${b.roadId}:${b.dir}`;
    if (ga === gb && b.s >= a.s - 1) {
      lengthM += Math.max(0, b.s - a.s);
      continue;
    }
    // Dijkstra over road directions; `dist` is measured to the start of each direction.
    /** @type {Map<string, {d: number, via: string | null, prev: string | null}>} */
    const dist = new Map();
    /** @type {Set<string>} */
    const done = new Set();
    for (const e of edges) {
      if (e.from !== ga) continue;
      const d = a.lengthM - a.s + e.lengthM;
      if (d < (dist.get(e.to)?.d ?? Infinity)) dist.set(e.to, { d, via: e.connectorId, prev: null });
    }
    for (;;) {
      let cur = null;
      for (const [g, v] of dist) if (!done.has(g) && (cur === null || v.d < /** @type {{d: number}} */ (dist.get(cur)).d)) cur = g;
      if (cur === null || cur === gb) break;
      done.add(cur);
      const base = /** @type {{d: number}} */ (dist.get(cur)).d + (groupLen.get(cur) ?? 0);
      for (const e of edges) {
        if (e.from !== cur) continue;
        const d = base + e.lengthM;
        if (d < (dist.get(e.to)?.d ?? Infinity)) dist.set(e.to, { d, via: e.connectorId, prev: cur });
      }
    }
    const end = dist.get(gb);
    if (!end) throw new Error(`${map.id}: the lane graph has no path from the route ${marks[i - 1].what} to the ${marks[i].what}`);
    lengthM += end.d + b.s;
    /** @type {string[]} */
    const leg = [];
    /** @type {string | null} */
    let g = gb;
    while (g !== null) {
      const v = /** @type {{via: string | null, prev: string | null}} */ (dist.get(g));
      if (v.via) leg.push(v.via);
      g = v.prev;
    }
    connectorIds.push(...leg.reverse());
  }
  return { lengthM, connectorIds };
}

/**
 * Time limit of a map with traffic (K5, `paramBasis: design`), never below the authored one:
 *
 *   T = ⌈ TIME_MARGIN · (L / v + Σ signalled cycle + n_unsignalled · UNSIGNALLED_WAIT_S) ⌉₁₀
 *
 * with `L` the route driven through the lane graph, `v = TRAFFIC_MEAN_SPEED_KMH`, a full light
 * cycle (green + yellow + red) for every signalled approach on the route, a fixed wait for every
 * other junction crossed, and ⌈⌉₁₀ rounding up to `TIME_STEP_S`.
 * @param {GameMap} map Map.
 * @param {LaneGraph} graph Lane graph.
 * @returns {{timeLimitS: number, formulaS: number, routeM: number}} Limit, the formula value and `L`.
 */
export function trafficTimeLimit(map, graph) {
  const { lengthM, connectorIds } = routeThroughGraph(map, graph);
  const byId = new Map(graph.connectors.map((c) => [c.id, c]));
  let waits = 0;
  for (const id of connectorIds) {
    const c = /** @type {import('../../../src/contracts/map.js').Connector} */ (byId.get(id));
    const stop = map.stopLines.find((sl) => sl.id === c.stopLineId);
    const signal = stop?.control === 'signal' ? map.signals.find((s) => s.id === stop.signalId) : undefined;
    waits += signal ? signal.cycle.green + signal.cycle.yellow + signal.cycle.red : UNSIGNALLED_WAIT_S;
  }
  const raw = TIME_MARGIN * (lengthM / (TRAFFIC_MEAN_SPEED_KMH / 3.6) + waits);
  const formulaS = Math.ceil(raw / TIME_STEP_S - 1e-9) * TIME_STEP_S;
  return { timeLimitS: Math.max(map.route.timeLimitS, formulaS), formulaS, routeM: lengthM };
}

/**
 * Traffic block of a map: density on every road, sources at every lane start on the map boundary
 * and sinks at every lane end there, the derived `maxAgents`, and the seed.
 * @param {GameMap} map Map.
 * @param {TrafficSource} src Parsed source block.
 * @param {LaneGraph} graph Lane graph.
 * @returns {TrafficConfig} Traffic block.
 */
export function trafficConfig(map, src, graph) {
  const roadIds = new Set(map.roads.map((r) => r.id));
  for (const id of Object.keys(src.roadDensityPerKm)) {
    if (!roadIds.has(id)) throw new Error(`${map.id}: traffic.roadDensityPerKm names unknown road ${id}`);
  }
  /** @type {Record<string, number>} */
  const densityPerKm = {};
  for (const road of map.roads) densityPerKm[road.id] = src.roadDensityPerKm[road.id] ?? src.densityPerKm;
  const roadOfLane = new Map(map.roads.flatMap((r) => r.lanes.map((l) => [l.id, r.id])));
  const sourceLanes = [...graph.starts].filter(([, e]) => e.kind === 'boundary').map(([id]) => id).sort();
  for (const id of Object.keys(src.sourceRatePerH)) {
    if (!sourceLanes.includes(id)) throw new Error(`${map.id}: traffic.sourceRatePerH names ${id}, which is not a source lane`);
  }
  const sources = sourceLanes.map((laneId) => ({
    laneId,
    ratePerH: src.sourceRatePerH[laneId] ?? Math.round(densityPerKm[/** @type {string} */ (roadOfLane.get(laneId))] * SOURCE_FREE_SPEED_KMH),
  }));
  const sinks = [...graph.ends].filter(([, e]) => e.kind === 'boundary').map(([id]) => id).sort();
  return {
    seed: src.seed ?? mapSeed(map.id),
    maxAgents: maxAgentsFor(map, densityPerKm, src.spawnRingM[1]),
    spawnRingM: src.spawnRingM,
    densityPerKm,
    sources,
    sinks,
    mix: src.mix,
  };
}
