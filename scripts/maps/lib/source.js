/**
 * Map sources to one normalised `MapSpec`: a network plus element placements in way distances.
 *
 * - Tutorial maps (`kind: tutorial`): nodes in metres and ways written by hand, so authors place
 *   everything by way and distance and never write a polygon. `layout: <id>` reuses another
 *   tutorial's network, signs, crosswalks, obstacles, buildings and route; keys given here win.
 * - OSM maps (`kind: osm`): `source.yaml` (bbox, name, route ways) + `raw.overpass.json` +
 *   `overrides.yaml`. Every override entry carries a `reason`.
 */

import { bboxCentre, createProjection } from './project.js';
import { STUB_M, nodeDistance, osmCorridor, wayPoints } from './graph.js';
import { LANE_WIDTH_M, parseLineSpec } from './lanes.js';
import { polylineLength } from '../../../src/geometry/index.js';
import { NPC_VIOLATIONS } from '../../../src/contracts/telemetry.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('./graph.js').Network} Network */
/** @typedef {import('./graph.js').NetWay} NetWay */
/** @typedef {import('./graph.js').OsmElement} OsmElement */
/** @typedef {'forward' | 'backward'} Dir */

/**
 * Parsed YAML under validation. `any` is deliberate: the parsers read fields before their shape
 * is proven, and every read goes through one of the validators below.
 */
// eslint-disable-next-line jsdoc/reject-any-type
/** @typedef {any} SourceYaml */

/**
 * @typedef {object} WayAt
 * @property {string} way Network way id.
 * @property {number} s Way distance.
 */

/**
 * @typedef {object} SignSpec
 * @property {string} id Sign id.
 * @property {string} code QCVN 41 code.
 * @property {number} [value] Value on the sign.
 * @property {WayAt} at Position.
 * @property {Dir} dir Direction of the traffic it faces.
 */

/**
 * @typedef {object} ActorSpec
 * @property {string} id Actor id.
 * @property {'pedestrian' | 'car' | 'motorbike'} kind Kind. A motorbike is drawn ridden.
 * @property {string} model Renderer model key.
 * @property {number} lengthM Length.
 * @property {number} widthM Width.
 * @property {number} speed Speed (m/s).
 * @property {boolean} loop Looping path.
 * @property {{lanes: Array<{way: string, dir: Dir, index: number, fromS: number, toS: number}>} | {crosswalk: string, from: 'left' | 'right'}} path
 *   Path spec: lane stretches driven in order, or across a crosswalk.
 * @property {{atS: number} | {way: string, fromS: number, toS: number}} trigger Trigger spec.
 * @property {Array<import('../../../src/contracts/telemetry.js').NpcViolation>} [violations] Violations the
 *   actor carries while it is active, from `NPC_VIOLATIONS`; absent when none.
 */

/**
 * @typedef {object} JunctionSpec
 * @property {{green: number, yellow: number, red: number} | null} signals Light cycle when signalised.
 * @property {Vec2[]} [polygon] Hand-placed polygon.
 * @property {number} [trimM] Hand-set trim distance.
 */

/**
 * @typedef {object} MapSpec
 * @property {string} id Map id.
 * @property {'tutorial' | 'osm'} kind Kind.
 * @property {{vi: string, en?: string}} name Name.
 * @property {{startClockMin: number, weather: 'clear' | 'rain', surfaceGrip: number}} environment Environment.
 * @property {number} timeLimitS Time limit.
 * @property {string} [attribution] Attribution.
 * @property {{lat: number, lon: number}} [origin] Projection origin.
 * @property {Network} network Network.
 * @property {Map<string, JunctionSpec>} junctions Junction settings by node id.
 * @property {SignSpec[]} signs Signs.
 * @property {Array<{id: string, at: WayAt, widthM: number, clamp: boolean}>} crosswalks Crosswalks.
 * @property {Array<{id: string, kind: 'building' | 'parked-car' | 'barrier', at: WayAt, lateral: number, lengthM: number, widthM: number, heightM: number}>} obstacles Obstacles.
 * @property {Array<{id: string, way: string, side: 'left' | 'right', fromS: number, toS: number, depthM: number, heightM: number, setbackM: number}>} buildings Building rows.
 * @property {ActorSpec[]} actors Actors.
 * @property {{start: {at: WayAt, dir: Dir, lane: number}, checkpoints: Array<{at: WayAt, dir: Dir, lane: number | null}>, finish: {at: WayAt, dir: Dir, lengthM: number}}} route Route.
 * @property {boolean} lit Whole map lit by street lights.
 * @property {'tutorial' | 'override'} placedSource Source tag for placed signs and the zones they make.
 * @property {number[]} [routeOsmWays] OSM route way ids in order (OSM maps).
 * @property {Map<string, Dir>} [routeDirs] Travel direction per route way id (OSM maps).
 * @property {import('./graph.js').StubNote[]} [stubNotes] Side-road stubs kept shorter than the
 *   map's `stubM` (OSM maps).
 */

