import { describe, expect, it } from 'vitest';
import { DT } from '../contracts/index.js';
import { buildFrames } from '../testing/index.js';
import { mapVariant, minimalMap, realBundle, scoreScript, summary, vehicle } from '../../scripts/rules/lib/test-support.js';
import { createScorer, scoreRun } from './index.js';
import { resolveBreach } from './resolve.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').FrameEvent} FrameEvent */

const MAP = minimalMap();
/** Straight through the junction to the finish. */
/** @type {[number, number][]} */
const STRAIGHT = [[5, 1.75], [195, 1.75]];

/**
 * The minimal map with no actors, for runs that must not meet anyone.
 * @returns {GameMap} Map.
 */
function emptyMap() {
  return mapVariant((m) => {
    m.actors = [];
  });
}

/**
 * Collision event.
 * @param {Partial<import('../contracts/index.js').CollisionEvent>} e Fields.
 * @returns {FrameEvent} Event.
 */
function hit(e) {
  return { type: 'collision', otherKind: 'car', otherId: null, impulse: 500, egoSpeed: 5, relSpeed: 5, sameLaneAhead: false, ...e };
}

describe('scorer core', () => {
  it('scores a clean run to the finish 10 with endedBy finish', async () => {
    const { report } = await scoreScript({ map: emptyMap(), path: STRAIGHT, speed: 15 });
    expect(report).toEqual({
      score: 10,
      breaches: [],
      licence: { start: 12, deducted: 0, remaining: 12 },
      fineTotalVnd: { min: 0, max: 0 },
      finished: true,
      endedBy: 'finish',
    });
  });

  it('equals scoreRun, and gives byte-equal JSON when run twice', async () => {
    const script = { map: MAP, path: STRAIGHT, speed: 15 };
    const a = await scoreScript(script);
    const b = await scoreScript(script);
    const replay = scoreRun(await realBundle(), MAP, vehicle('car-sedan'), a.frames, { quit: false });
    expect(replay).toEqual(a.report);
    expect(JSON.stringify(b.report)).toBe(JSON.stringify(a.report));
    // The fixture pedestrian is on the zebra when the car reaches it at 15 m/s.
    expect(summary(a.report)).toEqual(['crosswalk-yield:0:D6.1.a']);
  });

  it('does not mutate its inputs', async () => {
    const bundle = await realBundle();
    const frozen = JSON.stringify(bundle);
    const frames = buildFrames({ map: MAP, vehicle: vehicle('car-sedan'), path: STRAIGHT, speed: 15, durationS: 3 });
    const framesJson = JSON.stringify(frames);
    const scorer = createScorer(bundle, MAP, vehicle('car-sedan'));
    let state = scorer.initial;
    const initialJson = JSON.stringify(scorer.initial);
    for (const f of frames) state = scorer.step(state, f).state;
    expect(JSON.stringify(bundle)).toBe(frozen);
    expect(JSON.stringify(frames)).toBe(framesJson);
    expect(JSON.stringify(scorer.initial)).toBe(initialJson);
  });

  it('ends by timeout and by quit', async () => {
    const timeout = await scoreScript({ map: emptyMap(), laneId: 'rw-e', startS: 5, speed: 0, durationS: 121 });
    expect(timeout.report.endedBy).toBe('timeout');
    expect(timeout.report.finished).toBe(false);
    const quit = await scoreScript({ map: emptyMap(), laneId: 'rw-e', startS: 5, speed: 10, durationS: 2, quit: true });
    expect(quit.report.endedBy).toBe('quit');
    const bundle = await realBundle();
    const car = vehicle('car-sedan');
    expect(scoreRun(bundle, emptyMap(), car, timeout.frames, { quit: false })).toEqual(timeout.report);
    expect(scoreRun(bundle, emptyMap(), car, quit.frames, { quit: true })).toEqual(quit.report);
  });

  it('ends by crash on a pedestrian hit, scores 0 and ignores later frames', async () => {
    const script = {
      map: emptyMap(),
      laneId: 'rw-e',
      startS: 5,
      speed: 10,
      durationS: 4,
      events: [{ t: 1, event: hit({ otherKind: 'pedestrian', otherId: 'p', impulse: 300 }) }],
    };
    const { report, frames, live } = await scoreScript(script);
    expect(report.endedBy).toBe('crash');
    expect(report.score).toBe(0);
    expect(summary(report)).toEqual(['crash:1:D6.10.a']);
    expect(report.licence).toEqual({ start: 12, deducted: 10, remaining: 2 });
    const tick = Math.round(1 / DT);
    expect(live[tick].map((b) => b.ruleId)).toEqual(['crash']);
    expect(live.slice(tick + 1).flat()).toEqual([]);
    expect(scoreRun(await realBundle(), script.map, vehicle('car-sedan'), frames, { quit: true })).toEqual(report);
    const scorer = createScorer(await realBundle(), script.map, vehicle('car-sedan'));
    let state = scorer.initial;
    let last = null;
    for (const f of frames) last = scorer.step(state, f), (state = last.state);
    expect(last?.runEnded).toBe('crash');
  });

  it('re-arms an episode only after rearmS clear', async () => {
    const over = 60 / 3.6;
    const ok = 45 / 3.6;
    const short = await scoreScript({
      map: emptyMap(),
      laneId: 'rw-e',
      startS: 5,
      durationS: 7,
      speed: [
        { t: 0, value: over },
        { t: 2, value: over },
        { t: 2.01, value: ok },
        { t: 3, value: ok },
        { t: 3.01, value: over },
      ],
    });
    expect(summary(short.report)).toEqual(['speeding:1:D6.5.đ']);
    const long = await scoreScript({
      map: emptyMap(),
      path: STRAIGHT,
      durationS: 9,
      speed: [
        { t: 0, value: 57 / 3.6 },
        { t: 2, value: 57 / 3.6 },
        { t: 2.01, value: ok },
        { t: 5.5, value: ok },
        { t: 5.51, value: 57 / 3.6 },
      ],
    });
    expect(summary(long.report)).toEqual(['speeding:0:D6.3.a', 'speeding:0:D6.3.a']);
    expect(long.report.score).toBe(9.5);
    expect(long.report.fineTotalVnd).toEqual({ min: 1600000, max: 2000000 });
  });

  it('escalates inside one episode and deducts once at the worst tier', async () => {
    const { report, live } = await scoreScript({
      map: emptyMap(),
      laneId: 'rw-e',
      startS: 5,
      durationS: 4,
      speed: [
        { t: 0, value: 57 / 3.6 },
        { t: 2, value: 57 / 3.6 },
        { t: 2.01, value: 75 / 3.6 },
      ],
    });
    const emitted = live.flat();
    expect(emitted.map((b) => [b.kind, b.tierIndex])).toEqual([['new', 0], ['escalated', 2]]);
    expect(new Set(emitted.map((b) => b.episodeId)).size).toBe(1);
    expect(summary(report)).toEqual(['speeding:2:D6.6.a']);
    expect(report.score).toBe(9);
    expect(report.licence.deducted).toBe(4);
  });

  it('closes episodes and forgets positions at a reset or fall', async () => {
    const { report } = await scoreScript({
      map: emptyMap(),
      laneId: 'rw-e',
      startS: 5,
      durationS: 5,
      speed: 60 / 3.6,
      events: [{ t: 2.5, event: { type: 'reset' } }],
    });
    expect(summary(report)).toEqual(['speeding:1:D6.5.đ', 'speeding:1:D6.5.đ']);
    const fall = await scoreScript({
      map: emptyMap(),
      vehicleId: 'scooter',
      laneId: 'rw-e',
      startS: 5,
      durationS: 2,
      speed: 5,
      events: [{ t: 1, event: { type: 'fall' } }],
    });
    expect(summary(fall.report)).toEqual(['crash:1:-']);
    expect(fall.report.breaches[0].scoreOnly).toBe(true);
    expect(fall.report.score).toBe(6);
  });

  it('escalates the crash episode when a contact knocks the rider over', async () => {
    const { report, live } = await scoreScript({
      map: emptyMap(),
      vehicleId: 'scooter',
      laneId: 'rw-e',
      startS: 5,
      durationS: 3,
      speed: 5,
      events: [
        { t: 1, event: hit({ relSpeed: 2 }) },
        { t: 1.5, event: { type: 'fall' } },
      ],
    });
    expect(summary(report)).toEqual(['crash:1:-']);
    const emitted = live.flat();
    expect(emitted.map((b) => b.kind)).toEqual(['new', 'escalated']);
    expect(new Set(emitted.map((b) => b.episodeId)).size).toBe(1);
    expect(report.score).toBe(6);
  });
});

