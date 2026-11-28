/**
 * Traffic state: structure-of-arrays agent slots with a free list, per-edge agent lists ordered by
 * distance along the edge, and the per-agent setup draws.
 *
 * Determinism: every agent owns the stream `streamFor(seed, map.id, spawnIndex)` and
 * draws its setup in a fixed order at spawn (personality, desired-speed factor, variant, route
 * seed); later draws come after these, so they never shift. Active slots are kept in ascending spawn index, and
 * every loop runs in that order.
 */

import { PERSONALITIES } from '../../contracts/traffic.js';
import { createStream, hash32, nextUint32, pick, range, streamFor, uniform } from '../random.js';
import { normalizeAngle, projectOntoPolyline } from '../../geometry/index.js';
import { buildLaneGraph, edgeLimitKmh, edgePoint } from './lane-graph.js';
import { createGrid } from './grid.js';
import { RING_STEPS, drawHumanFactors } from './human-factors.js';
import { FLAG_COUNT, clearFlags } from './violations.js';
import { DT } from '../../contracts/units.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/traffic.js').TrafficParams} TrafficParams */
/** @typedef {import('../../contracts/traffic.js').ModelParams} ModelParams */
/** @typedef {import('../../contracts/traffic.js').ClassParams} ClassParams */
/** @typedef {import('./lane-graph.js').LaneGraph} LaneGraph */
/** @typedef {import('./grid.js').Grid} Grid */

/** Despawn reasons counted in `TrafficStats.despawned`. */
export const DESPAWN_REASONS = Object.freeze(['sink', 'edge-held', 'ring', 'behind', 'dead-end', 'reset', 'wreck', 'stuck']);
/**
 * Why an agent left: `sink` it drove off the map, `edge-held` it stood held up at a map exit,
 * `stuck` a body in its way held it past the last-resort limit; the rest as named.
 * @typedef {'sink' | 'edge-held' | 'ring' | 'behind' | 'dead-end' | 'reset' | 'wreck' | 'stuck'} DespawnReason
 */

/**
 * @typedef {object} TrafficStats
 * @property {number} spawned Agents spawned so far, the next spawn index.
 * @property {number[]} sourceEmitted Agents emitted per `map.traffic.sources` entry.
 * @property {number} ringSpawned Agents placed by the ring spawner.
 * @property {Record<DespawnReason, number>} despawned Agents removed, by reason.
 */

