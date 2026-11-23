import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  assertFrame,
  assertMap,
  checkFrame,
  checkMap,
  CLAUSE_ID_PATTERN,
  ContractError,
  decreeGroupOf,
  DT,
  KEY_BINDINGS,
  kmhToMps,
  LICENCE_POINT_VALUES,
  mpsToKmh,
  neutralInput,
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
    expect(actions).toHaveLength(14);
    const keys = KEY_BINDINGS.flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(KEY_BINDINGS.every((b) => b.label.vi.length > 0)).toBe(true);
    expect(neutralInput()).toMatchObject({ throttle: 0, steer: 0, gearCmd: null, horn: false });
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
  ];
  it.each(broken)('rejects %s', (_, mutate, pattern) => {
    const m = clone(MAP);
    mutate(m);
    const problems = checkMap(m, { signCodes: SIGN_CODES });
    expect(problems.join('\n')).toMatch(pattern);
    expect(() => assertMap(m, { signCodes: SIGN_CODES })).toThrow(ContractError);
  });
});

describe('assertFrame', () => {
  it('accepts every committed straight-run frame', () => {
    expect(FRAMES).toHaveLength(120);
    for (const f of FRAMES) assertFrame(f);
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
  ];
  it.each(broken)('rejects %s', (_, mutate, pattern) => {
    const f = clone(FRAMES[0]);
    mutate(f);
    expect(checkFrame(f).join('\n')).toMatch(pattern);
    expect(() => assertFrame(f)).toThrow(ContractError);
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
    for (const state of Object.values(hud)) {
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
