/**
 * Spawning and despawning.
 *
 * - **Sources** (`map.traffic.sources`): each emits at its lane start at `ratePerH`, with intervals
 *   jittered uniformly by ±50% (mean exact), and only while it is more than `sourceMinEgoDistM`
 *   from the ego, so nobody appears in plain view. An emission blocked by the ego distance or the
 *   agent cap, one the despawn rules would remove within `SPAWN_LIFE_S` as the ego and the
 *   agent drive on (too far behind the ego, or outside the outer ring heading away), or one too
 *   long to fit before the lane's hold point, is skipped; one blocked only by
 *   a queue at the lane start waits for room.
 * - **Ring spawner**: twice a second, each road with a `densityPerKm` entry is topped up towards
 *   `densityPerKm × lane length inside the spawn ring`, at lane stations inside the ring and out of
 *   the ego's view cone where possible. Stations more than `despawnBehindM` behind the ego count
 *   neither as candidates nor towards the target, as an agent there would be despawned at once;
 *   nor, as candidates, do stations whose agent the despawn rules would remove within
 *   `SPAWN_LIFE_S` as the ego and the agent drive on.
 *   During the pre-roll the ring reaches the ego and the view cone is ignored, so the road is
 *   populated from the start.
 * - **Despawn**: an agent leaves at a sink lane end; it is removed when it is outside the outer
 *   ring and moving away from the ego, when it is more than `despawnBehindM` behind the ego, or
 *   when it has stopped at a dead end and is out of the ego's view cone.
 *
 * Each source and the ring spawner own a stream with a reserved index (`streamFor` indices from
 * 0xfffff000 up, far above any spawn index), so spawner draws never touch agent streams.
 */

import { angleDiff, footprint, headingOf, polygonsIntersect } from '../../geometry/index.js';
import { pick, range, streamFor, uniform } from '../random.js';
import { edgePoint } from './lane-graph.js';
import { queryGrid } from './grid.js';
import { edgeBaseSpeed, modelRows, spawnAgent } from './state.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('./perception.js').Obstacle} Obstacle */
/** @typedef {import('../random.js').RandomStream} RandomStream */
/** @typedef {import('../../contracts/telemetry.js').Vec2} Vec2 */

/** Stream index of the ring spawner. */
export const RING_STREAM_INDEX = 0xffffffff;
/** Stream index of source 0; source i uses `SOURCE_STREAM_BASE + i`. */
export const SOURCE_STREAM_BASE = 0xfffff000;
/** Ring spawner period in steps (0.5 s at 60 Hz, design). */
export const RING_TICK_STEPS = 30;
/** Spacing of ring spawner stations along a lane, metres (design). */
export const STATION_SPACING_M = 5;
/** Ring spawns tried per road per tick during the pre-roll (design). */
export const PREROLL_RING_ATTEMPTS = 3;
/** Speed below which an agent counts as stopped, m/s. */
export const STOPPED_MPS = 0.1;
/**
 * A spawn the despawn rules would remove within this time, as the ego and the agent drive on, is
 * not made, seconds (design).
 */
export const SPAWN_LIFE_S = 1;
/**
 * The ego may start or keep turning by up to this much within `SPAWN_LIFE_S` (a car through a
 * junction turn), radians (design).
 */
const EGO_TURN_RAD = 0.6;
/** Tightest turn radius assumed for the ego, so a slow or standing ego turns little, metres (design). */
const EGO_TURN_RADIUS_M = 6;
/**
 * A spawn stands up to this far from its station (a rider keeps right of the lane centre, and it
 * moves on in the step it is spawned), metres (design).
 */
const SPAWN_SLACK_M = 1;
/** A spawned agent starts at no more than this share of its desired speed. */
const SPAWN_SPEED_SHARE = 0.9;

/**
 * @typedef {object} SourceRuntime
 * @property {number} edge Lane edge.
 * @property {number} intervalS Mean interval, seconds.
 * @property {number} nextT Time of the pending emission.
 * @property {number} model Model index of the pending emission.
 * @property {RandomStream} rng Source stream.
 * @property {number} x Lane start x.
 * @property {number} z Lane start z.
 * @property {number} vMax Fastest spawn speed on the lane over the map mix, m/s.
 */