/**
 * Traffic of one run. Mutable: `stepTraffic` advances it in place.
 * @typedef {object} TrafficState
 * @property {GameMap} map Map.
 * @property {TrafficParams} params Compiled traffic parameters.
 * @property {LaneGraph} graph Lane graph.
 * @property {number} seed Effective seed: the run seed mixed with the map seed.
 * @property {string[]} modelKeys Model keys of `params.models`, in key order.
 * @property {number[]} mixModel Model index of each `map.traffic.mix` entry.
 * @property {number[]} mixShare Share of each `map.traffic.mix` entry.
 * @property {number} capacity Slot count (`map.traffic.maxAgents`).
 * @property {number} t Run time of the state.
 * @property {number} tick Steps taken since creation, the pre-roll included.
 * @property {boolean} preRolling True while `createTraffic` pre-rolls.
 * @property {Uint8Array} alive Slot holds an agent.
 * @property {Float64Array} spawnIndex Spawn index by slot.
 * @property {string[]} ids Pose id by slot.
 * @property {Int32Array} model Model index by slot.
 * @property {Int32Array} personality Personality index by slot.
 * @property {Int32Array} variant Variant by slot.
 * @property {Int32Array} edge Edge by slot.
 * @property {Float64Array} s Centre distance along the edge.
 * @property {Float64Array} v Speed.
 * @property {Float64Array} acc Acceleration of the last step.
 * @property {Float64Array} x Pose x (after the last step).
 * @property {Float64Array} z Pose z.
 * @property {Float64Array} heading Pose heading.
 * @property {Float64Array} lateral Offset left of the centreline (negative: right).
 * @property {Float64Array} lateralBase Offset the agent keeps in its lane: keep right for
 *   motorbikes, 0 for cars.
 * @property {Float64Array} latRate Lateral speed of the last step, m/s (left positive), while the
 *   agent moves across after a lane change.
 * @property {Int32Array} nextEdge Next edge on the route, −1 at a sink or dead end.
 * @property {Uint32Array} routeSeed Route seed by slot.
 * @property {Int32Array} turnsTaken Route choices made so far.
 * @property {Float64Array} v0Factor Desired speed as a share of the edge's base speed.
 * @property {Float64Array} timeGap IDM T.
 * @property {Float64Array} minGap IDM s0.
 * @property {Float64Array} accelMax IDM a.
 * @property {Float64Array} decelComfort IDM b.
 * @property {Float64Array} delta IDM δ.
 * @property {Float64Array} decelMax Braking limit, rain included.
 * @property {Float64Array} criticalGap Gap-acceptance critical gap.
 * @property {Float64Array} yellowStop Yellow-stop deceleration `b_stop`.
 * @property {Float64Array} lengthM Body length.
 * @property {Float64Array} widthM Body width.
 * @property {Float64Array} baseV0 Desired speed on the current edge before `v0Factor`, by slot.
 * @property {Uint8Array} wreck Slot is a wreck.
 * @property {Float64Array} wreckT Time it became one.
 * @property {Int32Array} claim Connector the agent holds a claim on, or −1.
 * @property {Float64Array} waitS Time spent waiting at the hold point.
 * @property {Uint8Array} haltedAtLine Stopped at a stop sign this approach.
 * @property {Int8Array} signalCommit 0 undecided, 1 stop, 2 go, for the current approach.
 * @property {Uint32Array} rngState Agent stream state after its setup draws.
 * @property {Float64Array} classCriticalGap Class critical gap before the personality factor.
 * @property {Uint8Array} held Stood at its hold point last step unable to claim: `HELD_EXIT` (exit
 *   lane full) or `HELD_BLOCKED` (blocked ahead), 0 otherwise; others do not wait for it, except
 *   at a merge, where a head held for exit room keeps its turn.
 * @property {Uint8Array} flagNow Violation conditions raised this step (bits of `FLAG`).
 * @property {Float64Array} flagUntil Time until which each flag stays latched, `FLAG_COUNT` per slot.
 * @property {Int32Array} redConn Connector entered on red, while the agent is on it, or −1.
 * @property {Int32Array} noYieldConn Connector entered inside another party's critical gap, while
 *   the agent still covers its conflict zones, or −1.
 * @property {Float64Array} frozenS Time the agent has been held by a body in its way.
 * @property {Int32Array} heldBy Slot of the agent whose body held this one's move last step, or −1.
 * @property {Float64Array} makeRoomUntil A rider that edged aside for one held by its body keeps
 *   that place, making no slot choice, until this time; −Infinity otherwise.
 * @property {Uint8Array} heedless The driver is forcing its way (a red run, a short gap taken by
 *   choice, a cut-in) and does not stop for what it sees until that is over.
 * @property {Uint8Array} unsafeChange Moving across after a lane change that skipped its safety check.
 * @property {Uint32Array} decisionSeed Seed of the agent's rule-breaking draws.
 * @property {Int32Array} decisions Rule-breaking draws made so far.
 * @property {Uint8Array} speeding The agent drew a desired speed above the limit.
 * @property {Uint8Array} noSignal The agent gives no signal for its next turn.
 * @property {Uint8Array} crossing Moving across to another lane (not a motorbike slot move).
 * @property {Int8Array} intent Lane change the agent signals: −1 right, 1 left, 0 none.
 * @property {Int32Array} intentLane Target lane of that change, or −1.
 * @property {Float64Array} intentT Time the agent began to signal it.
 * @property {Uint8Array} intentQuiet The agent gives no signal for that change.
 * @property {Uint8Array} intentCutIn A car's discretionary change that skips the safety check.
 * @property {Int8Array} intentKind What the signalled change is for (`lane-change.js` intent kinds), 0 none.
 * @property {Uint8Array} approachDraws Rule-breaking draws already made on this approach (bits).
 * @property {Float64Array} tailgateGap Class time gap below which the agent tailgates.
 * @property {Int32Array} reactionSteps Reaction delay, steps.
 * @property {Float64Array} ring Perceived-input ring buffer, `RING_STEPS` pairs per slot.
 * @property {Int32Array} ringPos Next ring position per slot.
 * @property {Uint8Array} ringFresh The ring refills with the truth at the next step.
 * @property {Float64Array} ouGap Gap error process.
 * @property {Float64Array} ouRate Approach-rate error process.
 * @property {number} ouDecay `e^(−DT/τ)` of the error processes.
 * @property {Uint32Array} noiseState Per-step noise stream state.
 * @property {Uint8Array} distractProne The agent has distraction episodes.
 * @property {Float64Array} distractUntil End of the current distraction episode.
 * @property {Float64Array} nextDistract Start of the next one.
 * @property {Float64Array} seenGap Perceived gap of the last step.
 * @property {Float64Array} seenV Perceived leader speed of the last step.
 * @property {Float64Array} heldGap Perceived gap held through a distraction episode.
 * @property {Float64Array} heldV Perceived leader speed held through it.
 * @property {Uint8Array} isMoto The agent is a motorbike.
 * @property {number} egoSignalEpisode Count of times the ego has switched an indicator on.
 * @property {number} egoStillS Time the ego has stood still, seconds.
 * @property {number} egoHeadingBefore The ego's heading last step, NaN before the first step or
 *   after a reset.
 * @property {string} egoIndicator The ego's indicator state last step.
 * @property {Float64Array} halfWidth Half width of each lane edge (connectors: of the approach lane).
 * @property {Int32Array} laneIndexOf Map lane index of each lane edge (0 at the right kerb), −1 for connectors.
 * @property {Uint8Array} openSides Sides of each lane edge with a lane of the same direction
 *   beyond its line (`SIDE_LEFT`, `SIDE_RIGHT` bits); a rider may ride on that line.
 * @property {Int32Array} active Active slots in ascending spawn index.
 * @property {number} activeCount Active slots.
 * @property {Int32Array} free Free slots (a stack).
 * @property {number} freeCount Free slots.
 * @property {Map<number, number>} slotBySpawn Slot by spawn index (lookups only, never iterated).
 * @property {Int32Array[]} edgeAgents Slots on each edge, ascending `s`.
 * @property {Int32Array} edgeCount Agents on each edge.
 * @property {Int32Array[]} claimants Slots holding a claim on each edge (connectors only).
 * @property {Int32Array} claimCount Claimants per edge.
 * @property {Grid} grid Grid over agent centres.
 * @property {import('./spawner.js').SpawnerState} spawner Source timers and ring stations.
 * @property {TrafficStats} stats Counters.
 */