describe('crash cause on the same step', () => {
  /**
   * Tick on which the fixture pedestrian's crosswalk-yield breach opens on a straight run at 15 m/s.
   * @returns {Promise<number>} Tick index.
   */
  async function causeTick() {
    const { live } = await scoreScript({ map: MAP, path: STRAIGHT, speed: 15, durationS: 8 });
    const tick = live.findIndex((bs) => bs.some((b) => b.ruleId === 'crosswalk-yield'));
    expect(tick).toBeGreaterThan(0);
    return tick;
  }

  it('finds a cause that opens on the same tick as a pedestrian hit', async () => {
    const tick = await causeTick();
    const { report, live } = await scoreScript({
      map: MAP,
      path: STRAIGHT,
      speed: 15,
      durationS: 8,
      events: [{ t: tick * DT, event: hit({ otherKind: 'pedestrian', otherId: 'p', relSpeed: 15, egoSpeed: 15 }) }],
    });
    expect(live[tick].map((b) => b.ruleId)).toEqual(['crosswalk-yield', 'crash']);
    expect(summary(report)).toEqual(['crosswalk-yield:0:D6.1.a', 'crash:1:D6.10.b']);
    const [cause, crash] = report.breaches;
    expect(crash.cause).toBe('crosswalk-yield');
    expect(crash.causeEpisodeId).toBe(cause.episodeId);
    expect(cause.fineAbsorbedBy).toBe(crash.episodeId);
    expect(report.fineTotalVnd).toEqual(crash.clause?.fineVnd);
  });

  it('keeps the cause when a pedestrian hit and a fall share a tick', async () => {
    const tick = (await causeTick()) + 5;
    const { report } = await scoreScript({
      map: MAP,
      path: STRAIGHT,
      speed: 15,
      durationS: 8,
      events: [
        { t: tick * DT, event: hit({ otherKind: 'pedestrian', otherId: 'p', relSpeed: 15, egoSpeed: 15 }) },
        { t: tick * DT, event: { type: 'fall' } },
      ],
    });
    expect(summary(report)).toEqual(['crosswalk-yield:0:D6.1.a', 'crash:1:D6.10.b']);
    expect(report.breaches[1].cause).toBe('crosswalk-yield');
  });
});

