import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  ACTOR_LIGHTS,
  assertFrame,
  assertMap,
  checkFrame,
  checkMap,
  CLAUSE_ID_PATTERN,
  COLLISION_KINDS,
  CAMERA_MODES,
  CONTROL_PRESETS,
  ContractError,
  decreeGroupOf,
  DT,
  KEY_BINDINGS,
  kmhToMps,
  LICENCE_POINT_VALUES,
  mpsToKmh,
  neutralInput,
  NO_VIOLATIONS,
  NPC_VIOLATIONS,
} from './index.js';

/** @typedef {import('./check.js').UntrustedJson} UntrustedJson Parsed fixture JSON. */

const root = new URL('../../', import.meta.url);
/**
 * @param {string} path Repo-relative path.
 * @returns {string} File text.
 */
const read = (path) => readFileSync(new URL(path, root), 'utf8');
/**
 * @param {string} path Repo-relative path.
 * @returns {UntrustedJson} Parsed JSON.
 */
const json = (path) => JSON.parse(read(path));
/**
 * @template T
 * @param {T} v Value.
 * @returns {T} Deep copy.
 */
const clone = (v) => structuredClone(v);

const MAP = json('tests/fixtures/map-minimal.json');
const JUNCTION = json('tests/fixtures/map-junction.json');
const FRAMES = json('tests/fixtures/frames-straight.json');
const SIGNS = YAML.parse(read('data/signs/signs.yaml'));
const SIGN_CODES = SIGNS.map((/** @type {{code: string}} */ s) => s.code);

describe('units', () => {
  it('converts speeds and fixes DT', () => {
    expect(DT).toBeCloseTo(1 / 60, 15);
    expect(kmhToMps(54)).toBeCloseTo(15);
    expect(mpsToKmh(15)).toBeCloseTo(54);
    expect(decreeGroupOf('car')).toBe('D6');
    expect(decreeGroupOf('motorbike')).toBe('D7');
  });
});