/**
 * Per-class IDM row of every model, by model index.
 * @param {TrafficParams} params Params.
 * @param {string} key Model key.
 * @returns {{model: ModelParams, cls: ClassParams}} Rows.
 */
export function modelRows(params, key) {
  const model = params.models[key];
  if (!model) throw new Error(`Unknown traffic model ${key}`);
  return { model, cls: params.classes[model.class] };
}

/**
 * Desired speed on an edge before the agent's factor: the class share of the limit in force for
 * the model's legal class, else the class desired speed; capped by the turn speed of a connector.
 * @param {import('./lane-graph.js').Edge} edge Edge.
 * @param {ClassParams} cls Class row.
 * @param {ModelParams['kind']} kind Model kind, which is its legal class.
 * @returns {number} m/s.
 */
export function edgeBaseSpeed(edge, cls, kind) {
  const limit = edgeLimitKmh(edge, kind);
  const base = limit !== null ? (limit / 3.6) * cls.v0LimitFactor : cls.v0Kmh / 3.6;
  return Math.min(base, edge.turnSpeedMps);
}

/**
 * Junction-shaping sizes of a map's mix (see `buildLaneGraph`).
 * @param {GameMap} map Map with a traffic block.
 * @param {TrafficParams} params Params.
 * @returns {import('./lane-graph.js').SweepOptions} Sizes.
 */
export function sweepOptions(map, params) {
  const models = (map.traffic?.mix ?? []).map((m) => modelRows(params, m.model).model);
  const longest = models.reduce((a, m) => (a === null || m.lengthM > a.lengthM ? m : a), /** @type {ModelParams | null} */ (null));
  const longM = params.behaviour.longVehicleM;
  const short = models.filter((m) => m.lengthM <= longM);
  const offset = params.motorbike.keepRightOffsetM;
  return {
    longVehicle: longest && longest.lengthM > longM ? { lengthM: longest.lengthM, widthM: longest.widthM } : null,
    waitHalfWidthM: short.reduce((h, m) => Math.max(h, m.widthM / 2 + (m.kind === 'motorbike' ? offset : 0)), 0),
    waitLengthM: short.reduce((l, m) => Math.max(l, m.lengthM), 0),
  };
}