/**
 * @typedef {object} SpawnerState
 * @property {SourceRuntime[]} sources Sources in map order.
 * @property {RandomStream} ringRng Ring spawner stream.
 * @property {{edges: Int32Array, s: Float64Array, x: Float64Array, z: Float64Array, heading: Float64Array, vMax: Float64Array}[]} stations
 *   Ring stations per road, in map road order, with the lane heading and the fastest spawn speed
 *   of the map mix at each.
 * @property {number[]} density Agents per lane-km per road, 0 without an entry.
 * @property {Int32Array} roadOfEdge Road index of each lane edge, −1 for connectors.
 * @property {Int32Array} candidates Scratch station indices.
 */

/**
 * Ego as the spawner and despawner see it.
 * @typedef {object} EgoView
 * @property {number} x Centre x.
 * @property {number} z Centre z.
 * @property {number} heading Heading.
 * @property {Vec2[]} footprint Footprint.
 * @property {Vec2[]} spawnGuard Footprint inflated by `TrafficParams.spawnEgoMarginM`.
 * @property {number} [speed] Forward speed, m/s (0 when absent).
 * @property {number} [yawRate] Turn rate, rad/s, + to the left (0 when absent).
 */

/**
 * @param {TrafficState} st State.
 * @param {RandomStream} rng Stream.
 * @returns {number} Model index drawn from the map mix.
 */
function drawModel(st, rng) {
  return st.mixModel[pick(rng, st.mixShare)];
}

/**
 * Spawner state for a traffic state; draws each source's first emission.
 * @param {TrafficState} st State.
 * @param {number} t0 Time of the first step.
 * @returns {SpawnerState} Spawner.
 */
export function createSpawner(st, t0) {
  const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (st.map.traffic);
  const edges = st.graph.edges;
  const rows = [...new Set(st.mixModel)].map((m) => modelRows(st.params, st.modelKeys[m]));
  /** @type {(edge: import('./lane-graph.js').Edge) => number} */
  const vMaxOf = (edge) => rows.reduce((v, { model, cls }) => Math.max(v, SPAWN_SPEED_SHARE * edgeBaseSpeed(edge, cls, model.kind)), 0);
  const sources = traffic.sources.map((src, i) => {
    const edge = st.graph.edgeIndex.get(src.laneId);
    if (edge === undefined || edge >= st.graph.laneCount) throw new Error(`Traffic source names unknown lane ${src.laneId}`);
    const rng = streamFor(st.seed, st.map.id, SOURCE_STREAM_BASE + i);
    const intervalS = src.ratePerH > 0 ? 3600 / src.ratePerH : Infinity;
    const first = Number.isFinite(intervalS) ? t0 + range(rng, 0, intervalS) : Infinity;
    return { edge, intervalS, nextT: first, model: drawModel(st, rng), rng, x: edges[edge].xs[0], z: edges[edge].zs[0], vMax: vMaxOf(edges[edge]) };
  });
  const roadOfEdge = new Int32Array(edges.length).fill(-1);
  const stations = st.map.roads.map((road, r) => {
    /** @type {number[]} */ const es = [];
    /** @type {number[]} */ const ss = [];
    /** @type {number[]} */ const xs = [];
    /** @type {number[]} */ const zs = [];
    /** @type {number[]} */ const hs = [];
    /** @type {number[]} */ const vs = [];
    const p = { x: 0, z: 0, heading: 0 };
    for (const lane of road.lanes) {
      const e = /** @type {number} */ (st.graph.edgeIndex.get(lane.id));
      roadOfEdge[e] = r;
      const edge = edges[e];
      const vMax = vMaxOf(edge);
      for (let s = STATION_SPACING_M; s <= edge.length - STATION_SPACING_M; s += STATION_SPACING_M) {
        edgePoint(edge, s, p);
        es.push(e);
        ss.push(s);
        xs.push(p.x);
        zs.push(p.z);
        hs.push(p.heading);
        vs.push(vMax);
      }
    }
    return {
      edges: Int32Array.from(es),
      s: Float64Array.from(ss),
      x: Float64Array.from(xs),
      z: Float64Array.from(zs),
      heading: Float64Array.from(hs),
      vMax: Float64Array.from(vs),
    };
  });
  const maxStations = stations.reduce((m, s) => Math.max(m, s.s.length), 0);
  return {
    sources,
    ringRng: streamFor(st.seed, st.map.id, RING_STREAM_INDEX),
    stations,
    density: st.map.roads.map((r) => traffic.densityPerKm[r.id] ?? 0),
    roadOfEdge,
    candidates: new Int32Array(maxStations),
  };
}

