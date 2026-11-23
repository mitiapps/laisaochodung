/**
 * The pure scorer: `createScorer(bundle, map, vehicle)` gives `{initial, step, report}`, and
 * `scoreRun` folds `step` over recorded frames, so live play and replay give identical reports.
 *
 * Per step:
 * 1. A `reset` or `fall` event is a discontinuity: every open episode closes, detector states
 *    start over, and no line-crossing test spans it.
 * 2. The step context is derived once (location, zones, limit, crossings, junction pass).
 * 3. Each applicable rule's detector runs; superseding rules run first. An active rule whose
 *    superseding rule is active this step, or still has an open episode, is dropped.
 * 4. Episodes: a rule turning active opens an episode (a `new` breach); a worse severity inside it
 *    emits an `escalated` breach with the same episode id; it closes after `rearmS` inactive. The
 *    report deducts once per episode, at its worst tier.
 * 5. Collisions take as cause the worst other episode active within `crashCauseWindowS` (not
 *    across a discontinuity) and resolve their clause through the collision policy. A pedestrian
 *    hit ends the run with score 0.
 * 6. `finish`, `timeout` and a pedestrian crash end the run; later frames are ignored.
 */

import { decreeGroupOf } from '../contracts/vehicle.js';
import { initialCore, stepCore } from './context.js';
import { DETECTORS } from './detectors/index.js';
import { resolveBreach, resolveCrash } from './resolve.js';
import { selectTier } from './tiers.js';

/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */
/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').Rule} Rule */
/** @typedef {import('../contracts/index.js').Breach} Breach */
/** @typedef {import('../contracts/index.js').ScoreContext} ScoreContext */
/** @typedef {import('../contracts/index.js').ScoreReport} ScoreReport */
/** @typedef {import('../contracts/index.js').Scorer} Scorer */
/** @typedef {import('./context.js').ScorerEnv} ScorerEnv */
/** @typedef {import('./context.js').CoreState} CoreState */

/**
 * @typedef {object} Episode
 * @property {string} episodeId `<ruleId>@<tick of opening>`.
 * @property {string} ruleId Rule.
 * @property {number} severity Escalation rank of the worst breach so far.
 * @property {number} lastActiveT Last time the rule was active.
 * @property {boolean} open Still open.
 * @property {Breach} breach Worst breach so far.
 */

/**
 * @typedef {object} ScorerState
 * @property {CoreState} core Shared tracking.
 * @property {Record<string, unknown>} detectors Detector state per rule id.
 * @property {Episode[]} episodes Every episode, in opening order.
 * @property {Record<string, number>} openIndex Index into `episodes` of each rule's open episode.
 * @property {number} causeFloorT Causes must be active at or after this time (last discontinuity).
 * @property {null | 'finish' | 'timeout' | 'crash'} ended How the run ended, once it has.
 * @property {boolean} pedestrianHit A pedestrian was hit: the score is 0.
 * @property {ScoreContext} context Last context.
 */

/** @type {ScoreContext} */
const EMPTY_CONTEXT = Object.freeze({
  speedLimitKmh: null,
  speedLimitSource: null,
  speedLimitVerified: true,
  builtUp: false,
  roadId: null,
  laneId: null,
  wrongWay: false,
});

/**
 * Applicable rules in evaluation order: rules that supersede others first, then the rest, each
 * group in bundle order.
 * @param {RulesBundle} bundle Bundle.
 * @param {VehicleInfo} vehicle Vehicle.
 * @returns {Rule[]} Rules.
 */
function orderedRules(bundle, vehicle) {
  const applicable = bundle.rules.filter((r) => /** @type {string[]} */ (r.vehicleClasses).includes(vehicle.legalClass));
  const superseding = applicable.filter((r) => (r.supersedes ?? []).length > 0);
  return [...superseding, ...applicable.filter((r) => !superseding.includes(r))];
}

/**
 * Creates a scorer.
 * @param {RulesBundle} bundle Validated rules bundle.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @returns {Scorer} Scorer.
 */