/** Lane half width assumed where a lane polygon gives none, metres (design: a 3.5 m lane). */
export const DEFAULT_HALF_WIDTH_M = 1.75;

/**
 * Half width of every edge: a lane's from its polygon (the mean distance of its vertices from the
 * centreline), a connector's from its approach lane.
 * @param {GameMap} map Map.
 * @param {LaneGraph} graph Lane graph.
 * @returns {Float64Array} Half widths by edge index.
 */
export function laneHalfWidths(map, graph) {
  const out = new Float64Array(graph.edges.length).fill(DEFAULT_HALF_WIDTH_M);
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const i = graph.edgeIndex.get(lane.id);
      if (i === undefined || lane.polygon.length < 3) continue;
      let sum = 0;
      for (const p of lane.polygon) sum += projectOntoPolyline(p, lane.centerline).distance;
      const h = sum / lane.polygon.length;
      if (h > 0.5) out[i] = h;
    }
  }
  for (const e of graph.edges) if (e.kind === 'connector') out[e.index] = out[e.fromEdge];
  return out;
}

/** `openSides` bits. */
export const SIDE_LEFT = 1;
export const SIDE_RIGHT = 2;

/**
 * Sides of every lane edge that border a lane of the same road and direction (lane index 0 lies
 * at the right kerb). Connectors take none.
 * @param {GameMap} map Map.
 * @param {LaneGraph} graph Lane graph.
 * @returns {Uint8Array} Bits by edge index.
 */
export function laneOpenSides(map, graph) {
  const out = new Uint8Array(graph.edges.length);
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const i = graph.edgeIndex.get(lane.id);
      if (i === undefined) continue;
      const same = road.lanes.filter((l) => l.dir === lane.dir);
      if (same.some((l) => l.index === lane.index + 1)) out[i] |= SIDE_LEFT;
      if (same.some((l) => l.index === lane.index - 1)) out[i] |= SIDE_RIGHT;
    }
  }
  return out;
}

/**
 * Map lane index of every lane edge, −1 for connectors.
 * @param {GameMap} map Map.
 * @param {LaneGraph} graph Lane graph.
 * @returns {Int32Array} Indices by edge index.
 */
export function laneIndices(map, graph) {
  const out = new Int32Array(graph.edges.length).fill(-1);
  for (const road of map.roads) {
    for (const lane of road.lanes) {
      const i = graph.edgeIndex.get(lane.id);
      if (i !== undefined) out[i] = lane.index;
    }
  }
  return out;
}

/**
 * Empty traffic state for a map with a `traffic` block.
 * @param {GameMap} map Map.
 * @param {TrafficParams} params Params.
 * @param {number} runSeed Run seed.
 * @returns {TrafficState} State, before any spawn.
 */