describe('breach resolution', () => {
  it('resolves clause, source, flags and design parameters for the UI', async () => {
    const { report } = await scoreScript({ map: emptyMap(), laneId: 'rw-e', startS: 5, durationS: 3, speed: 57 / 3.6 });
    const b = report.breaches[0];
    expect(b).toMatchObject({
      ruleId: 'speeding',
      title: { vi: 'Chạy quá tốc độ quy định' },
      danger: 1,
      deduction: 0.25,
      inferred: false,
      scoreOnly: false,
      designParams: ['sustainS'],
      source: { number: '168/2024/NĐ-CP' },
      kind: 'new',
    });
    expect(b.clause?.fineVnd).toEqual({ min: 800000, max: 1000000 });
    expect(b.amendmentSources).toEqual([]);
    expect(b.tick).toBe(60);
    expect(b.pos.x).toBeCloseTo(5 + 60 * DT * (57 / 3.6), 6);
  });
});

describe('amendment sources and speed-limit context', () => {
  it('names the source of each amendment of the resolved clause once', async () => {
    const bundle = await realBundle();
    const rule = bundle.rules.find((r) => r.tiers.some((t) => t.clause?.D6 === 'D6.2.a'));
    if (!rule) throw new Error('no rule cites D6.2.a');
    const tierIndex = rule.tiers.findIndex((t) => t.clause?.D6 === 'D6.2.a');
    const env = {
      bundle,
      map: MAP,
      vehicle: vehicle('car-sedan'),
      group: /** @type {const} */ ('D6'),
      clausesById: new Map(bundle.clauses.map((c) => [c.id, c])),
      sourcesById: new Map(bundle.sources.map((s) => [s.id, s])),
    };
    const [frame] = buildFrames({ map: MAP, vehicle: vehicle('car-sedan'), path: STRAIGHT, speed: 10, durationS: DT });
    const b = resolveBreach(env, rule, tierIndex, frame, { episodeId: 'e', kind: 'new' });
    const ids = (b.clause?.amendments ?? []).map((a) => a.sourceId);
    expect(ids.length).toBeGreaterThan(0);
    expect(b.amendmentSources.map((s) => s.sourceId)).toEqual([...new Set(ids)]);
    expect(b.amendmentSources[0]).toMatchObject({ sourceId: 'nd238-2026', number: '238/2026/NĐ-CP' });
  });

  it('reports where the limit comes from and whether it is verified', async () => {
    const bundle = await realBundle();
    const veh = vehicle('car-sedan');
    // Frame 60 is at x 15, inside the fixture's P.127 50 km/h zone (x 10 to 96.5).
    const frames = buildFrames({ map: emptyMap(), vehicle: veh, laneId: 'rw-e', startS: 5, durationS: 3, speed: 10 });
    const scorer = createScorer(bundle, emptyMap(), veh);
    expect(scorer.step(scorer.initial, frames[60]).context).toMatchObject({ speedLimitKmh: 50, speedLimitSource: 'sign', speedLimitVerified: true });
    const off = createScorer(bundle, mapVariant((m) => {
      m.actors = [];
      m.zones = m.zones.filter((z) => z.type !== 'speed-limit');
    }), veh);
    const ctx = off.step(off.initial, frames[60]).context;
    const row = bundle.speedDefaults.find((d) => d.legalClass === 'car' && d.builtUp && d.maxKmh === ctx.speedLimitKmh);
    expect(ctx.speedLimitSource).toBe('default');
    expect(ctx.speedLimitVerified).toBe(row?.verified);
  });
});