/** OSM map attribution required by the ODbL. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL';

/**
 * All-red clearance at each change between the two axes of a signalised junction (s,
 * `paramBasis: design`; QCVN 41:2024 sets no all-red length).
 */
export const ALL_RED_S = 2;

/**
 * Default light cycle (s). Green 25 s is over the 15 s minimum green of Phụ lục A.2: QCVN 41:2019
 * text plus the 2024 changes listed in the August 2024 drafting comparison table, matching the
 * 2026 draft text; not read from the 2024 text itself (unverified). Yellow 3 s; red 32 s =
 * green + yellow + 2 × `ALL_RED_S`. The cross axis runs half a period (30 s) later,
 * so each change carries `ALL_RED_S` of all-red (`paramBasis: design`).
 */
export const DEFAULT_CYCLE = Object.freeze({ green: 25, yellow: 3, red: 32 });

/** Default crosswalk width (m), a game value. */
export const CROSSWALK_WIDTH_M = 4;

/** Default pavement width (m), a game value. */
export const PAVEMENT_M = 3;

/** Lanes per direction when OSM has no lane tag (game defaults by class). */
const OSM_DEFAULT_LANES = Object.freeze({
  oneway: { primary: 3, secondary: 2, tertiary: 2 },
  twoway: { primary: 2, secondary: 2 },
});

// ---------------------------------------------------------------------------------------------
// Small validators. `where` names the source file field for error messages.

/**
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @returns {SourceYaml} Object.
 */
function obj(v, where) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: expected a mapping`);
  return /** @type {SourceYaml} */ (v);
}

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
 * @returns {string} String.
 */
function str(v, where) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: expected a non-empty string`);
  return v;
}

/**
 * Declared violations of an actor: a list of names from `NPC_VIOLATIONS`.
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @returns {Array<import('../../../src/contracts/telemetry.js').NpcViolation>} Names.
 */
function violationsOf(v, where) {
  if (!Array.isArray(v)) throw new Error(`${where}: expected a list`);
  return v.map((name, k) => oneOf(name, NPC_VIOLATIONS, `${where}[${k}]`));
}

/**
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @returns {unknown[]} Array (empty when absent).
 */