export function createTrafficState(map, params, runSeed) {
  const traffic = map.traffic;
  if (!traffic) throw new Error(`Map ${map.id} has no traffic block`);
  const capacity = traffic.maxAgents;
  const graph = buildLaneGraph(map, params.behaviour, sweepOptions(map, params), params.speedDefaults);
  const modelKeys = Object.keys(params.models);
  const mixModel = traffic.mix.map((m) => {
    const i = modelKeys.indexOf(m.model);
    if (i < 0) throw new Error(`Map ${map.id} mixes unknown traffic model ${m.model}`);
    return i;
  });
  const f64 = () => new Float64Array(capacity);
  const i32 = () => new Int32Array(capacity);
  const free = new Int32Array(capacity);
  // Pop order gives slot 0 first.
  for (let i = 0; i < capacity; i += 1) free[i] = capacity - 1 - i;
  const edgeCount = graph.edges.length;
  /** @type {TrafficState} */
  const state = {
    map,
    params,
    graph,
    seed: hash32(runSeed, traffic.seed),
    modelKeys,
    mixModel,
    mixShare: traffic.mix.map((m) => m.share),
    capacity,
    t: 0,
    tick: 0,
    preRolling: false,
    alive: new Uint8Array(capacity),
    spawnIndex: f64(),
    ids: new Array(capacity).fill(''),
    model: i32(),
    personality: i32(),
    variant: i32(),
    edge: i32(),
    s: f64(),
    v: f64(),
    acc: f64(),
    x: f64(),
    z: f64(),
    heading: f64(),
    lateral: f64(),
    lateralBase: f64(),
    latRate: f64(),
    nextEdge: i32(),
    routeSeed: new Uint32Array(capacity),
    turnsTaken: i32(),
    v0Factor: f64(),
    timeGap: f64(),
    minGap: f64(),
    accelMax: f64(),
    decelComfort: f64(),
    delta: f64(),
    decelMax: f64(),
    criticalGap: f64(),
    yellowStop: f64(),
    lengthM: f64(),
    widthM: f64(),
    baseV0: f64(),
    wreck: new Uint8Array(capacity),
    wreckT: f64(),
    claim: i32().fill(-1),
    waitS: f64(),
    haltedAtLine: new Uint8Array(capacity),
    signalCommit: new Int8Array(capacity),
    rngState: new Uint32Array(capacity),
    classCriticalGap: f64(),
    held: new Uint8Array(capacity),
    flagNow: new Uint8Array(capacity),
    flagUntil: new Float64Array(capacity * FLAG_COUNT).fill(-Infinity),
    redConn: i32().fill(-1),
    noYieldConn: i32().fill(-1),
    unsafeChange: new Uint8Array(capacity),
    heedless: new Uint8Array(capacity),
    frozenS: f64(),
    heldBy: i32().fill(-1),
    makeRoomUntil: f64().fill(-Infinity),
    decisionSeed: new Uint32Array(capacity),
    decisions: i32(),
    speeding: new Uint8Array(capacity),
    noSignal: new Uint8Array(capacity),
    crossing: new Uint8Array(capacity),
    intent: new Int8Array(capacity),
    intentLane: i32().fill(-1),
    intentT: f64(),
    intentQuiet: new Uint8Array(capacity),
    intentCutIn: new Uint8Array(capacity),
    intentKind: new Int8Array(capacity),
    approachDraws: new Uint8Array(capacity),
    tailgateGap: f64(),
    reactionSteps: i32(),
    ring: new Float64Array(capacity * RING_STEPS * 2),
    ringPos: i32(),
    ringFresh: new Uint8Array(capacity),
    ouGap: f64(),
    ouRate: f64(),
    ouDecay: Math.exp(-DT / params.humanFactors.perceptionTauS),
    noiseState: new Uint32Array(capacity),
    distractProne: new Uint8Array(capacity),
    distractUntil: f64(),
    nextDistract: f64(),
    seenGap: f64(),
    seenV: f64(),
    heldGap: f64(),
    heldV: f64(),
    isMoto: new Uint8Array(capacity),
    egoSignalEpisode: 0,
    egoStillS: 0,
    egoHeadingBefore: Number.NaN,
    egoIndicator: 'off',
    halfWidth: laneHalfWidths(map, graph),
    openSides: laneOpenSides(map, graph),
    laneIndexOf: laneIndices(map, graph),
    active: i32(),
    activeCount: 0,
    free,
    freeCount: capacity,
    slotBySpawn: new Map(),
    edgeAgents: graph.edges.map(() => new Int32Array(capacity)),
    edgeCount: new Int32Array(edgeCount),
    claimants: graph.edges.map((e) => new Int32Array(e.kind === 'connector' ? capacity : 0)),
    claimCount: new Int32Array(edgeCount),
    grid: createGrid(graph.bounds, capacity),
    spawner: /** @type {import('./spawner.js').SpawnerState} */ (/** @type {unknown} */ (null)),
    stats: {
      spawned: 0,
      sourceEmitted: traffic.sources.map(() => 0),
      ringSpawned: 0,
      despawned: { sink: 0, 'edge-held': 0, ring: 0, behind: 0, 'dead-end': 0, reset: 0, wreck: 0, stuck: 0 },
    },
  };
  return state;
}

