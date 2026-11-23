/**
 * Map validation: shape, globally unique ids and resolvable references.
 */

import { Checker, ContractError } from './check.js';

/** @typedef {import('./check.js').UntrustedJson} UntrustedJson */
import {
  ACTOR_KINDS,
  CROSSABLE,
  ENTRY_CLASSES,
  LANE_LINE_TYPES,
  MANOEUVRES,
  MAP_COLLECTIONS,
  MAP_SCHEMA_VERSION,
  OBSTACLE_KINDS,
  SIGN_SOURCES,
  STOP_CONTROLS,
  ZONE_SOURCES,
  ZONE_TYPES,
} from './map.js';
import { WEATHERS } from './telemetry.js';

/**
 * @typedef {object} MapCheckOptions
 * @property {readonly string[]} [signCodes] Known sign codes; when given, every map sign must use one.
 */

/**
 * Lists every problem of a map; empty when valid.
 * @param {unknown} map Candidate map.
 * @param {MapCheckOptions} [options] Options.
 * @returns {string[]} Problems.
 */
export function checkMap(map, options = {}) {
  const c = new Checker();
  if (!c.object(map, 'map')) return c.problems;
  const m = /** @type {UntrustedJson} */ (map);

  if (m.schemaVersion !== MAP_SCHEMA_VERSION) c.fail('schemaVersion', `expected ${MAP_SCHEMA_VERSION}`);
  c.string(m.id, 'id');
  c.text(m.name, 'name');
  c.oneOf(m.kind, ['tutorial', 'osm'], 'kind');
  if (m.kind === 'osm') {
    c.string(m.attribution, 'attribution');
    if (c.object(m.origin, 'origin')) {
      c.number(m.origin.lat, 'origin.lat', { min: -90, max: 90 });
      c.number(m.origin.lon, 'origin.lon', { min: -180, max: 180 });
    }
  } else {
    if (m.attribution !== undefined) c.string(m.attribution, 'attribution');
    if (m.origin !== undefined && c.object(m.origin, 'origin')) {
      c.number(m.origin.lat, 'origin.lat', { min: -90, max: 90 });
      c.number(m.origin.lon, 'origin.lon', { min: -180, max: 180 });
    }
  }

  if (c.object(m.environment, 'environment')) {
    c.number(m.environment.startClockMin, 'environment.startClockMin', { min: 0, max: 1439.999 });
    c.oneOf(m.environment.weather, WEATHERS, 'environment.weather');
    c.number(m.environment.surfaceGrip, 'environment.surfaceGrip', { min: 0.05, max: 2 });
  }

  checkRoute(c, m.route);

  for (const key of MAP_COLLECTIONS) c.array(m[key], key);
  if (c.problems.some((p) => MAP_COLLECTIONS.some((k) => p.startsWith(`${k}:`)))) return c.problems;

  /** @type {Map<string, string>} id → kind */
  const ids = new Map();
  /**
   * @param {unknown} id Id.
   * @param {string} path Path.
   * @param {string} kind Element kind.
   */
  const claim = (id, path, kind) => {
    if (!c.string(id, `${path}.id`)) return;
    const s = /** @type {string} */ (id);
    if (ids.has(s)) c.fail(`${path}.id`, `duplicate id "${s}"`);
    else ids.set(s, kind);
  };

  m.roads.forEach((road, i) => {
    const p = `roads[${i}]`;
    if (!c.object(road, p)) return;
    claim(road.id, p, 'road');
    if (road.osmWayId !== undefined) c.number(road.osmWayId, `${p}.osmWayId`, { integer: true, min: 1 });
    c.string(road.class, `${p}.class`);
    c.boolean(road.divided, `${p}.divided`);
    c.boolean(road.oneway, `${p}.oneway`);
    if (c.array(road.lanes, `${p}.lanes`)) {
      if (road.lanes.length === 0) c.fail(`${p}.lanes`, 'expected at least one lane');
      road.lanes.forEach((lane, j) => {
        const lp = `${p}.lanes[${j}]`;
        if (!c.object(lane, lp)) return;
        claim(lane.id, lp, 'lane');
        c.oneOf(lane.dir, ['forward', 'backward'], `${lp}.dir`);
        if (road.oneway && lane.dir === 'backward') c.fail(`${lp}.dir`, 'one-way roads have only forward lanes');
        c.number(lane.index, `${lp}.index`, { integer: true, min: 0 });
        c.polygon(lane.polygon, `${lp}.polygon`);
        c.polyline(lane.centerline, `${lp}.centerline`);
      });
    }
    if (c.array(road.laneLines, `${p}.laneLines`)) {
      road.laneLines.forEach((line, j) => {
        const lp = `${p}.laneLines[${j}]`;
        if (!c.object(line, lp)) return;
        claim(line.id, lp, 'laneLine');
        c.oneOf(line.type, LANE_LINE_TYPES, `${lp}.type`);
        c.oneOf(line.crossable, CROSSABLE, `${lp}.crossable`);
        c.polyline(line.polyline, `${lp}.polyline`);
        if (line.left !== null) c.string(line.left, `${lp}.left`);
        if (line.right !== null) c.string(line.right, `${lp}.right`);
        if (line.left === null && line.right === null) c.fail(lp, 'needs a lane on at least one side');
      });
    }
  });

  m.junctions.forEach((j, i) => {
    const p = `junctions[${i}]`;
    if (!c.object(j, p)) return;
    claim(j.id, p, 'junction');
    c.polygon(j.polygon, `${p}.polygon`);
    c.stringArray(j.roadIds, `${p}.roadIds`);
    c.boolean(j.signalized, `${p}.signalized`);
    c.boolean(j.roundabout, `${p}.roundabout`);
    c.stringArray(j.priorityRoadIds, `${p}.priorityRoadIds`);
  });

  m.zones.forEach((z, i) => {
    const p = `zones[${i}]`;
    if (!c.object(z, p)) return;
    claim(z.id, p, 'zone');
    c.oneOf(z.type, ZONE_TYPES, `${p}.type`);
    c.polygon(z.polygon, `${p}.polygon`);
    if (c.stringArray(z.laneIds, `${p}.laneIds`) && z.laneIds.length === 0) c.fail(`${p}.laneIds`, 'binds no lane');
    c.stringArray(z.signIds, `${p}.signIds`);
    c.oneOf(z.source, ZONE_SOURCES, `${p}.source`);
    if (z.type === 'speed-limit') {
      c.number(z.valueKmh, `${p}.valueKmh`, { min: 5, max: 120 });
      if (z.source !== 'default' && Array.isArray(z.signIds) && z.signIds.length === 0) {
        c.fail(`${p}.signIds`, 'a signed speed limit needs its sign');
      }
    } else if (z.valueKmh !== undefined) c.fail(`${p}.valueKmh`, 'only speed-limit zones carry a value');
  });

  m.stopLines.forEach((s, i) => {
    const p = `stopLines[${i}]`;
    if (!c.object(s, p)) return;
    claim(s.id, p, 'stopLine');
    c.segment(s.segment, `${p}.segment`);
    c.stringArray(s.laneIds, `${p}.laneIds`);
    c.oneOf(s.control, STOP_CONTROLS, `${p}.control`);
    if (s.control === 'signal') c.string(s.signalId, `${p}.signalId`);
    else if (s.signalId !== undefined) c.fail(`${p}.signalId`, 'only signal-controlled lines name a signal');
  });

  m.signals.forEach((s, i) => {
    const p = `signals[${i}]`;
    if (!c.object(s, p)) return;
    claim(s.id, p, 'signal');
    c.pos2(s.pos, `${p}.pos`);
    c.number(s.heading, `${p}.heading`);
    c.stringArray(s.stopLineIds, `${p}.stopLineIds`);
    if (c.object(s.cycle, `${p}.cycle`)) {
      for (const k of ['green', 'yellow', 'red', 'offset']) c.number(s.cycle[k], `${p}.cycle.${k}`, { min: 0 });
      if (s.cycle.green + s.cycle.yellow + s.cycle.red <= 0) c.fail(`${p}.cycle`, 'period must be positive');
    }
  });

  m.crosswalks.forEach((w, i) => {
    const p = `crosswalks[${i}]`;
    if (!c.object(w, p)) return;
    claim(w.id, p, 'crosswalk');
    c.polygon(w.polygon, `${p}.polygon`);
    if (w.signalId !== undefined) c.string(w.signalId, `${p}.signalId`);
  });

  m.restrictions.forEach((r, i) => {
    const p = `restrictions[${i}]`;
    if (!c.object(r, p)) return;
    claim(r.id, p, 'restriction');
    c.string(r.junctionId, `${p}.junctionId`);
    c.stringArray(r.fromLaneIds, `${p}.fromLaneIds`);
    if (c.array(r.banned, `${p}.banned`)) {
      if (r.banned.length === 0) c.fail(`${p}.banned`, 'bans nothing');
      r.banned.forEach((b, k) => c.oneOf(b, MANOEUVRES, `${p}.banned[${k}]`));
    }
    c.string(r.signId, `${p}.signId`);
  });

  m.entries.forEach((e, i) => {
    const p = `entries[${i}]`;
    if (!c.object(e, p)) return;
    claim(e.id, p, 'entry');
    c.segment(e.segment, `${p}.segment`);
    c.number(e.heading, `${p}.heading`);
    if (c.array(e.bannedClasses, `${p}.bannedClasses`)) {
      if (e.bannedClasses.length === 0) c.fail(`${p}.bannedClasses`, 'bans nothing');
      e.bannedClasses.forEach((b, k) =>
        c.oneOf(b, ENTRY_CLASSES, `${p}.bannedClasses[${k}]`),
      );
    }
    c.string(e.signId, `${p}.signId`);
  });

  m.pavements.forEach((v, i) => {
    const p = `pavements[${i}]`;
    if (!c.object(v, p)) return;
    claim(v.id, p, 'pavement');
    c.polygon(v.polygon, `${p}.polygon`);
  });

  m.signs.forEach((s, i) => {
    const p = `signs[${i}]`;
    if (!c.object(s, p)) return;
    claim(s.id, p, 'sign');
    if (c.string(s.code, `${p}.code`) && options.signCodes && !options.signCodes.includes(s.code)) {
      c.fail(`${p}.code`, `unknown sign code "${s.code}"`);
    }
    if (s.value !== undefined) c.number(s.value, `${p}.value`, { min: 0 });
    c.pos2(s.pos, `${p}.pos`);
    c.number(s.heading, `${p}.heading`);
    c.oneOf(s.source, SIGN_SOURCES, `${p}.source`);
  });

  m.obstacles.forEach((o, i) => {
    const p = `obstacles[${i}]`;
    if (!c.object(o, p)) return;
    claim(o.id, p, 'obstacle');
    c.oneOf(o.kind, OBSTACLE_KINDS, `${p}.kind`);
    c.polygon(o.footprint, `${p}.footprint`);
    c.number(o.height, `${p}.height`, { min: 0 });
  });

  m.actors.forEach((a, i) => {
    const p = `actors[${i}]`;
    if (!c.object(a, p)) return;
    claim(a.id, p, 'actor');
    c.oneOf(a.kind, ACTOR_KINDS, `${p}.kind`);
    c.string(a.model, `${p}.model`);
    c.number(a.lengthM, `${p}.lengthM`, { min: 0.1 });
    c.number(a.widthM, `${p}.widthM`, { min: 0.1 });
    c.polyline(a.path, `${p}.path`);
    c.number(a.speed, `${p}.speed`, { min: 0 });
    c.boolean(a.loop, `${p}.loop`);
    if (c.object(a.trigger, `${p}.trigger`)) {
      const hasPoly = a.trigger.polygon !== undefined;
      const hasTime = a.trigger.atS !== undefined;
      if (hasPoly === hasTime) c.fail(`${p}.trigger`, 'needs exactly one of polygon or atS');
      else if (hasPoly) c.polygon(a.trigger.polygon, `${p}.trigger.polygon`);
      else c.number(a.trigger.atS, `${p}.trigger.atS`, { min: 0 });
    }
  });

  // References.
  /**
   * @param {unknown} id Referenced id.
   * @param {string} kind Expected kind.
   * @param {string} path Path of the reference.
   */
  const ref = (id, kind, path) => {
    if (typeof id !== 'string') return;
    const found = ids.get(id);
    if (found !== kind) c.fail(path, `unknown ${kind} "${id}"`);
  };
  /**
   * @param {unknown} list Referenced ids.
   * @param {string} kind Expected kind.
   * @param {string} path Path.
   */
  const refs = (list, kind, path) => {
    if (Array.isArray(list)) list.forEach((id, k) => ref(id, kind, `${path}[${k}]`));
  };

  m.roads.forEach((road, i) => {
    (road?.laneLines ?? []).forEach((line, j) => {
      const own = new Set((road.lanes ?? []).map((l) => l?.id));
      for (const side of ['left', 'right']) {
        if (typeof line?.[side] === 'string' && !own.has(line[side])) {
          c.fail(`roads[${i}].laneLines[${j}].${side}`, `lane "${line[side]}" is not on this road`);
        }
      }
    });
  });
  m.junctions.forEach((j, i) => {
    refs(j?.roadIds, 'road', `junctions[${i}].roadIds`);
    refs(j?.priorityRoadIds, 'road', `junctions[${i}].priorityRoadIds`);
  });
  m.zones.forEach((z, i) => {
    refs(z?.laneIds, 'lane', `zones[${i}].laneIds`);
    refs(z?.signIds, 'sign', `zones[${i}].signIds`);
  });
  m.stopLines.forEach((s, i) => {
    refs(s?.laneIds, 'lane', `stopLines[${i}].laneIds`);
    ref(s?.signalId, 'signal', `stopLines[${i}].signalId`);
  });
  m.signals.forEach((s, i) =>
    refs(s?.stopLineIds, 'stopLine', `signals[${i}].stopLineIds`),
  );
  m.crosswalks.forEach((w, i) =>
    ref(w?.signalId, 'signal', `crosswalks[${i}].signalId`),
  );
  m.restrictions.forEach((r, i) => {
    ref(r?.junctionId, 'junction', `restrictions[${i}].junctionId`);
    refs(r?.fromLaneIds, 'lane', `restrictions[${i}].fromLaneIds`);
    ref(r?.signId, 'sign', `restrictions[${i}].signId`);
  });
  m.entries.forEach((e, i) => ref(e?.signId, 'sign', `entries[${i}].signId`));

  return c.problems;
}