function list(v, where) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${where}: expected a list`);
  return v;
}

/**
 * @template {string} T
 * @param {unknown} v Value.
 * @param {readonly T[]} options Allowed values.
 * @param {string} where Field.
 * @returns {T} Value.
 */
function oneOf(v, options, where) {
  if (!options.includes(/** @type {T} */ (v))) throw new Error(`${where}: expected one of ${options.join(', ')}`);
  return /** @type {T} */ (v);
}

/**
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @returns {{vi: string, en?: string}} Text.
 */
function text(v, where) {
  const t = obj(v, where);
  const out = { vi: str(t.vi, `${where}.vi`) };
  if (t.en !== undefined && t.en !== '') return { ...out, en: str(t.en, `${where}.en`) };
  return out;
}

/**
 * @param {unknown} v Value.
 * @param {string} where Field.
 * @returns {MapSpec['environment']} Environment.
 */
function environment(v, where) {
  const e = obj(v, where);
  return {
    startClockMin: num(e.startClockMin, `${where}.startClockMin`, { min: 0, max: 1439 }),
    weather: oneOf(e.weather, /** @type {const} */ (['clear', 'rain']), `${where}.weather`),
    surfaceGrip: num(e.surfaceGrip, `${where}.surfaceGrip`, { min: 0.05, max: 2 }),
  };
}

/**
 * @param {unknown} v Pavement spec (number or `{left, right}`).
 * @param {string} where Field.
 * @param {number} fallback Default width.
 * @returns {{left: number, right: number}} Widths.
 */
function pavement(v, where, fallback) {
  if (v === undefined) return { left: fallback, right: fallback };
  if (typeof v === 'number') return { left: num(v, where, { min: 0 }), right: v };
  const p = obj(v, where);
  return { left: num(p.left ?? 0, `${where}.left`, { min: 0 }), right: num(p.right ?? 0, `${where}.right`, { min: 0 }) };
}

/**
 * Validates a way's lane counts.
 * @param {number} forward Forward lanes.
 * @param {number} backward Backward lanes.
 * @param {boolean} oneway One-way.
 * @param {string} where Field.
 */
function checkLanes(forward, backward, oneway, where) {
  num(forward, `${where}.forward`, { integer: true, min: 1, max: 6 });
  num(backward, `${where}.backward`, { integer: true, min: oneway ? 0 : 1, max: 6 });
  if (oneway && backward !== 0) throw new Error(`${where}: one-way ways have no backward lanes`);
}

// ---------------------------------------------------------------------------------------------

/**
 * Shared parts of both source kinds: placements in way distances.
 * @typedef {(at: unknown, dir: Dir, where: string) => WayAt} ResolveAt
 * @typedef {(way: unknown, where: string) => string} ResolveWay
 */

/**
 * @param {unknown} v Direction or undefined.
 * @param {Dir} fallback Default.
 * @param {string} where Field.
 * @returns {Dir} Direction.
 */
function dirOf(v, fallback, where) {
  return v === undefined ? fallback : oneOf(v, /** @type {const} */ (['forward', 'backward']), where);
}

/**
 * Parses the element lists shared by both kinds.
 * @param {SourceYaml} src Source mapping.
 * @param {ResolveAt} at Position resolver.
 * @param {ResolveWay} wayOf Way resolver.
 * @param {(wayId: string) => Dir} defaultDir Default travel direction on a way.
 * @param {string} file File name for messages.
 * @returns {Pick<MapSpec, 'signs' | 'crosswalks' | 'obstacles' | 'buildings' | 'actors' | 'route'>} Elements.
 */
function parseElements(src, at, wayOf, defaultDir, file) {
  /** @type {Set<string>} */
  const ids = new Set();
  /**
   * @param {unknown} id Candidate id.
   * @param {string} fallback Generated id.
   * @param {string} where Field.
   * @returns {string} Unique id.
   */
  const claim = (id, fallback, where) => {
    const s = id === undefined ? fallback : str(id, `${where}.id`);
    if (ids.has(s)) throw new Error(`${where}: duplicate id ${s}`);
    ids.add(s);
    return s;
  };

  const signs = list(src.signs, `${file} signs`).map((raw, i) => {
    const w = `${file} signs[${i}]`;
    const s = obj(raw, w);
    const code = str(s.code, `${w}.code`);
    const wayId = wayOf(obj(s.at, `${w}.at`).way, `${w}.at.way`);
    const dir = dirOf(s.dir, defaultDir(wayId), `${w}.dir`);
    const placed = at(s.at, dir, `${w}.at`);
    /** @type {SignSpec} */
    const out = {
      id: claim(s.id, `s-${code.toLowerCase().replace(/\./g, '')}-${i + 1}`, w),
      code,
      at: placed,
      dir,
    };
    if (s.value !== undefined) out.value = num(s.value, `${w}.value`, { min: 0 });
    if (code === 'P.127' && out.value === undefined) throw new Error(`${w}: P.127 needs a value`);
    return out;
  });

  const crosswalks = list(src.crosswalks, `${file} crosswalks`).map((raw, i) => {
    const w = `${file} crosswalks[${i}]`;
    const c = obj(raw, w);
    const wayId = wayOf(obj(c.at, `${w}.at`).way, `${w}.at.way`);
    return {
      id: claim(c.id, `cw-${i + 1}`, w),
      at: at(c.at, defaultDir(wayId), `${w}.at`),
      widthM: num(c.widthM ?? CROSSWALK_WIDTH_M, `${w}.widthM`, { min: 2, max: 10 }),
      clamp: false,
    };
  });

  const obstacles = list(src.obstacles, `${file} obstacles`).map((raw, i) => {
    const w = `${file} obstacles[${i}]`;
    const o = obj(raw, w);
    const wayId = wayOf(obj(o.at, `${w}.at`).way, `${w}.at.way`);
    return {
      id: claim(o.id, `ob-${i + 1}`, w),
      kind: oneOf(o.kind, /** @type {const} */ (['building', 'parked-car', 'barrier']), `${w}.kind`),
      at: at(o.at, defaultDir(wayId), `${w}.at`),
      lateral: num(o.lateral ?? 0, `${w}.lateral`),
      lengthM: num(o.lengthM, `${w}.lengthM`, { min: 0.2 }),
      widthM: num(o.widthM, `${w}.widthM`, { min: 0.2 }),
      heightM: num(o.heightM, `${w}.heightM`, { min: 0.1 }),
    };
  });

  const buildings = list(src.buildings, `${file} buildings`).map((raw, i) => {
    const w = `${file} buildings[${i}]`;
    const b = obj(raw, w);
    const fromS = num(b.fromS, `${w}.fromS`, { min: 0 });
    const toS = num(b.toS, `${w}.toS`);
    if (!(toS > fromS)) throw new Error(`${w}: toS must exceed fromS`);
    return {
      id: claim(b.id, `bd-${i + 1}`, w),
      way: wayOf(b.way, `${w}.way`),
      side: oneOf(b.side, /** @type {const} */ (['left', 'right']), `${w}.side`),
      fromS,
      toS,
      depthM: num(b.depthM ?? 12, `${w}.depthM`, { min: 1 }),
      heightM: num(b.heightM ?? 12, `${w}.heightM`, { min: 1 }),
      setbackM: num(b.setbackM ?? 0.5, `${w}.setbackM`, { min: 0 }),
    };
  });

  const actors = list(src.actors, `${file} actors`).map((raw, i) => {
    const w = `${file} actors[${i}]`;
    const a = obj(raw, w);
    const p = obj(a.path, `${w}.path`);
    /** @type {ActorSpec['path']} */
    let path;
    if (p.crosswalk !== undefined) {
      path = { crosswalk: str(p.crosswalk, `${w}.path.crosswalk`), from: oneOf(p.from ?? 'right', /** @type {const} */ (['left', 'right']), `${w}.path.from`) };
    } else {
      const stretches = p.lanes !== undefined ? list(p.lanes, `${w}.path.lanes`) : [p];
      if (stretches.length === 0) throw new Error(`${w}.path.lanes: empty`);
      path = {
        lanes: stretches.map((raw, k) => {
          const pw = `${w}.path.lanes[${k}]`;
          const st = obj(raw, pw);
          const lane = obj(st.lane ?? st, pw);
          const way = wayOf(lane.way, `${pw}.way`);
          return {
            way,
            dir: dirOf(lane.dir, defaultDir(way), `${pw}.dir`),
            index: num(lane.index ?? 0, `${pw}.index`, { integer: true, min: 0 }),
            fromS: num(st.fromS, `${pw}.fromS`, { min: 0 }),
            toS: num(st.toS, `${pw}.toS`, { min: 0 }),
          };
        }),
      };
    }
    const t = obj(a.trigger, `${w}.trigger`);
    /** @type {ActorSpec['trigger']} */
    const trigger =
      t.atS !== undefined
        ? { atS: num(t.atS, `${w}.trigger.atS`, { min: 0 }) }
        : { way: wayOf(t.way, `${w}.trigger.way`), fromS: num(t.fromS, `${w}.trigger.fromS`, { min: 0 }), toS: num(t.toS, `${w}.trigger.toS`) };
    return {
      id: claim(a.id, `actor-${i + 1}`, w),
      kind: oneOf(a.kind, /** @type {const} */ (['pedestrian', 'car', 'motorbike']), `${w}.kind`),
      model: str(a.model, `${w}.model`),
      lengthM: num(a.lengthM, `${w}.lengthM`, { min: 0.1 }),
      widthM: num(a.widthM, `${w}.widthM`, { min: 0.1 }),
      speed: num(a.speed, `${w}.speed`, { min: 0, max: 30 }),
      loop: a.loop === undefined ? false : Boolean(a.loop),
      path,
      trigger,
      ...(a.violations === undefined
        ? {}
        : { violations: violationsOf(a.violations, `${w}.violations`) }),
    };
  });

  const r = obj(src.route, `${file} route`);
  /**
   * @param {unknown} v Route point.
   * @param {string} w Field.
   * @returns {{at: WayAt, dir: Dir, raw: SourceYaml}} Resolved.
   */
  const routePoint = (v, w) => {
    const p = obj(v, w);
    const way = wayOf(obj(p.at ?? p, w).way, `${w}.way`);
    const dir = dirOf(p.dir, defaultDir(way), `${w}.dir`);
    return { at: at(p.at ?? p, dir, w), dir, raw: p };
  };
  const start = routePoint(r.start, `${file} route.start`);
  const finish = routePoint(r.finish, `${file} route.finish`);
  const route = {
    start: { at: start.at, dir: start.dir, lane: num(start.raw.lane ?? 0, `${file} route.start.lane`, { integer: true, min: 0 }) },
    checkpoints: list(r.checkpoints, `${file} route.checkpoints`).map((c, i) => {
      const w = `${file} route.checkpoints[${i}]`;
      const p = routePoint(c, w);
      const lane = p.raw.lane === undefined ? null : num(p.raw.lane, `${w}.lane`, { integer: true, min: 0 });
      return { at: p.at, dir: p.dir, lane };
    }),
    finish: { at: finish.at, dir: finish.dir, lengthM: num(finish.raw.lengthM ?? 10, `${file} route.finish.lengthM`, { min: 3 }) },
  };

  return { signs, crosswalks, obstacles, buildings, actors, route };
}

/**
 * Parses junction settings (`signals`, `trimM`, and for OSM maps `polygon`).
 * @param {unknown} v Junction list.
 * @param {(node: unknown, where: string) => string} nodeOf Node resolver.
 * @param {((p: unknown, where: string) => Vec2[]) | null} polygonOf Polygon parser, null when polygons are not allowed.
 * @param {string} file File name.
 * @returns {Map<string, JunctionSpec>} Settings by node id.
 */
function parseJunctions(v, nodeOf, polygonOf, file) {
  /** @type {Map<string, JunctionSpec>} */
  const out = new Map();
  list(v, `${file} junctions`).forEach((raw, i) => {
    const w = `${file} junctions[${i}]`;
    const j = obj(raw, w);
    const node = nodeOf(j.node, `${w}.node`);
    if (out.has(node)) throw new Error(`${w}: junction ${node} listed twice`);
    /** @type {JunctionSpec} */
    const spec = { signals: null };
    if (j.signals !== undefined && j.signals !== false) {
      const c = j.signals === true ? {} : obj(j.signals, `${w}.signals`);
      spec.signals = {
        green: num(c.green ?? DEFAULT_CYCLE.green, `${w}.signals.green`, { min: 1 }),
        yellow: num(c.yellow ?? DEFAULT_CYCLE.yellow, `${w}.signals.yellow`, { min: 1 }),
        red: num(c.red ?? DEFAULT_CYCLE.red, `${w}.signals.red`, { min: 1 }),
      };
      // The cross axis runs half a period later, so each change has (red − green − yellow) / 2 of
      // all-red.
      if (spec.signals.red < spec.signals.green + spec.signals.yellow + 2 * ALL_RED_S) {
        throw new Error(`${w}.signals: red must be at least green + yellow + ${2 * ALL_RED_S} s, for ${ALL_RED_S} s of all-red at each change`);
      }
    }
    if (j.trimM !== undefined) spec.trimM = num(j.trimM, `${w}.trimM`, { min: 1, max: 40 });
    if (j.polygon !== undefined) {
      if (!polygonOf) throw new Error(`${w}.polygon: tutorial junction polygons are built by the converter`);
      spec.polygon = polygonOf(j.polygon, `${w}.polygon`);
    }
    out.set(node, spec);
  });
  return out;
}

/**
 * Tutorial source to a map spec.
 * @param {string} id Map id.
 * @param {SourceYaml} src Parsed `source.yaml`.
 * @param {(id: string) => SourceYaml} loadLayout Loads another tutorial's source by id.
 * @returns {MapSpec} Spec.
 */
export function tutorialSpec(id, src, loadLayout) {
  const file = `${id}/source.yaml`;
  let merged = src;
  if (src.layout !== undefined) {
    const base = loadLayout(str(src.layout, `${file} layout`));
    if (base.layout !== undefined) throw new Error(`${file}: layout ${src.layout} itself uses a layout`);
    merged = { ...base, ...src };
  }

  /** @type {Network} */
  const network = { nodes: new Map(), ways: [] };
  const nodes = obj(merged.nodes, `${file} nodes`);
  for (const key of Object.keys(nodes).sort()) {
    const p = nodes[key];
    if (!Array.isArray(p) || p.length !== 2) throw new Error(`${file} nodes.${key}: expected [x, z]`);
    network.nodes.set(key, { id: key, pos: [num(p[0], `${file} nodes.${key}[0]`), num(p[1], `${file} nodes.${key}[1]`)] });
  }
  list(merged.ways, `${file} ways`).forEach((raw, i) => {
    const w = `${file} ways[${i}]`;
    const x = obj(raw, w);
    const oneway = Boolean(x.oneway);
    const lanes = obj(x.lanes ?? {}, `${w}.lanes`);
    const forward = lanes.forward ?? 1;
    const backward = lanes.backward ?? (oneway ? 0 : 1);
    checkLanes(forward, backward, oneway, `${w}.lanes`);
    const nodeIds = list(x.nodes, `${w}.nodes`).map((n, k) => {
      const nid = str(n, `${w}.nodes[${k}]`);
      if (!network.nodes.has(nid)) throw new Error(`${w}.nodes[${k}]: unknown node ${nid}`);
      return nid;
    });
    if (nodeIds.length < 2) throw new Error(`${w}.nodes: needs at least 2 nodes`);
    network.ways.push({
      id: str(x.id, `${w}.id`),
      cls: x.class === undefined ? 'tertiary' : str(x.class, `${w}.class`),
      nodeIds,
      oneway,
      divided: Boolean(x.divided),
      priority: Boolean(x.priority),
      forward,
      backward,
      centerLine: parseLineSpec(x.centerLine ?? 'dashed', `${w}.centerLine`),
      laneLine: parseLineSpec(x.laneLine ?? 'dashed', `${w}.laneLine`),
      authoredLines: { center: x.centerLine !== undefined, lane: x.laneLine !== undefined },
      pavement: pavement(x.pavement, `${w}.pavement`, PAVEMENT_M),
    });
  });
  const wayIds = new Set(network.ways.map((w) => w.id));

  /** @type {ResolveWay} */
  const wayOf = (way, where) => {
    const w = str(way, where);
    if (!wayIds.has(w)) throw new Error(`${where}: unknown way ${w}`);
    return w;
  };
  /** @type {ResolveAt} */
  const at = (raw, _dir, where) => {
    const a = obj(raw, where);
    const way = wayOf(a.way, `${where}.way`);
    const netWay = /** @type {NetWay} */ (network.ways.find((w) => w.id === way));
    const len = polylineLength(wayPoints(network, netWay));
    return { way, s: num(a.s, `${where}.s`, { min: 0, max: len }) };
  };

  return {
    id,
    kind: 'tutorial',
    name: text(merged.name, `${file} name`),
    environment: environment(merged.environment, `${file} environment`),
    timeLimitS: num(merged.timeLimitS, `${file} timeLimitS`, { min: 10 }),
    network,
    junctions: parseJunctions(
      merged.junctions,
      (n, where) => {
        const nid = str(n, where);
        if (!network.nodes.has(nid)) throw new Error(`${where}: unknown node ${nid}`);
        return nid;
      },
      null,
      file,
    ),
    ...parseElements(merged, at, wayOf, () => 'forward', file),
    lit: Boolean(merged.lit),
    placedSource: 'tutorial',
  };
}

/**
 * OSM source, extract and overrides to a map spec.
 * @param {string} id Map id.
 * @param {SourceYaml} src Parsed `source.yaml`.
 * @param {{elements: OsmElement[]}} raw Parsed `raw.overpass.json`.
 * @param {SourceYaml} overrides Parsed `overrides.yaml`.
 * @returns {MapSpec} Spec.
 */
export function osmSpec(id, src, raw, overrides) {
  const file = `${id}/source.yaml`;
  const ofile = `${id}/overrides.yaml`;
  const origin = bboxCentre(/** @type {import('./project.js').Bbox} */ (obj(src.bbox, `${file} bbox`)));
  const proj = createProjection(origin);
  const routeSpec = obj(src.route, `${file} route`);
  const routeWays = list(routeSpec.ways, `${file} route.ways`).map((w, i) => num(w, `${file} route.ways[${i}]`, { integer: true, min: 1 }));

  // Every override section must justify itself.
  for (const section of ['ways', 'junctions', 'signs', 'crosswalks', 'actors', 'obstacles']) {
    list(overrides[section], `${ofile} ${section}`).forEach((e, i) => {
      str(obj(e, `${ofile} ${section}[${i}]`).reason, `${ofile} ${section}[${i}].reason`);
    });
  }
  /** @type {Map<number, SourceYaml>} */
  const wayOverrides = new Map();
  list(overrides.ways, `${ofile} ways`).forEach((e, i) => {
    const o = obj(e, `${ofile} ways[${i}]`);
    const wid = num(o.way, `${ofile} ways[${i}].way`, { integer: true, min: 1 });
    if (wayOverrides.has(wid)) throw new Error(`${ofile} ways[${i}]: way ${wid} listed twice`);
    wayOverrides.set(wid, o);
  });

  const stubM = num(src.stubM ?? STUB_M, `${file} stubM`, { min: 1 });
  const { network, routeDirs, osmNodes, stubNotes, stubNodeSources } = osmCorridor(raw, routeWays, proj, (w, oneway) => {
    const tags = /** @type {Record<string, string>} */ (w.tags);
    const o = wayOverrides.get(w.id) ?? {};
    const where = `${ofile} ways(${w.id})`;
    const tagLanes = (/** @type {string} */ k) => {
      const n = Number.parseInt(tags[k] ?? '', 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const total = tagLanes('lanes');
    /** @type {number} */
    let forward;
    /** @type {number} */
    let backward;
    if (oneway) {
      forward = total ?? /** @type {Record<string, number>} */ (OSM_DEFAULT_LANES.oneway)[tags.highway] ?? 1;
      backward = 0;
    } else {
      const def = /** @type {Record<string, number>} */ (OSM_DEFAULT_LANES.twoway)[tags.highway] ?? 1;
      forward = tagLanes('lanes:forward') ?? (total ? Math.max(1, Math.ceil(total / 2)) : def);
      backward = tagLanes('lanes:backward') ?? (total ? Math.max(1, Math.floor(total / 2)) : def);
    }
    if (o.forward !== undefined) forward = o.forward;
    if (o.backward !== undefined) backward = o.backward;
    checkLanes(forward, backward, oneway, where);
    const noSidewalk = tags.sidewalk === 'no' || tags.sidewalk === 'none';
    return {
      divided: Boolean(o.divided),
      priority: false,
      forward,
      backward,
      centerLine: parseLineSpec(o.centerLine ?? (forward >= 2 && backward >= 2 ? 'solid' : 'dashed'), `${where}.centerLine`),
      laneLine: parseLineSpec(o.laneLine ?? 'dashed', `${where}.laneLine`),
      authoredLines: { center: o.centerLine !== undefined, lane: o.laneLine !== undefined },
      pavement: pavement(o.pavement, `${where}.pavement`, noSidewalk ? 0 : PAVEMENT_M),
    };
  }, { stubM, laneWidth: LANE_WIDTH_M });
  for (const wid of wayOverrides.keys()) {
    if (!network.ways.some((w) => w.osmWayId === wid)) throw new Error(`${ofile} ways: way ${wid} is not in the corridor`);
  }

  /** @type {ResolveWay} */
  const wayOf = (way, where) => {
    const wid = num(way, where, { integer: true, min: 1 });
    if (!routeWays.includes(wid)) throw new Error(`${where}: way ${wid} is not a route way`);
    return `w${wid}`;
  };
  /** @type {ResolveAt} */
  const at = (rawAt, dir, where) => {
    const a = obj(rawAt, where);
    const wayId = wayOf(a.way, `${where}.way`);
    const way = /** @type {NetWay} */ (network.ways.find((w) => w.id === wayId));
    const len = polylineLength(wayPoints(network, way));
    if (a.s !== undefined) return { way: wayId, s: num(a.s, `${where}.s`, { min: 0, max: len }) };
    const node = `n${num(a.node, `${where}.node`, { integer: true, min: 1 })}`;
    const offset = num(a.offsetM ?? 0, `${where}.offsetM`);
    const s = nodeDistance(network, way, node) + (dir === 'forward' ? offset : -offset);
    if (s < 0 || s > len) throw new Error(`${where}: offset runs off way ${a.way}`);
    return { way: wayId, s };
  };
  const defaultDir = (/** @type {string} */ wayId) => routeDirs.get(wayId) ?? 'forward';

  const elements = parseElements({ ...overrides, route: routeSpec }, at, wayOf, defaultDir, ofile);

  // Marked OSM crossings on every corridor way, side-road stubs included, become crosswalks.
  const crosswalkIds = new Set(elements.crosswalks.map((c) => c.id));
  for (const way of network.ways) {
    if (way.osmWayId === undefined) continue;
    for (const nid of way.nodeIds) {
      // A stub vertex carries its own id; its OSM node is looked up through the stub's sources.
      const osmId = stubNodeSources.get(nid) ?? nid;
      const tags = osmNodes.get(osmId)?.tags;
      if (!tags || tags.highway !== 'crossing' || !isMarkedCrossing(tags)) continue;
      const cid = `cw-${osmId}`;
      if (crosswalkIds.has(cid)) continue;
      crosswalkIds.add(cid);
      elements.crosswalks.push({ id: cid, at: { way: way.id, s: nodeDistance(network, way, nid) }, widthM: CROSSWALK_WIDTH_M, clamp: true });
    }
  }

  // Junction settings: OSM traffic_signals nodes mark signalised junctions; overrides add the rest.
  const junctions = parseJunctions(
    overrides.junctions,
    (n, where) => {
      const nid = `n${num(n, where, { integer: true, min: 1 })}`;
      if (!network.nodes.has(nid)) throw new Error(`${where}: node ${n} is not in the corridor`);
      return nid;
    },
    (p, where) =>
      list(p, where).map((pt, k) => {
        if (!Array.isArray(pt) || pt.length !== 2) throw new Error(`${where}[${k}]: expected [lat, lon]`);
        return proj.toXZ(num(pt[0], `${where}[${k}][0]`), num(pt[1], `${where}[${k}][1]`));
      }),
    ofile,
  );
  const signalNodes = new Set([...osmNodes].filter(([, n]) => n.tags?.highway === 'traffic_signals').map(([k]) => k));

  return {
    id,
    kind: 'osm',
    name: text(src.name, `${file} name`),
    environment: environment(overrides.environment, `${ofile} environment`),
    timeLimitS: num(overrides.timeLimitS, `${ofile} timeLimitS`, { min: 10 }),
    attribution: OSM_ATTRIBUTION,
    origin,
    network: { ...network, signalNodes },
    junctions,
    ...elements,
    lit: Boolean(overrides.lit),
    placedSource: 'override',
    routeOsmWays: routeWays,
    routeDirs,
    stubNotes,
  };
}

/**
 * Whether an OSM crossing node is a marked (zebra) crossing.
 * @param {Record<string, string>} tags Node tags.
 * @returns {boolean} Marked.
 */
export function isMarkedCrossing(tags) {
  if (tags['crossing:markings'] !== undefined) return tags['crossing:markings'] !== 'no';
  return ['marked', 'zebra', 'uncontrolled', 'traffic_signals'].includes(tags.crossing ?? '');
}