/**
 * Inserts `slot` into an edge list kept in ascending `s`.
 * @param {TrafficState} st State.
 * @param {number} edge Edge.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function edgeInsert(st, edge, slot) {
  const list = st.edgeAgents[edge];
  let i = st.edgeCount[edge];
  const s = st.s[slot];
  while (i > 0 && st.s[list[i - 1]] > s) {
    list[i] = list[i - 1];
    i -= 1;
  }
  list[i] = slot;
  st.edgeCount[edge] += 1;
}

/**
 * Removes `slot` from an edge list.
 * @param {TrafficState} st State.
 * @param {number} edge Edge.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function edgeRemove(st, edge, slot) {
  const list = st.edgeAgents[edge];
  const n = st.edgeCount[edge];
  let i = 0;
  while (i < n && list[i] !== slot) i += 1;
  if (i === n) return;
  for (; i < n - 1; i += 1) list[i] = list[i + 1];
  st.edgeCount[edge] = n - 1;
}

/**
 * Restores ascending `s` in every edge list (insertion sort; the lists are nearly sorted).
 * Ties keep their order, so the result is deterministic.
 * @param {TrafficState} st State.
 * @returns {void}
 */
export function sortEdgeLists(st) {
  for (let e = 0; e < st.edgeAgents.length; e += 1) {
    const list = st.edgeAgents[e];
    const n = st.edgeCount[e];
    for (let i = 1; i < n; i += 1) {
      const slot = list[i];
      const s = st.s[slot];
      let j = i - 1;
      while (j >= 0 && st.s[list[j]] > s) {
        list[j + 1] = list[j];
        j -= 1;
      }
      list[j + 1] = slot;
    }
  }
}

/**
 * Adds a claim of `slot` on connector `edge`.
 * @param {TrafficState} st State.
 * @param {number} edge Connector.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function claimAdd(st, edge, slot) {
  st.claimants[edge][st.claimCount[edge]] = slot;
  st.claimCount[edge] += 1;
  st.claim[slot] = edge;
}

/**
 * Drops the claim of `slot`, if any.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function claimDrop(st, slot) {
  const edge = st.claim[slot];
  if (edge < 0) return;
  const list = st.claimants[edge];
  const n = st.claimCount[edge];
  let i = 0;
  while (i < n && list[i] !== slot) i += 1;
  for (; i < n - 1; i += 1) list[i] = list[i + 1];
  if (n > 0) st.claimCount[edge] = n - 1;
  st.claim[slot] = -1;
}

/** @type {{x: number, z: number, heading: number}} */
const POINT = { x: 0, z: 0, heading: 0 };

/** Largest heading turn while moving across after a lane change, radians (design, about 14°). */
export const MAX_LANE_CHANGE_YAW = 0.25;
/**
 * Forward speed below which the heading turn shrinks as if the agent moved at this speed, m/s
 * (design): an agent edging out of a lane at a crawl barely turns, so its rear does not swing.
 */
const YAW_SPEED_FLOOR_MPS = 5;

/**
 * Recomputes the pose cache of a slot from its edge position; while the agent moves across, its
 * heading turns towards the side it moves to.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function updatePose(st, slot) {
  posePreview(st, slot, st.edge[slot], st.s[slot], st.lateral[slot], st.latRate[slot], st.v[slot], POSE);
  st.x[slot] = POSE.x;
  st.z[slot] = POSE.z;
  st.heading[slot] = POSE.heading;
}

/** @type {{x: number, z: number, heading: number}} */
const POSE = { x: 0, z: 0, heading: 0 };

/**
 * The pose a slot would have at `s` along `edge` (carried onto the next edge of its route when past
 * the end) with lateral offset `lateral` and lateral speed `latRate`, as `updatePose` sets it.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} edge Edge.
 * @param {number} s Centre distance along it.
 * @param {number} lateral Lateral offset.
 * @param {number} latRate Lateral speed.
 * @param {number} v Forward speed.
 * @param {{x: number, z: number, heading: number}} out Pose, written.
 * @returns {void}
 */
export function posePreview(st, slot, edge, s, lateral, latRate, v, out) {
  let e = st.graph.edges[edge];
  if (s > e.length && st.nextEdge[slot] >= 0 && e.index === st.edge[slot]) {
    s -= e.length;
    e = st.graph.edges[st.nextEdge[slot]];
  }
  edgePoint(e, Math.min(s, e.length), POINT);
  // Left of heading θ is (−sin θ, −cos θ), as `leftVector` in src/geometry.
  out.x = POINT.x - Math.sin(POINT.heading) * lateral;
  out.z = POINT.z - Math.cos(POINT.heading) * lateral;
  const yaw = latRate === 0 ? 0 : Math.max(-MAX_LANE_CHANGE_YAW, Math.min(MAX_LANE_CHANGE_YAW, Math.atan2(latRate, Math.max(v, YAW_SPEED_FLOOR_MPS))));
  out.heading = yaw === 0 ? POINT.heading : normalizeAngle(POINT.heading + yaw);
}