describe('key bindings', () => {
  it('covers every action once, with unique keys and Vietnamese labels', () => {
    const actions = KEY_BINDINGS.map((b) => b.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toHaveLength(16);
    const keys = KEY_BINDINGS.flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(KEY_BINDINGS.every((b) => b.label.vi.length > 0)).toBe(true);
    expect(neutralInput()).toMatchObject({ throttle: 0, steer: 0, gearCmd: null, horn: false });
  });

  it('binds no key that needs a modifier, Tab, Enter or a function key', () => {
    const keys = KEY_BINDINGS.flatMap((b) => b.keys);
    for (const key of keys) expect(key, key).not.toMatch(/^(Control|Alt|Meta|Shift|Tab|Enter|F\d+)/u);
  });

  it('fixes the two camera modes, chase first as the default', () => {
    expect(CAMERA_MODES).toEqual(['chase', 'cockpit']);
    expect(Object.isFrozen(CAMERA_MODES)).toBe(true);
  });

  it('fixes the two control presets', () => {
    expect(CONTROL_PRESETS).toEqual(['simple', 'real']);
    expect(Object.isFrozen(CONTROL_PRESETS)).toBe(true);
  });
});

describe('shared pose constants', () => {
  it('freezes the lamp table, its entries and the empty violation list', () => {
    expect(Object.keys(ACTOR_LIGHTS)).toEqual(['off', 'brake', 'left', 'right', 'brake-left', 'brake-right', 'hazard']);
    expect(Object.isFrozen(ACTOR_LIGHTS)).toBe(true);
    for (const e of Object.values(ACTOR_LIGHTS)) expect(Object.isFrozen(e)).toBe(true);
    expect(ACTOR_LIGHTS.hazard).toEqual({ brake: false, left: true, right: true });
    expect(NO_VIOLATIONS).toEqual([]);
    expect(Object.isFrozen(NO_VIOLATIONS)).toBe(true);
    expect(NPC_VIOLATIONS).not.toContain('inattentive');
    expect(COLLISION_KINDS).toContain('motorbike');
  });
});

describe('assertMap', () => {
  it('accepts the minimal map with the sign table codes', () => {
    expect(checkMap(MAP, { signCodes: SIGN_CODES })).toEqual([]);
    expect(() => assertMap(MAP)).not.toThrow();
  });

  /** @type {[string, (m: UntrustedJson) => void, RegExp][]} */
  const broken = [
    ['wrong schema version', (m) => (m.schemaVersion = 2), /schemaVersion/],
    ['duplicate id across collections', (m) => (m.signs[0].id = 'rw-e'), /duplicate id "rw-e"/],
    ['closed ring repeating the first point', (m) => m.junctions[0].polygon.push([96.5, -3.5]), /repeat the first point/],
    ['unknown lane in a zone', (m) => m.zones[1].laneIds.push('nope'), /unknown lane "nope"/],
    ['unknown signal on a stop line', (m) => (m.stopLines[0].signalId = 'sig-x'), /unknown signal "sig-x"/],
    ['signal line without a signal', (m) => delete m.stopLines[0].signalId, /stopLines\[0\]\.signalId/],
    ['lane line pointing at another road', (m) => (m.roads[0].laneLines[0].left = 're-w'), /not on this road/],
    ['backward lane on a one-way road', (m) => (m.roads[3].lanes[0].dir = 'backward'), /one-way/],
    ['speed limit without a value', (m) => delete m.zones[1].valueKmh, /valueKmh/],
    ['non-finite number', (m) => (m.signals[0].pos.x = Number.NaN), /signals\[0\]\.pos\.x/],
    ['trigger with both forms', (m) => (m.actors[1].trigger.polygon = [[0, 0], [1, 0], [1, 1]]), /exactly one/],
    ['unknown sign code', (m) => (m.signs[0].code = 'P.999'), /unknown sign code/],
    ['OSM map without attribution', (m) => (m.kind = 'osm'), /attribution/],
    ['missing collection', (m) => delete m.entries, /entries/],
    ['building fields on a barrier', (m) => Object.assign(m.obstacles.find((/** @type {UntrustedJson} */ o) => o.kind !== 'building') ?? m.obstacles[0], { kind: 'barrier', floors: 2 }), /only buildings carry floors/],
  ];
  it.each(broken)('rejects %s', (_, mutate, pattern) => {
    const m = clone(MAP);
    mutate(m);
    const problems = checkMap(m, { signCodes: SIGN_CODES });
    expect(problems.join('\n')).toMatch(pattern);
    expect(() => assertMap(m, { signCodes: SIGN_CODES })).toThrow(ContractError);
  });
});

describe('assertMap with a lane graph and traffic', () => {
  it('accepts the junction fixture', () => {
    expect(checkMap(JUNCTION, { signCodes: SIGN_CODES })).toEqual([]);
  });

  it('junction fixture geometry: connectors join lane ends, conflict zones lie on their connectors', () => {
    /** @type {Map<string, UntrustedJson>} */
    const lanes = new Map(JUNCTION.roads.flatMap((/** @type {UntrustedJson} */ r) => r.lanes.map((/** @type {UntrustedJson} */ l) => [l.id, l])));
    /**
     * @param {number[][]} pts Polyline.
     * @returns {number} Length.
     */
    const length = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    /** @type {Map<string, number>} */
    const lengths = new Map();
    for (const k of JUNCTION.connectors) {
      expect(k.centerline[0]).toEqual(lanes.get(k.fromLaneId).centerline.at(-1));
      expect(k.centerline.at(-1)).toEqual(lanes.get(k.toLaneId).centerline[0]);
      lengths.set(k.id, length(k.centerline));
    }
    for (const c of JUNCTION.conflicts) {
      expect(c.aToS).toBeLessThanOrEqual(/** @type {number} */ (lengths.get(c.a)) + 1e-3);
      expect(c.bToS).toBeLessThanOrEqual(/** @type {number} */ (lengths.get(c.b)) + 1e-3);
    }
    expect(new Set(JUNCTION.conflicts.map((/** @type {UntrustedJson} */ c) => c.kind))).toEqual(new Set(['cross', 'merge']));
    const kerbArm = JUNCTION.roads.find((/** @type {UntrustedJson} */ r) => r.id === 'rw');
    expect(kerbArm.lanes.filter((/** @type {UntrustedJson} */ l) => l.dir === 'forward')).toHaveLength(2);
    const sourced = new Set(JUNCTION.traffic.sources.map((/** @type {UntrustedJson} */ s) => s.laneId));
    for (const id of JUNCTION.traffic.sinks) expect(sourced.has(id)).toBe(false);
  });

  it('accepts plain lane joins from lanes that start no connector', () => {
    const m = clone(JUNCTION);
    const starts = new Set(m.connectors.map((/** @type {UntrustedJson} */ k) => k.fromLaneId));
    const free = m.roads.flatMap((/** @type {UntrustedJson} */ r) => r.lanes).filter((/** @type {UntrustedJson} */ l) => !starts.has(l.id));
    m.laneJoins = [{ fromLaneId: free[0].id, toLaneId: free[1].id }];
    expect(checkMap(m, { signCodes: SIGN_CODES })).toEqual([]);
  });

  it('accepts building fields on a building', () => {
    const m = clone(MAP);
    const b = m.obstacles.find((/** @type {UntrustedJson} */ o) => o.kind === 'building');
    if (b) Object.assign(b, { use: 'landmark', floors: 4, frontEdge: 0, colour: '#b5543c' });
    expect(checkMap(m)).toEqual([]);
  });

  /** @type {[string, (m: UntrustedJson) => void, RegExp][]} */
  const broken = [
    ['connector to an unknown lane', (m) => (m.connectors[0].toLaneId = 'nope'), /connectors\[0\]\.toLaneId: unknown lane "nope"/],
    ['connector in an unknown junction', (m) => (m.connectors[0].junctionId = 'j-x'), /unknown junction "j-x"/],
    ['connector with a bad turn', (m) => (m.connectors[0].turn = 'sideways'), /connectors\[0\]\.turn/],
    ['conflict with an unknown connector', (m) => (m.conflicts[0].b = 'c-x'), /conflicts\[0\]\.b: unknown connector "c-x"/],
    ['conflict range reversed', (m) => (m.conflicts[0].aToS = m.conflicts[0].aFromS - 1), /aToS: must not be below aFromS/],
    ['conflict with itself', (m) => (m.conflicts[0].b = m.conflicts[0].a), /cannot conflict with itself/],
    ['mix shares not summing to 1', (m) => (m.traffic.mix[0].share = 0.5), /traffic\.mix: shares sum/],
    ['source on an unknown lane', (m) => (m.traffic.sources[0].laneId = 'nope'), /traffic\.sources\[0\]\.laneId: unknown lane/],
    ['sink on an unknown lane', (m) => m.traffic.sinks.push('nope'), /traffic\.sinks\[\d+\]: unknown lane/],
    ['density for an unknown road', (m) => (m.traffic.densityPerKm.nope = 10), /densityPerKm\.nope: unknown road/],
    ['inverted spawn ring', (m) => (m.traffic.spawnRingM = [150, 60]), /outer radius/],
    ['negative seed', (m) => (m.traffic.seed = -1), /traffic\.seed/],
    ['prop with an unknown kind', (m) => m.props.push({ id: 'p-x', kind: 'statue', pos: { x: 0, z: 0 }, heading: 0, solid: true }), /props\[\d+\]\.kind/],
    ['duplicate id across new collections', (m) => (m.conflicts[0].id = m.connectors[0].id), /duplicate id/],
    ['connectors that is not a list', (m) => (m.connectors = {}), /connectors: expected an array/],
    ['lane join from an unknown lane', (m) => (m.laneJoins = [{ fromLaneId: 'nope', toLaneId: m.connectors[0].toLaneId }]), /laneJoins\[0\]\.fromLaneId: unknown lane "nope"/],
    ['lane join to itself', (m) => (m.laneJoins = [{ fromLaneId: m.connectors[0].toLaneId, toLaneId: m.connectors[0].toLaneId }]), /cannot join itself/],
    ['lane join from a connector approach', (m) => (m.laneJoins = [{ fromLaneId: m.connectors[0].fromLaneId, toLaneId: m.connectors[0].toLaneId }]), /also starts a connector/],
    [
      'two lane joins into one lane',
      (m) => {
        const starts = new Set(m.connectors.map((/** @type {UntrustedJson} */ k) => k.fromLaneId));
        const free = m.roads.flatMap((/** @type {UntrustedJson} */ r) => r.lanes).filter((/** @type {UntrustedJson} */ l) => !starts.has(l.id));
        m.laneJoins = [{ fromLaneId: free[0].id, toLaneId: free[2].id }, { fromLaneId: free[1].id, toLaneId: free[2].id }];
      },
      /already starts at a join/,
    ],
    [
      'building colour that is not #rrggbb',
      (m) => Object.assign(m.obstacles.find((/** @type {UntrustedJson} */ o) => o.kind === 'building'), { colour: 'red' }),
      /obstacles\[\d+\]\.colour: expected #rrggbb/,
    ],
    ['lane joins that is not a list', (m) => (m.laneJoins = {}), /laneJoins: expected an array/],
  ];
  it.each(broken)('rejects %s', (_, mutate, pattern) => {
    const m = clone(JUNCTION);
    mutate(m);
    expect(checkMap(m).join('\n')).toMatch(pattern);
  });
});

describe('assertFrame', () => {
  it('accepts every committed straight-run frame, read from JSON', () => {
    expect(FRAMES).toHaveLength(120);
    for (const f of FRAMES) assertFrame(f, { parsed: true });
  });

  it('requires the shared lamp and violation objects unless the frame was parsed', () => {
    const f = clone(FRAMES[0]);
    expect(checkFrame(f).join('\n')).toMatch(/actors\[0\]\.lights: expected one of the shared ACTOR_LIGHTS objects/);
    expect(checkFrame(f).join('\n')).toMatch(/actors\[0\]\.violations: expected a shared frozen array/);
    for (const a of f.actors) {
      a.lights = ACTOR_LIGHTS.off;
      a.violations = NO_VIOLATIONS;
    }
    expect(checkFrame(f)).toEqual([]);
  });

  it('accepts collision events with and without the traffic fields', () => {
    const f = clone(FRAMES[0]);
    const base = { type: 'collision', otherKind: 'motorbike', otherId: 'npc-3', impulse: 1, egoSpeed: 2, relSpeed: 2, sameLaneAhead: false };
    f.events.push(base, { ...base, otherModel: 'motorbike', striker: 'both', otherFromBehind: true, otherViolations: ['red-light', 'speeding'] });
    expect(checkFrame(f, { parsed: true })).toEqual([]);
  });

  /** @type {[string, (f: UntrustedJson) => void, RegExp][]} */
  const broken = [
    ['NaN speed', (f) => (f.ego.speed = Number.NaN), /ego\.speed/],
    ['unknown gear', (f) => (f.ego.gear = 6), /ego\.gear/],
    ['three-corner footprint', (f) => f.ego.footprint.pop(), /4 corners/],
    ['flashing light state', (f) => (f.trafficLights['sig-w'] = 'flashing-yellow'), /trafficLights\.sig-w/],
    ['old signals field name', (f) => (f.ego.indicators = undefined), /ego\.indicators/],
    ['unknown event', (f) => f.events.push({ type: 'quit' }), /events\[1\]\.type/],
    ['collision without speeds', (f) => f.events.push({ type: 'collision', otherKind: 'car', otherId: 'npc-1', impulse: 1, sameLaneAhead: false }), /egoSpeed/],
    ['clock at 1440', (f) => (f.env.clockMin = 1440), /clockMin/],
    ['throttle above 1', (f) => (f.ego.input.throttle = 2), /throttle/],
    ['unknown pose kind', (f) => (f.actors[0].kind = 'bicycle'), /actors\[0\]\.kind/],
    ['pose without a model', (f) => delete f.actors[0].model, /actors\[0\]\.model/],
    ['fractional variant', (f) => (f.actors[0].variant = 0.5), /actors\[0\]\.variant/],
    ['lamp state outside the table', (f) => (f.actors[0].lights = { brake: true, left: true, right: true }), /actors\[0\]\.lights/],
    ['unknown pose state', (f) => (f.actors[0].state = 'parked'), /actors\[0\]\.state/],
    ['inattention as a violation', (f) => (f.actors[0].violations = ['inattentive']), /actors\[0\]\.violations\[0\]/],
    ['a flag listed twice', (f) => (f.actors[0].violations = ['speeding', 'speeding']), /lists a flag twice/],
    ['unknown striker', (f) => f.events.push({ type: 'collision', otherKind: 'car', otherId: 'npc-1', impulse: 1, egoSpeed: 1, relSpeed: 1, sameLaneAhead: false, striker: 'nobody' }), /events\[1\]\.striker/],
  ];
  it.each(broken)('rejects %s', (_, mutate, pattern) => {
    const f = clone(FRAMES[0]);
    mutate(f);
    expect(checkFrame(f, { parsed: true }).join('\n')).toMatch(pattern);
    expect(() => assertFrame(f, { parsed: true })).toThrow(ContractError);
  });
});

describe('legal fixtures', () => {
  const rule = YAML.parse(read('tests/fixtures/rule-sample.yaml'));
  const clauses = YAML.parse(read('tests/fixtures/clauses-sample.yaml'));
  const bundle = json('tests/fixtures/rules-bundle.json');

  it('every tier of the sample rule resolves to a sample clause', () => {
    const ids = new Set(clauses.map((/** @type {{id: string}} */ c) => c.id));
    expect(rule.tiers).toHaveLength(2);
    for (const tier of rule.tiers) {
      expect(tier.scoreOnly).toBe(false);
      expect(ids.has(tier.clause.D6)).toBe(true);
    }
    for (const param of Object.keys(rule.detection.params)) {
      expect(['legal', 'design']).toContain(rule.detection.paramBasis[param]);
    }
  });

  it('clause records are well formed and one carries an amendment', () => {
    for (const c of clauses) {
      expect(c.id).toMatch(CLAUSE_ID_PATTERN);
      expect('D6.12').toMatch(CLAUSE_ID_PATTERN);
      expect(LICENCE_POINT_VALUES).toContain(c.licencePoints);
      expect(c.citation.quote.length).toBeGreaterThan(10);
      expect(typeof c.verified).toBe('boolean');
      expect(c.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(clauses.filter((/** @type {{amendments?: unknown[]}} */ c) => c.amendments?.length)).toHaveLength(1);
  });

  it('the bundle cites only its own sources and its rules point at its clauses', () => {
    const sourceIds = new Set(bundle.sources.map((/** @type {{id: string}} */ s) => s.id));
    const citations = [
      ...bundle.clauses.flatMap((/** @type {UntrustedJson} */ c) => [c.citation, ...(c.amendments ?? [])]),
      ...bundle.rules.flatMap((/** @type {UntrustedJson} */ r) => r.obligation),
      ...bundle.speedDefaults.map((/** @type {UntrustedJson} */ d) => d.citation),
      ...bundle.signs.map((/** @type {UntrustedJson} */ s) => s.citation),
    ];
    for (const c of citations) expect(sourceIds.has(c.sourceId)).toBe(true);
    const clauseIds = new Set(bundle.clauses.map((/** @type {{id: string}} */ c) => c.id));
    for (const r of bundle.rules) for (const t of r.tiers) expect(clauseIds.has(t.clause.D6)).toBe(true);
    for (const id of [...bundle.collisionPolicy.accidentBList.D6, ...bundle.collisionPolicy.accidentBList.D7]) {
      expect(id).toMatch(CLAUSE_ID_PATTERN);
    }
    expect(bundle.speedDefaults.every((/** @type {{verified: boolean}} */ d) => d.verified === false)).toBe(true);
  });

  it('the sign table holds exactly the MVP codes, each with a quote', () => {
    expect(SIGN_CODES).toEqual([
      'P.101', 'P.102', 'P.123a', 'P.124a', 'P.127', 'DP.134', 'P.130', 'R.122', 'R.420', 'W.208', 'I.401', 'I.407a',
    ]);
    for (const s of SIGNS) {
      expect(s.citation.sourceId).toBe('qcvn41-2024');
      expect(s.citation.quote.length).toBeGreaterThan(10);
      expect(typeof s.verified).toBe('boolean');
    }
  });
});

describe('catalog and HUD fixtures', () => {
  it('vehicle catalog matches VehicleInfo', () => {
    const vehicles = json('data/vehicles/vehicles.json');
    expect(vehicles.map((/** @type {{id: string}} */ v) => v.id)).toEqual(['car-sedan', 'scooter']);
    for (const v of vehicles) {
      expect(decreeGroupOf(v.legalClass)).toBe(v.decreeGroup);
      expect(v.lengthM).toBeGreaterThan(v.widthM);
      expect(['manual', 'auto']).toContain(v.gearbox);
    }
  });

  it('gives every vehicle that is not a car an automatic gearbox, as the gear keys assume', () => {
    // The input turns the gear keys off for anything but a car; a manual motorbike would be left
    // with no way to change gear.
    const vehicles = json('data/vehicles/vehicles.json');
    for (const v of vehicles.filter((/** @type {{legalClass: string}} */ x) => x.legalClass !== 'car')) {
      expect(v.gearbox, v.id).toBe('auto');
    }
  });

  it('map index and credits have two entries each', () => {
    expect(json('tests/fixtures/maps-index.json')).toHaveLength(2);
    const credits = json('tests/fixtures/credits.json');
    expect(credits).toHaveLength(2);
    expect(credits.some((/** @type {{ownWork: boolean}} */ c) => c.ownWork)).toBe(true);
  });

  it('HUD states cover the badge cases and a finished report', () => {
    const hud = json('tests/fixtures/hud-states.json');
    expect(Object.keys(hud)).toEqual(['ready', 'running', 'withToasts', 'paused', 'finished']);
    const toasts = hud.withToasts.toasts;
    expect(toasts.some((/** @type {UntrustedJson} */ b) => b.clause && !b.clause.verified)).toBe(true);
    expect(toasts.some((/** @type {UntrustedJson} */ b) => b.inferred)).toBe(true);
    expect(toasts.some((/** @type {UntrustedJson} */ b) => b.designParams.length > 0)).toBe(true);
    expect(toasts.some((/** @type {UntrustedJson} */ b) => b.scoreOnly && b.clause === null)).toBe(true);
    expect(toasts.some((/** @type {UntrustedJson} */ b) => b.clause?.amendments?.length)).toBe(true);
    const report = hud.finished.report;
    const deducted = report.breaches.reduce((/** @type {number} */ s, /** @type {UntrustedJson} */ b) => s + b.deduction, 0);
    expect(report.score).toBeCloseTo(10 - deducted);
    expect(report.licence.remaining).toBe(report.licence.start - report.licence.deducted);
    expect(hud.withToasts.notices).toHaveLength(1);
    expect(hud.withToasts.notices[0]).toMatchObject({ kind: 'npc-fault', otherKind: 'motorbike', violations: ['red-light'] });
    expect(report.notices).toEqual(hud.withToasts.notices);
    for (const state of Object.values(hud)) {
      expect(Array.isArray(state.notices)).toBe(true);
      expect(CONTROL_PRESETS).toContain(state.controlPreset);
      expect(typeof state.headingRad).toBe('number');
      expect(Object.keys(state.controls).sort()).toEqual(['brakeFront', 'brakeRear', 'handbrake', 'steer', 'throttle']);
    }
    for (const b of [...toasts, ...report.breaches]) {
      const ids = (b.clause?.amendments ?? []).map((/** @type {UntrustedJson} */ a) => a.sourceId);
      expect(b.amendmentSources.map((/** @type {UntrustedJson} */ s) => s.sourceId)).toEqual([...new Set(ids)]);
    }
    const episodes = report.breaches.map((/** @type {UntrustedJson} */ b) => b.episodeId);
    expect(new Set(episodes).size).toBe(episodes.length);
  });
});