/**
 * Whether `(x, z)` is inside the ego's view cone.
 * @param {EgoView} ego Ego.
 * @param {number} x X.
 * @param {number} z Z.
 * @param {Pick<import('../../contracts/traffic.js').TrafficParams, 'viewHalfAngleDeg' | 'viewRangeM'>} cone Cone size.
 * @returns {boolean} In view.
 */
export function inViewCone(ego, x, z, cone) {
  const dx = x - ego.x;
  const dz = z - ego.z;
  const d = Math.hypot(dx, dz);
  if (d > cone.viewRangeM) return false;
  if (d < 1e-6) return true;
  const cos = (dx * Math.cos(ego.heading) - dz * Math.sin(ego.heading)) / d;
  return cos >= Math.cos((cone.viewHalfAngleDeg * Math.PI) / 180);
}

/**
 * How far `(x, z)` lies ahead of the ego along its heading (negative behind).
 * @param {EgoView} ego Ego.
 * @param {number} x X.
 * @param {number} z Z.
 * @returns {number} Metres.
 */
function aheadOf(ego, x, z) {
  return (x - ego.x) * Math.cos(ego.heading) - (z - ego.z) * Math.sin(ego.heading);
}

/**
 * Whether the despawn rules would remove an agent spawned at `(x, z)`, heading `heading`, within
 * `SPAWN_LIFE_S`: it falls more than `despawnBehindM` behind the ego, or it is outside the outer
 * ring moving away. The ego drives on at its speed and may turn either way by up to `EGO_TURN_RAD`
 * (less when slow, as on its tightest turn), or more at its present turn rate; the agent stands
 * or moves at up to `vMax`. Any of those futures counts.
 * @param {EgoView} ego Ego.
 * @param {number} x X.
 * @param {number} z Z.
 * @param {number} heading Agent heading.
 * @param {number} vMax Fastest spawn speed there, m/s.
 * @param {number} behindM `despawnBehindM`.
 * @param {number} outer Outer ring radius.
 * @returns {boolean} Despawned at once.
 */
function doomed(ego, x, z, heading, vMax, behindM, outer) {
  const egoV = Math.max(0, ego.speed ?? 0);
  const turn = Math.max(Math.min(EGO_TURN_RAD, (egoV * SPAWN_LIFE_S) / EGO_TURN_RADIUS_M), Math.abs(ego.yawRate ?? 0) * SPAWN_LIFE_S);
  // The distance to the ego is convex in time and the way behind it linear (for one heading), so
  // checking now and at SPAWN_LIFE_S covers the time between.
  for (const tau of [0, SPAWN_LIFE_S]) {
    const ex = ego.x + Math.cos(ego.heading) * egoV * tau;
    const ez = ego.z - Math.sin(ego.heading) * egoV * tau;
    for (const v of tau === 0 ? [0] : [0, vMax]) {
      const ax = x + Math.cos(heading) * v * tau;
      const az = z - Math.sin(heading) * v * tau;
      const dist = Math.hypot(ax - ex, az - ez) + SPAWN_SLACK_M;
      // Behind, after a turn either way up to `turn`: worst where the agent comes nearest straight
      // behind.
      const rel = Math.min(Math.PI, Math.abs(angleDiff(ego.heading, headingOf(ax - ex, az - ez))) + (tau > 0 ? turn : 0));
      if (-dist * Math.cos(rel) > behindM) return true;
      const away = (ax - ex) * Math.cos(heading) - (az - ez) * Math.sin(heading) > 0;
      if (away && dist > outer) return true;
    }
  }
  return false;
}