/**
 * Picks the next edge after the slot's current edge: a lane's connector, weighted by turn
 * (`behaviour.turnWeights`, split evenly between connectors of the same turn), or a connector's
 * exit lane. Each choice uses its own stream from the route seed and the choice count, so route
 * draws never shift the agent's other draws.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function chooseNext(st, slot) {
  const e = st.graph.edges[st.edge[slot]];
  if (e.kind === 'connector') {
    st.nextEdge[slot] = e.toEdge;
    return;
  }
  const n = e.next.length;
  if (n === 0) {
    st.nextEdge[slot] = -1;
    return;
  }
  if (n === 1) {
    st.nextEdge[slot] = e.next[0];
    drawNoSignal(st, slot);
    return;
  }
  const tw = st.params.behaviour.turnWeights;
  const edges = st.graph.edges;
  /** @type {Record<string, number>} */
  const perTurn = { straight: 0, left: 0, right: 0, uturn: 0 };
  for (const c of e.next) perTurn[/** @type {string} */ (edges[c].turn)] += 1;
  /**
   * @param {'straight' | 'left' | 'right' | 'uturn' | null} turn Turn.
   * @returns {number} Weight.
   */
  const weightOf = (turn) => (turn === 'uturn' || turn === null ? 0 : tw[turn] / perTurn[turn]);
  let weights = e.next.map((c) => weightOf(edges[c].turn));
  if (!weights.some((w) => w > 0)) weights = e.next.map(() => 1);
  const rng = createStream(hash32(st.routeSeed[slot], st.turnsTaken[slot]));
  st.nextEdge[slot] = e.next[pick(rng, weights)];
  drawNoSignal(st, slot);
  st.turnsTaken[slot] += 1;
}

/** Salt of the no-signal draw, so it never shares a stream with a route choice. */
const NO_SIGNAL_SALT = 0x5167;

/**
 * Whether the agent signals its next turn: its personality's `noSignal` rate, from a stream of its
 * route seed and choice count that no route choice uses.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
function drawNoSignal(st, slot) {
  const rate = st.params.personalities[PERSONALITIES[st.personality[slot]]].violations.noSignal;
  const rng = createStream(hash32(st.routeSeed[slot], st.turnsTaken[slot], NO_SIGNAL_SALT));
  st.noSignal[slot] = uniform(rng) < rate ? 1 : 0;
}

/**
 * Sets the slot's base desired speed for its current edge.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function refreshBaseSpeed(st, slot) {
  const { model, cls } = modelRows(st.params, st.modelKeys[st.model[slot]]);
  st.baseV0[slot] = edgeBaseSpeed(st.graph.edges[st.edge[slot]], cls, model.kind);
}

/**
 * Setup draws of one agent, in their fixed order.
 * @param {TrafficParams} params Params.
 * @param {number} seed Effective seed.
 * @param {string} mapId Map id.
 * @param {number} spawnIndex Spawn index.
 * @param {number} variants Variants of the model.
 * @returns {{personality: number, v0Factor: number, variant: number, routeSeed: number, rngState: number}}
 *   Draws, and the stream state after them.
 */
export function drawAgent(params, seed, mapId, spawnIndex, variants) {
  const rng = streamFor(seed, mapId, spawnIndex);
  const personality = pick(
    rng,
    PERSONALITIES.map((p) => params.personalities[p].share),
  );
  const row = params.personalities[PERSONALITIES[personality]];
  const v0Factor = range(rng, row.v0Factor[0], row.v0Factor[1]);
  const variant = Math.min(variants - 1, Math.floor(uniform(rng) * variants));
  const routeSeed = nextUint32(rng);
  return { personality, v0Factor, variant, routeSeed, rngState: rng.state };
}

/**
 * Spawns an agent. The caller has checked room; this only fills a slot.
 * @param {TrafficState} st State.
 * @param {number} edge Lane edge.
 * @param {number} s Centre distance along it.
 * @param {number} speed Initial speed.
 * @param {number} modelIndex Model index.
 * @returns {number} Slot, or −1 when every slot is taken.
 */