export function createScorer(bundle, map, vehicleInfo) {
  const group = decreeGroupOf(vehicleInfo.legalClass);
  /** @type {ScorerEnv} */
  const env = {
    bundle,
    map,
    vehicle: vehicleInfo,
    group,
    clausesById: new Map(bundle.clauses.map((c) => [c.id, c])),
    sourcesById: new Map(bundle.sources.map((s) => [s.id, s])),
  };
  const rules = orderedRules(bundle, vehicleInfo);
  for (const r of rules) {
    if (!DETECTORS[r.detection.type]) throw new Error(`Rule ${r.id}: unknown detector "${r.detection.type}"`);
  }
  /** Superseding rule ids per superseded rule id, for this vehicle's decree group. */
  /** @type {Map<string, string[]>} */
  const supersededBy = new Map();
  for (const r of rules) {
    for (const s of r.supersedes ?? []) {
      if (s.decreeGroups && !s.decreeGroups.includes(group)) continue;
      supersededBy.set(s.ruleId, [...(supersededBy.get(s.ruleId) ?? []), r.id]);
    }
  }
  const freshDetectors = () => Object.fromEntries(rules.map((r) => [r.id, DETECTORS[r.detection.type].init()]));

  /** @type {ScorerState} */
  const initial = {
    core: initialCore(),
    detectors: freshDetectors(),
    episodes: [],
    openIndex: {},
    causeFloorT: 0,
    ended: null,
    pedestrianHit: false,
    context: EMPTY_CONTEXT,
  };

  /**
   * @param {unknown} rawState State.
   * @param {Frame} frame Frame.
   * @returns {import('../contracts/index.js').ScorerStep} Step result.
   */
  function step(rawState, frame) {
    const state = /** @type {ScorerState} */ (rawState);
    if (state.ended !== null) {
      return { state, breaches: [], context: state.context, runEnded: state.ended === 'crash' ? 'crash' : null };
    }
    const { core, ctx } = stepCore(env, state.core, frame);
    const { rearmS, crashCauseWindowS } = bundle.scoring;
    let episodes = state.episodes;
    let openIndex = state.openIndex;
    let detectors = state.detectors;
    let causeFloorT = state.causeFloorT;

    if (ctx.discontinuity) {
      episodes = episodes.map((e) => (e.open ? { ...e, open: false } : e));
      openIndex = {};
      detectors = freshDetectors();
      causeFloorT = frame.t;
    }

    /** @type {Record<string, unknown>} */
    const nextDetectors = {};
    /** @type {{rule: Rule, tierIndex: number, severity: number, input: Record<string, unknown>}[]} */
    const active = [];
    for (const rule of rules) {
      const det = DETECTORS[rule.detection.type];
      const res = det.detect(
        /** @type {never} */ (detectors[rule.id]),
        frame,
        ctx,
        /** @type {never} */ (rule.detection.params),
      );
      nextDetectors[rule.id] = res.detectorState;
      if (!res.active) continue;
      const tierIndex = rule.detection.type === 'collision' ? 0 : selectTier(rule, res.tierInput, group);
      if (tierIndex < 0) continue;
      active.push({ rule, tierIndex, severity: res.severity ?? tierIndex, input: res.tierInput });
    }
    const activeIds = new Set(active.map((a) => a.rule.id));
    const kept = active.filter(
      (a) => !(supersededBy.get(a.rule.id) ?? []).some((s) => activeIds.has(s) || openIndex[s] !== undefined),
    );

    /** @type {Breach[]} */
    const breaches = [];
    let pedestrianHit = state.pedestrianHit;
    let ended = /** @type {ScorerState['ended']} */ (null);
    if (kept.length > 0) {
      episodes = [...episodes];
      openIndex = { ...openIndex };
    }
    for (const a of kept) {
      const idx = openIndex[a.rule.id];
      const existing = idx === undefined ? null : episodes[idx];
      if (existing && a.severity <= existing.severity) {
        episodes[/** @type {number} */ (idx)] = { ...existing, lastActiveT: frame.t };
        continue;
      }
      const meta = existing
        ? { episodeId: existing.episodeId, kind: /** @type {const} */ ('escalated') }
        : { episodeId: `${a.rule.id}@${frame.tick}`, kind: /** @type {const} */ ('new') };
      let breach;
      if (a.rule.detection.type === 'collision') {
        const outcome = /** @type {import('./detectors/collision.js').CollisionOutcome} */ (a.input.collision);
        breach = resolveCrash(env, a.rule, outcome, findCause(episodes, a.rule.id, frame.t - crashCauseWindowS, causeFloorT, group), frame, meta);
        if (outcome.kind === 'pedestrian') {
          pedestrianHit = true;
          ended = 'crash';
        }
      } else {
        breach = resolveBreach(env, a.rule, a.tierIndex, frame, meta);
      }
      breaches.push(breach);
      /** @type {Episode} */
      const ep = { episodeId: meta.episodeId, ruleId: a.rule.id, severity: a.severity, lastActiveT: frame.t, open: true, breach };
      if (existing) episodes[/** @type {number} */ (idx)] = ep;
      else {
        openIndex[a.rule.id] = episodes.length;
        episodes.push(ep);
      }
    }

    // Close episodes that stayed inactive for rearmS.
    for (const [ruleId, idx] of Object.entries(openIndex)) {
      const e = episodes[idx];
      if (frame.t - e.lastActiveT >= rearmS - 1e-9) {
        if (episodes === state.episodes) episodes = [...episodes];
        if (openIndex === state.openIndex) openIndex = { ...openIndex };
        episodes[idx] = { ...e, open: false };
        delete openIndex[ruleId];
      }
    }

    if (!ended) {
      if (frame.events.some((e) => e.type === 'finish')) ended = 'finish';
      else if (frame.events.some((e) => e.type === 'timeout')) ended = 'timeout';
    }

    /** @type {ScoreContext} */
    const context = {
      speedLimitKmh: ctx.limit ? ctx.limit.kmh : null,
      speedLimitSource: ctx.limit ? ctx.limit.source : null,
      speedLimitVerified: ctx.limit ? ctx.limit.verified : true,
      builtUp: ctx.builtUp,
      roadId: ctx.loc.roadId,
      laneId: ctx.loc.laneId,
      wrongWay: ctx.against,
    };
    /** @type {ScorerState} */
    const next = { core, detectors: nextDetectors, episodes, openIndex, causeFloorT, ended, pedestrianHit, context };
    return { state: next, breaches, context, runEnded: ended === 'crash' ? 'crash' : null };
  }

  /**
   * @param {unknown} rawState State.
   * @param {{quit: boolean}} options Whether the player quit.
   * @returns {ScoreReport} Report.
   */
  function report(rawState, options) {
    const state = /** @type {ScorerState} */ (rawState);
    return buildReport(state, options);
  }

  return { initial, step, report };
}