/**
 * @param {Checker} c Checker.
 * @param {unknown} route Route.
 * @returns {void}
 */
function checkRoute(c, route) {
  if (!c.object(route, 'route')) return;
  const r = /** @type {UntrustedJson} */ (route);
  if (c.object(r.start, 'route.start')) {
    c.pos2(r.start.pos, 'route.start.pos');
    c.number(r.start.heading, 'route.start.heading');
  }
  if (c.array(r.checkpoints, 'route.checkpoints')) {
    r.checkpoints.forEach((cp, i) => {
      if (!c.object(cp, `route.checkpoints[${i}]`)) return;
      c.pos2(cp.pos, `route.checkpoints[${i}].pos`);
      c.number(cp.heading, `route.checkpoints[${i}].heading`);
    });
  }
  if (c.object(r.finish, 'route.finish')) c.polygon(r.finish.polygon, 'route.finish.polygon');
  c.number(r.timeLimitS, 'route.timeLimitS', { min: 1 });
}

/**
 * Throws a `ContractError` listing every problem unless the map is valid.
 * @param {unknown} map Candidate map.
 * @param {MapCheckOptions} [options] Options.
 * @returns {asserts map is import('./map.js').GameMap} Narrowed map.
 */
export function assertMap(map, options) {
  const problems = checkMap(map, options);
  if (problems.length > 0) throw new ContractError('map', problems);
}