/**
 * Tries to spawn a model at `s` on a lane edge; checks room along the lane, static obstacles on it,
 * footprints of agents, the ego and scripted actors, and starts at a speed the agent can brake from comfortably.
 * @param {TrafficState} st State.
 * @param {number} edge Lane edge.
 * @param {number} s Centre distance; raised so the rear is on the lane; the body must end before the hold point.
 * @param {number} modelIndex Model.
 * @param {EgoView} ego Ego.
 * @param {readonly Obstacle[]} scripted Scripted actor obstacles.
 * @param {number} firstNew Index into `st.active` of the first agent spawned this step.
 * @returns {number} Slot, or −1 when there is no room.
 */
export function trySpawn(st, edge, s, modelIndex, ego, scripted, firstNew) {
  if (st.freeCount === 0) return -1;
  const e = st.graph.edges[edge];
  const { model, cls } = modelRows(st.params, st.modelKeys[modelIndex]);
  const half = model.lengthM / 2;
  const sc = Math.max(half, s);
  if (sc + half > e.holdS) return -1;
  const clearM = st.params.spawnClearM;
  // Never on a stretch a static obstacle closes; stop before the next one.
  let blockAhead = Infinity;
  for (const b of e.blocks) {
    if (b.toS > sc - half - clearM && b.fromS < sc + half + cls.minGapM + clearM) return -1;
    if (b.fromS >= sc + half) blockAhead = Math.min(blockAhead, b.fromS - (sc + half));
  }
  // Neighbours along the lane.
  const list = st.edgeAgents[edge];
  const n = st.edgeCount[edge];
  let gapAhead = Infinity;
  for (let i = 0; i < n; i += 1) {
    const k = list[i];
    const kRear = st.s[k] - st.lengthM[k] / 2;
    const kFront = st.s[k] + st.lengthM[k] / 2;
    if (st.s[k] >= sc) {
      gapAhead = Math.min(gapAhead, kRear - (sc + half));
    } else {
      const gapBehind = sc - half - kFront;
      if (gapBehind < st.minGap[k] + st.v[k] * st.timeGap[k] + clearM) return -1;
    }
  }
  if (gapAhead < cls.minGapM + clearM) return -1;
  // Footprints.
  const p = { x: 0, z: 0, heading: 0 };
  edgePoint(e, sc, p);
  const lateral = model.kind === 'motorbike' ? -st.params.motorbike.keepRightOffsetM : 0;
  const lx = -Math.sin(p.heading);
  const lz = -Math.cos(p.heading);
  const pos = { x: p.x + lx * lateral, z: p.z + lz * lateral };
  const fp = footprint(pos, p.heading, model.lengthM, model.widthM);
  if (polygonsIntersect(fp, ego.spawnGuard)) return -1;
  for (const o of scripted) if (polygonsIntersect(fp, o.footprint)) return -1;
  const reach = Math.hypot(model.lengthM, model.widthM);
  const hit = (/** @type {number} */ k) =>
    polygonsIntersect(fp, footprint({ x: st.x[k], z: st.z[k] }, st.heading[k], st.lengthM[k] + clearM, st.widthM[k]));
  if (queryGrid(st.grid, pos.x, pos.z, reach + 6, (k) => st.alive[k] === 1 && hit(k))) return -1;
  for (let i = firstNew; i < st.activeCount; i += 1) if (hit(st.active[i])) return -1;
  // A speed it can stop from before the agent ahead and the hold point (the light may be red).
  const stopGap = Math.min(blockAhead, e.sink ? gapAhead : Math.min(gapAhead, e.holdS - (sc + half)));
  const v0 = edgeBaseSpeed(e, cls, model.kind);
  const speed = Math.min(v0 * SPAWN_SPEED_SHARE, Math.sqrt(Math.max(0, 2 * cls.comfortDecelMps2 * (stopGap - cls.minGapM))));
  return spawnAgent(st, edge, sc, speed, modelIndex);
}