/**
 * Worst other episode active since `fromT` (and not before the last discontinuity).
 * @param {Episode[]} episodes Episodes.
 * @param {string} crashRuleId Crash rule id, excluded.
 * @param {number} fromT Window start.
 * @param {number} floorT Last discontinuity.
 * @param {import('../contracts/index.js').DecreeGroup} group Decree group.
 * @returns {import('./resolve.js').CrashCause | null} Cause.
 */
function findCause(episodes, crashRuleId, fromT, floorT, group) {
  /** @type {Episode | null} */
  let best = null;
  for (const e of episodes) {
    if (e.ruleId === crashRuleId || e.lastActiveT < Math.max(fromT, floorT) - 1e-9) continue;
    if (!best || e.breach.danger > best.breach.danger || (e.breach.danger === best.breach.danger && e.lastActiveT >= best.lastActiveT)) {
      best = e;
    }
  }
  if (!best) return null;
  const clauseId = best.breach.clause ? best.breach.clause.id : null;
  return { ruleId: best.ruleId, title: best.breach.title, clauseId: clauseId && clauseId.startsWith(`${group}.`) ? clauseId : null };
}

/**
 * Final (or running) report of a scorer state.
 * @param {ScorerState} state State.
 * @param {{quit: boolean}} options Whether the player quit.
 * @returns {ScoreReport} Report.
 */
function buildReport(state, options) {
  const breaches = state.episodes.map((e) => e.breach);
  const deducted = breaches.reduce((sum, b) => sum + b.deduction, 0);
  const score = state.pedestrianHit ? 0 : Math.max(0, Math.round((10 - deducted) * 100) / 100);
  const maxPoints = breaches.reduce((m, b) => Math.max(m, b.clause ? b.clause.licencePoints : 0), 0);
  const licenceDeducted = Math.min(12, maxPoints);
  const fineTotalVnd = breaches.reduce(
    (acc, b) => (b.clause?.fineVnd ? { min: acc.min + b.clause.fineVnd.min, max: acc.max + b.clause.fineVnd.max } : acc),
    { min: 0, max: 0 },
  );
  // A run that has not ended by finish, timeout or crash was stopped by the player: quit. A
  // caller that reports a still-running run (the HUD's running score) passes quit: false and
  // reads only the score.
  /** @type {ScoreReport['endedBy']} */
  const endedBy = state.ended ?? 'quit';
  void options;
  return {
    score,
    breaches,
    licence: { start: 12, deducted: licenceDeducted, remaining: 12 - licenceDeducted },
    fineTotalVnd,
    finished: endedBy === 'finish',
    endedBy,
  };
}

/**
 * Folds a scorer over frames; equals the live fold.
 * @param {RulesBundle} bundle Bundle.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {Frame[]} frames Frames in tick order.
 * @param {{quit: boolean}} options Whether the player quit after the last frame.
 * @returns {ScoreReport} Report.
 */
export function scoreRun(bundle, map, vehicleInfo, frames, options) {
  const scorer = createScorer(bundle, map, vehicleInfo);
  let state = scorer.initial;
  for (const frame of frames) state = scorer.step(state, frame).state;
  return scorer.report(state, options);
}