export function spawnAgent(st, edge, s, speed, modelIndex) {
  if (st.freeCount === 0) return -1;
  st.freeCount -= 1;
  const slot = st.free[st.freeCount];
  const index = st.stats.spawned;
  st.stats.spawned += 1;
  const key = st.modelKeys[modelIndex];
  const { model, cls } = modelRows(st.params, key);
  const d = drawAgent(st.params, st.seed, st.map.id, index, model.variants);
  const pers = st.params.personalities[PERSONALITIES[d.personality]];
  const rain = st.map.environment.weather === 'rain';

  st.alive[slot] = 1;
  st.spawnIndex[slot] = index;
  st.ids[slot] = `npc-${index}`;
  st.model[slot] = modelIndex;
  st.personality[slot] = d.personality;
  st.variant[slot] = d.variant;
  st.edge[slot] = edge;
  st.s[slot] = s;
  st.v[slot] = speed;
  st.acc[slot] = 0;
  st.isMoto[slot] = model.kind === 'motorbike' ? 1 : 0;
  st.lateralBase[slot] = model.kind === 'motorbike' ? -st.params.motorbike.keepRightOffsetM : 0;
  st.lateral[slot] = st.lateralBase[slot];
  st.latRate[slot] = 0;
  st.routeSeed[slot] = d.routeSeed;
  st.turnsTaken[slot] = 0;
  st.v0Factor[slot] = d.v0Factor;
  st.timeGap[slot] = cls.timeGapS * pers.timeGapFactor;
  st.minGap[slot] = cls.minGapM * pers.minGapFactor;
  st.accelMax[slot] = cls.accelMps2 * pers.accelFactor;
  st.decelComfort[slot] = cls.comfortDecelMps2 * pers.comfortDecelFactor;
  st.delta[slot] = cls.delta;
  st.decelMax[slot] = cls.maxDecelMps2 * (rain ? st.params.behaviour.rainDecelFactor : 1);
  st.criticalGap[slot] = cls.criticalGapS * pers.criticalGapFactor;
  st.classCriticalGap[slot] = cls.criticalGapS;
  st.yellowStop[slot] = Math.min(pers.yellowStopDecelMps2, st.decelMax[slot]);
  st.lengthM[slot] = model.lengthM;
  st.widthM[slot] = model.widthM;
  st.wreck[slot] = 0;
  st.wreckT[slot] = 0;
  st.claim[slot] = -1;
  st.waitS[slot] = 0;
  st.haltedAtLine[slot] = 0;
  st.signalCommit[slot] = 0;
  st.held[slot] = 0;
  st.redConn[slot] = -1;
  st.noYieldConn[slot] = -1;
  st.unsafeChange[slot] = 0;
  st.heedless[slot] = 0;
  st.frozenS[slot] = 0;
  st.heldBy[slot] = -1;
  st.makeRoomUntil[slot] = -Infinity;
  st.crossing[slot] = 0;
  st.intent[slot] = 0;
  st.intentLane[slot] = -1;
  st.intentQuiet[slot] = 0;
  st.intentCutIn[slot] = 0;
  st.intentKind[slot] = 0;
  st.approachDraws[slot] = 0;
  st.tailgateGap[slot] = cls.tailgatingGapS;
  clearFlags(st, slot);
  const rng = { state: d.rngState };
  drawHumanFactors(st, slot, rng);
  st.rngState[slot] = rng.state;
  refreshBaseSpeed(st, slot);
  chooseNext(st, slot);
  updatePose(st, slot);

  st.active[st.activeCount] = slot;
  st.activeCount += 1;
  st.slotBySpawn.set(index, slot);
  edgeInsert(st, edge, slot);
  return slot;
}

/**
 * Removes an agent.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {DespawnReason} reason Reason, counted in the stats.
 * @returns {void}
 */
export function despawnAgent(st, slot, reason) {
  if (!st.alive[slot]) return;
  claimDrop(st, slot);
  edgeRemove(st, st.edge[slot], slot);
  st.slotBySpawn.delete(st.spawnIndex[slot]);
  st.alive[slot] = 0;
  st.stats.despawned[reason] += 1;
  let j = 0;
  for (let i = 0; i < st.activeCount; i += 1) {
    if (st.active[i] !== slot) st.active[j++] = st.active[i];
  }
  st.activeCount = j;
  st.free[st.freeCount] = slot;
  st.freeCount += 1;
}