/**
 * Runs the sources and the ring spawner for one step.
 * @param {TrafficState} st State.
 * @param {number} t Time.
 * @param {EgoView} ego Ego.
 * @param {readonly Obstacle[]} scripted Scripted actor obstacles.
 * @returns {void}
 */
export function runSpawner(st, t, ego, scripted) {
  const sp = st.spawner;
  const cap = st.capacity;
  const firstNew = st.activeCount;
  const [inner, outer] = /** @type {import('../../contracts/map.js').TrafficConfig} */ (st.map.traffic).spawnRingM;
  const behindM = st.params.despawnBehindM;
  for (let i = 0; i < sp.sources.length; i += 1) {
    const src = sp.sources[i];
    if (t < src.nextT) continue;
    const far = Math.hypot(src.x - ego.x, src.z - ego.z) > st.params.sourceMinEgoDistM;
    const lost = doomed(ego, src.x, src.z, st.graph.edges[src.edge].startHeading, src.vMax, behindM, outer);
    const { model } = modelRows(st.params, st.modelKeys[src.model]);
    // A vehicle longer than the stretch before the lane's hold point can never start there.
    const fits = model.lengthM <= st.graph.edges[src.edge].holdS;
    if (far && !lost && fits && st.activeCount < cap) {
      if (trySpawn(st, src.edge, model.lengthM / 2, src.model, ego, scripted, firstNew) < 0) continue;
      st.stats.sourceEmitted[i] += 1;
    }
    src.nextT += src.intervalS * range(src.rng, 0.5, 1.5);
    src.model = drawModel(st, src.rng);
  }

  if (st.tick % RING_TICK_STEPS !== 0) return;
  const lo = st.preRolling ? 0 : inner;
  const attempts = st.preRolling ? PREROLL_RING_ATTEMPTS : 1;
  for (let r = 0; r < sp.stations.length; r += 1) {
    const density = sp.density[r];
    if (!(density > 0)) continue;
    const stn = sp.stations[r];
    let inRing = 0;
    let outOfView = 0;
    const cand = sp.candidates;
    for (let i = 0; i < stn.s.length; i += 1) {
      const d = Math.hypot(stn.x[i] - ego.x, stn.z[i] - ego.z);
      if (d < lo || d > outer || -aheadOf(ego, stn.x[i], stn.z[i]) > behindM) continue;
      inRing += 1;
      if (doomed(ego, stn.x[i], stn.z[i], stn.heading[i], stn.vMax[i], behindM, outer)) continue;
      if (st.preRolling || !inViewCone(ego, stn.x[i], stn.z[i], st.params)) cand[outOfView++] = i;
    }
    if (inRing === 0) continue;
    // Without stations out of view, use all of the ring.
    let nCand = outOfView;
    if (nCand === 0) {
      for (let i = 0; i < stn.s.length; i += 1) {
        const d = Math.hypot(stn.x[i] - ego.x, stn.z[i] - ego.z);
        if (d < lo || d > outer || doomed(ego, stn.x[i], stn.z[i], stn.heading[i], stn.vMax[i], behindM, outer)) continue;
        cand[nCand++] = i;
      }
    }
    if (nCand === 0) continue;
    const target = (density * inRing * STATION_SPACING_M) / 1000;
    let present = 0;
    for (let i = 0; i < st.activeCount; i += 1) {
      const k = st.active[i];
      if (sp.roadOfEdge[st.edge[k]] !== r) continue;
      if (Math.hypot(st.x[k] - ego.x, st.z[k] - ego.z) <= outer) present += 1;
    }
    for (let a = 0; a < attempts && present + 1 <= target + 0.5 && st.activeCount < cap; a += 1) {
      const i = cand[Math.min(nCand - 1, Math.floor(uniform(sp.ringRng) * nCand))];
      const model = drawModel(st, sp.ringRng);
      if (trySpawn(st, stn.edges[i], stn.s[i], model, ego, scripted, firstNew) >= 0) {
        st.stats.ringSpawned += 1;
        present += 1;
      }
    }
  }
}
