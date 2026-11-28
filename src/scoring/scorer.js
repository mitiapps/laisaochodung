/**
 * The pure scorer: `createScorer(bundle, map, vehicle)` gives `{initial, step, report}`, and
 * `scoreRun` folds `step` over recorded frames, so live play and replay give identical reports.
 *
 * Per step:
 * 1. A `reset` or `fall` event is a discontinuity: every open episode closes, detector states
 *    start over, and no line-crossing test spans it. A `fall` alone leaves the crash episode open,
 *    so a contact that knocks the rider over escalates one episode instead of opening a second.
 * 2. The step context is derived once (location, zones, limit, crossings, junction pass).
 * 3. Each applicable rule's detector runs; superseding rules run first and the collision rule
 *    last, so a crash sees every cause that opens or escalates on the same step. Supersession
 *    works in one of two ways per pair. When the two rules cite no clause in common (the
 *    superseding clause covers the act, as 9.d covers a no-entry), an active rule whose
 *    superseding rule is active this step, or still has an open episode, is dropped. When they
 *    share a clause, only a detection citing that same clause is dropped, so one clause is never
 *    counted twice while a different clause of the superseded rule still stands.
 * 4. Episodes: a rule turning active opens an episode (a `new` breach); a worse severity inside it
 *    emits an `escalated` breach with the same episode id; it closes after `rearmS` inactive. The
 *    report deducts once per episode, at its worst tier.
 * 5. Contacts are decided per event (`fault.js`) after every other rule's episodes of the step
 *    are applied: each collision or fall is either charged or a `Notice`. Notices open no
 *    episode, deduct nothing, are debounced per other party for `rearmS` and kept in the state.
 *    An other party's excusing violation stops excusing the player once the player's speed at
 *    contact (the event's `egoSpeed`) is more than `excuseMaxSpeedGainMps` above its speed when
 *    the violation first showed (the state keeps the ego speed of that moment per actor). A
 *    right-of-way violation outlasts that gain only while the other party is moving at contact
 *    (not a wreck, at or above `contactMinEgoSpeed`) and not ahead in the player's lane. A
 *    vehicle contact charged but for the contact speed gate, and a pedestrian contact below the
 *    gate, are notices with their own texts.
 *    A notice from the fault table opens the aftermath window: for `aftermathWindowS` after it
 *    (from the next step on) every further contact is a notice, and the line-crossing and
 *    pavement detectors start over each step, as after a reset, without closing any episode.
 * 6. Only the charged contacts reach the collision detector. They take as cause the worst
 *    contributing episode active within `crashCauseWindowS` (not across a reset, nor across a fall
 *    before this step), or the rear-end cause of the fault table, and resolve their clause through
 *    the collision policy. A pedestrian hit ends the run with score 0.
 * 7. `finish`, `timeout` and a pedestrian crash end the run; later frames are ignored.
 */

import { LICENCE_START_POINTS } from '../contracts/score.js';
import { decreeGroupOf } from '../contracts/vehicle.js';
import { actorRangeOf, initialCore, poseSpeed, stepCore } from './context.js';
import { DETECTORS } from './detectors/index.js';
import { bothSidesNote, contactFields, decideFault, noticeText } from './fault.js';
import { resolveBreach, resolveCrash } from './resolve.js';
import { selectTier } from './tiers.js';

/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */
/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').Rule} Rule */
/** @typedef {import('../contracts/index.js').Breach} Breach */
/** @typedef {import('../contracts/index.js').Notice} Notice */
/** @typedef {import('../contracts/index.js').FrameEvent} FrameEvent */
/** @typedef {import('../contracts/index.js').CollisionEvent} CollisionEvent */
/** @typedef {import('../contracts/index.js').FallEvent} FallEvent */
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
 * @property {Notice[]} notices Every notice of the run so far, oldest first.
 * @property {FaultState} fault Aftermath and notice debounce tracking.
 */

/**
 * @typedef {object} FaultState
 * @property {number | null} aftermathFromT Time of the last fault-table notice contact, null when
 *   none is recent (cleared by a reset).
 * @property {Record<string, number>} noticeT Last notice time per debounce key, younger than
 *   `rearmS`.
 * @property {Record<string, number>} excuseSpeed Ego speed when each actor now showing an excusing
 *   violation first showed one, by actor id; dropped once the actor shows none. Empty when the
 *   policy sets no `excuseMaxSpeedGainMps`.
 */

/**
 * Detector types that start over on every step of the aftermath window: a shove is not a line
 * crossing, a pass onto the pavement or a drive against the lane.
 */
const AFTERMATH_RESET_DETECTORS = Object.freeze([
  'lane-line-cross',
  'against-lane-dir',
  'stop-line-on-red',
  'stop-line-no-stop',
  'stop-line-no-slow',
  'entry-cross',
  'footprint-in-polygon',
]);

/** Tolerance for comparisons of times built from `tick · DT`. */
const EPS_T = 1e-9;

/**
 * Debounce key of a contact: one per other party, kerbs and unnamed statics by kind.
 * @param {CollisionEvent | FallEvent} e Event.
 * @returns {string} Key.
 */
function noticeKey(e) {
  return e.type === 'fall' ? 'fall' : `${e.otherKind}:${e.otherId ?? ''}`;
}

/**
 * The ego speed at which each actor of the frame that shows an excusing violation first showed
 * one, carried over from `prev` (copied only when it changes). The speed is a magnitude, like a
 * collision event's `egoSpeed`. An actor first showing in a frame that also holds a contact with it
 * takes that contact's `egoSpeed` (the speed before the impact, not the frame's speed after it),
 * so the contact sees no gain.
 * @param {Record<string, number>} prev Speeds so far.
 * @param {Frame} frame Frame.
 * @param {readonly string[]} excusing Excusing violations.
 * @returns {Record<string, number>} Speeds.
 */
function excuseSpeeds(prev, frame, excusing) {
  const shows = (/** @type {import('../contracts/index.js').ActorPose} */ a) => a.violations.length > 0 && a.violations.some((v) => excusing.includes(v));
  let kept = 0;
  let added = false;
  for (const a of frame.actors) {
    if (!shows(a)) continue;
    if (prev[a.id] === undefined) added = true;
    else kept += 1;
  }
  if (!added && kept === Object.keys(prev).length) return prev;
  /** @type {Record<string, number>} */
  const next = {};
  for (const a of frame.actors) {
    if (!shows(a)) continue;
    const contact = frame.events.find((e) => e.type === 'collision' && e.otherId === a.id);
    next[a.id] = prev[a.id] ?? (contact?.type === 'collision' ? contact.egoSpeed : Math.abs(frame.ego.speed));
  }
  return next;
}

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
 * Whether a rule is a collision rule, whose breach takes its cause from the other episodes.
 * @param {Rule} rule Rule.
 * @returns {boolean} True for the collision detector.
 */
const isCollisionRule = (rule) => rule.detection.type === 'collision';

/**
 * Applicable rules in evaluation order: rules that supersede others first, then the rest, each
 * group in bundle order; collision rules come last so their cause lookup sees every other episode
 * of the step.
 * @param {RulesBundle} bundle Bundle.
 * @param {VehicleInfo} vehicle Vehicle.
 * @returns {Rule[]} Rules.
 */
function orderedRules(bundle, vehicle) {
  const applicable = bundle.rules.filter((r) => /** @type {string[]} */ (r.vehicleClasses).includes(vehicle.legalClass));
  const superseding = applicable.filter((r) => (r.supersedes ?? []).length > 0);
  const ordered = [...superseding, ...applicable.filter((r) => !superseding.includes(r))];
  return [...ordered.filter((r) => !isCollisionRule(r)), ...ordered.filter(isCollisionRule)];
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
    actorRangeM: actorRangeOf(bundle),
  };
  const rules = orderedRules(bundle, vehicleInfo);
  for (const r of rules) {
    if (!DETECTORS[r.detection.type]) throw new Error(`Rule ${r.id}: unknown detector "${r.detection.type}"`);
  }
  /**
   * Superseding rules per superseded rule id, for this vehicle's decree group. `byClause` is set
   * when the two rules share a clause for the group: then only a detection citing the clause the
   * superseding rule cites at that moment is dropped.
   */
  /** @type {Map<string, {ruleId: string, byClause: boolean}[]>} */
  const supersededBy = new Map();
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  for (const r of rules) {
    for (const s of r.supersedes ?? []) {
      if (s.decreeGroups && !s.decreeGroups.includes(group)) continue;
      const other = ruleById.get(s.ruleId);
      const mine = new Set(r.tiers.map((t) => tierClauseId(t, group)).filter((id) => id !== null));
      const byClause = other ? other.tiers.some((t) => mine.has(tierClauseId(t, group) ?? '')) : false;
      supersededBy.set(s.ruleId, [...(supersededBy.get(s.ruleId) ?? []), { ruleId: r.id, byClause }]);
    }
  }
  const policy = bundle.collisionPolicy;
  /** Clause ids of the accident clauses (10.a and 10.b of both groups). */
  const accidentClauses = new Set([...Object.values(policy.accidentA), ...Object.values(policy.accidentB)]);
  const collisionRuleIds = new Set(rules.filter(isCollisionRule).map((r) => r.id));
  const freshDetectors = () => Object.fromEntries(rules.map((r) => [r.id, DETECTORS[r.detection.type].init()]));
  const plainRules = rules.filter((r) => !isCollisionRule(r));
  const collisionRules = rules.filter(isCollisionRule);
  const nonContributing = new Set(policy.nonContributingRules ?? []);
  const rearEndRules = new Set(policy.rearEndContributingRules ?? []);
  const aftermathS = policy.aftermathWindowS ?? 0;
  /** Rows that open the aftermath window when they give a notice (every row but `aftermath`). */
  const anchorRows = new Set((policy.faultRows ?? []).filter((r) => r.when !== 'aftermath').map((r) => r.id));
  const contactMinEgoSpeed = bundle.scoring.contactMinEgoSpeed;
  /**
   * A vehicle contact the fault table decides, made below the contact speed gate: it can never
   * deduct, so a deduction row gives a notice instead (and opens the aftermath window).
   * @param {CollisionEvent | FallEvent} e Contact.
   * @returns {boolean} Gated.
   */
  const belowGate = (e) => Boolean(policy.faultRows) && e.type === 'collision' && (e.otherKind === 'car' || e.otherKind === 'motorbike') && e.egoSpeed < contactMinEgoSpeed;
  /**
   * A pedestrian contact below the contact speed gate: never charged and never a run end, but a
   * notice (the pedestrian may have walked into a standing vehicle).
   * @param {CollisionEvent | FallEvent} e Contact.
   * @returns {boolean} Slow pedestrian contact.
   */
  const slowPedestrian = (e) => Boolean(policy.faultRows) && e.type === 'collision' && e.otherKind === 'pedestrian' && e.egoSpeed < contactMinEgoSpeed;
  const excusing = policy.excusingViolations ?? [];
  const excuseGain = policy.excuseMaxSpeedGainMps;
  /**
   * Whether the other party of a contact was moving in the contact frame: present, not a wreck,
   * and at or above the contact speed gate. The frame's poses are those the contact was made
   * against (a struck traffic agent turns into a wreck only on the next step). A party missing
   * from the frame counts as standing.
   * @param {Frame} frame Frame.
   * @param {string | null} id Other party's id.
   * @returns {boolean} Moving.
   */
  const isMoving = (frame, id) => {
    const pose = id === null ? undefined : frame.actors.find((a) => a.id === id);
    return pose !== undefined && poseSpeed(pose) >= contactMinEgoSpeed;
  };

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
    notices: [],
    fault: { aftermathFromT: null, noticeT: {}, excuseSpeed: {} },
  };

  /**
   * @param {unknown} rawState State.
   * @param {Frame} frame Frame.
   * @returns {import('../contracts/index.js').ScorerStep} Step result.
   */
  function step(rawState, frame) {
    const state = /** @type {ScorerState} */ (rawState);
    if (state.ended !== null) {
      return { state, breaches: [], notices: [], context: state.context, runEnded: state.ended === 'crash' ? 'crash' : null };
    }
    const { core, ctx } = stepCore(env, state.core, frame);
    const { rearmS, crashCauseWindowS } = bundle.scoring;
    let episodes = state.episodes;
    let openIndex = state.openIndex;
    let detectors = state.detectors;
    let causeFloorT = state.causeFloorT;
    // A crash on this step may take a cause from before a fall on the same step, not before a reset.
    let stepCauseFloorT = causeFloorT;
    let aftermathFromT = state.fault.aftermathFromT;

    if (ctx.discontinuity) {
      const reset = frame.events.some((e) => e.type === 'reset');
      /** @type {Record<string, number>} */
      const kept = {};
      if (!reset) {
        for (const id of collisionRuleIds) if (openIndex[id] !== undefined) kept[id] = openIndex[id];
      }
      const keptIdx = new Set(Object.values(kept));
      episodes = episodes.map((e, i) => (e.open && !keptIdx.has(i) ? { ...e, open: false } : e));
      openIndex = kept;
      detectors = freshDetectors();
      causeFloorT = frame.t;
      if (reset) {
        stepCauseFloorT = frame.t;
        aftermathFromT = null;
      }
    }
    const inAftermath =
      aftermathFromT !== null && frame.t > aftermathFromT + EPS_T && frame.t - aftermathFromT <= aftermathS + EPS_T;

    /** @type {Record<string, unknown>} */
    const nextDetectors = {};
    /** @type {{rule: Rule, tierIndex: number, severity: number, input: Record<string, unknown>, basisVerified: boolean}[]} */
    const active = [];
    /**
     * Runs the detectors of some rules and adds the active ones to `active`.
     * @param {Rule[]} list Rules.
     * @param {import('./context.js').StepContext} c Context.
     * @returns {typeof active} The rules of `list` that are active.
     */
    const detectRules = (list, c) => {
      /** @type {typeof active} */
      const found = [];
      for (const rule of list) {
        const det = DETECTORS[rule.detection.type];
        if (inAftermath && AFTERMATH_RESET_DETECTORS.includes(rule.detection.type)) {
          nextDetectors[rule.id] = det.init();
          continue;
        }
        const res = det.detect(/** @type {never} */ (detectors[rule.id]), frame, c, /** @type {never} */ (rule.detection.params));
        nextDetectors[rule.id] = res.detectorState;
        if (!res.active) continue;
        const tierIndex = selectTier(rule, res.tierInput, group);
        if (tierIndex < 0) continue;
        found.push({ rule, tierIndex, severity: res.severity ?? tierIndex, input: res.tierInput, basisVerified: res.basisVerified ?? true });
      }
      active.push(...found);
      return found;
    };
    /**
     * Whether a superseding rule is active or open now, and the clause ids it cites: its active
     * tier and its open episode.
     * @param {string} ruleId Superseding rule id.
     * @returns {{any: boolean, ids: Set<string | null>}} State.
     */
    const citedNow = (ruleId) => {
      /** @type {Set<string | null>} */
      const ids = new Set();
      const act = active.find((x) => x.rule.id === ruleId);
      if (act) ids.add(tierClauseId(act.rule.tiers[act.tierIndex], group));
      const open = openIndex[ruleId];
      if (open !== undefined) ids.add(episodes[open].breach.clause?.id ?? null);
      return { any: act !== undefined || open !== undefined, ids };
    };
    /**
     * Drops detections a superseding rule covers.
     * @param {typeof active} found Active rules.
     * @returns {typeof active} Kept rules.
     */
    const unsuperseded = (found) =>
      found.filter((a) => {
        const own = tierClauseId(a.rule.tiers[a.tierIndex], group);
        return !(supersededBy.get(a.rule.id) ?? []).some((s) => {
          const now = citedNow(s.ruleId);
          return s.byClause ? own !== null && now.ids.has(own) : now.any;
        });
      });

    /** @type {Breach[]} */
    const breaches = [];
    let pedestrianHit = state.pedestrianHit;
    let ended = /** @type {ScorerState['ended']} */ (null);
    /** Decisions of the charged contacts, by their index in the collision detector's list. */
    /** @type {import('./fault.js').FaultDecision[]} */
    const chargedDecisions = [];
    /** @type {(CollisionEvent | FallEvent)[]} */
    const charged = [];
    /**
     * Opens or escalates the episodes of kept detections.
     * @param {typeof active} kept Kept rules.
     */
    const apply = (kept) => {
      if (kept.length > 0) {
        if (episodes === state.episodes) episodes = [...episodes];
        if (openIndex === state.openIndex) openIndex = { ...openIndex };
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
          const decision = chargedDecisions[outcome.index];
          const event = charged[outcome.index];
          const sides =
            event.type === 'collision' && outcome.kind !== 'pedestrian' ? bothSidesNote(decision.cause, contactFields(event).otherViolations) : null;
          breach = resolveCrash(env, a.rule, a.tierIndex, outcome, decision.cause, frame, meta, sides);
          if (outcome.kind === 'pedestrian') {
            pedestrianHit = true;
            ended = 'crash';
          }
        } else {
          breach = resolveBreach(env, a.rule, a.tierIndex, frame, meta, a.basisVerified);
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
    };

    // Every rule but the collision rules first, so the contacts see this step's episodes.
    apply(unsuperseded(detectRules(plainRules, ctx)));

    // Fault by law, per contact.
    /** @type {Notice[]} */
    const notices = [];
    let noticeT = state.fault.noticeT;
    const excuseSpeed = excuseGain === undefined ? state.fault.excuseSpeed : excuseSpeeds(state.fault.excuseSpeed, frame, excusing);
    const contacts = /** @type {(CollisionEvent | FallEvent)[]} */ (frame.events.filter((e) => e.type === 'collision' || e.type === 'fall'));
    if (contacts.length > 0) {
      const fromT = frame.t - crashCauseWindowS;
      const cause = findCause(episodes, collisionRuleIds, fromT, stepCauseFloorT, group, (id) => !nonContributing.has(id));
      const rearEndCause = findCause(episodes, collisionRuleIds, fromT, stepCauseFloorT, group, (id) => rearEndRules.has(id));
      const anyCause = findCause(episodes, collisionRuleIds, fromT, stepCauseFloorT, group, () => true);
      let anchored = false;
      for (const e of contacts) {
        const seenAt = e.type === 'collision' && e.otherId !== null ? excuseSpeed[e.otherId] : undefined;
        // The gain runs to the speed at contact: the frame's speed is the speed after the impact.
        const egoSpedUp = excuseGain !== undefined && seenAt !== undefined && e.type === 'collision' && e.egoSpeed - seenAt > excuseGain;
        const otherMoving = e.type === 'collision' && isMoving(frame, e.otherId);
        const d = decideFault(policy, e, { aftermath: inAftermath, cause, anyCause, rearEndCause, egoSpedUp, otherMoving });
        if (d.result === 'deduction' && !belowGate(e) && !slowPedestrian(e)) {
          charged.push(e);
          chargedDecisions.push(d);
          continue;
        }
        if (d.rowId !== null && anchorRows.has(d.rowId)) anchored = true;
        const key = noticeKey(e);
        const last = noticeT[key];
        if (noticeT === state.fault.noticeT) noticeT = { ...noticeT };
        noticeT[key] = frame.t;
        if (last !== undefined && frame.t - last < rearmS - EPS_T) continue;
        notices.push({
          kind: 'npc-fault',
          tick: frame.tick,
          t: frame.t,
          pos: { x: frame.ego.pos.x, z: frame.ego.pos.z },
          otherKind: e.type === 'collision' ? e.otherKind : null,
          otherModel: e.type === 'collision' ? contactFields(e).otherModel : null,
          violations: e.type === 'collision' ? [...contactFields(e).otherViolations] : [],
          text: noticeText(policy, e, d.rowId !== null && !anchorRows.has(d.rowId), d.result === 'deduction'),
        });
      }
      if (anchored) aftermathFromT = frame.t;
    }
    // Forget debounce entries older than rearmS, so the state stays small.
    for (const [key, at] of Object.entries(noticeT)) {
      if (frame.t - at >= rearmS - EPS_T) {
        if (noticeT === state.fault.noticeT) noticeT = { ...noticeT };
        delete noticeT[key];
      }
    }

    // The collision rules, on the charged contacts only.
    apply(unsuperseded(detectRules(collisionRules, { ...ctx, contacts: charged })));

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
    const next = {
      core,
      detectors: nextDetectors,
      episodes,
      openIndex,
      causeFloorT,
      ended,
      pedestrianHit,
      context,
      notices: notices.length > 0 ? [...state.notices, ...notices] : state.notices,
      fault: { aftermathFromT, noticeT, excuseSpeed },
    };
    return { state: next, breaches, notices, context, runEnded: ended === 'crash' ? 'crash' : null };
  }

  /**
   * @param {unknown} rawState State.
   * @param {{quit: boolean}} options Whether the player quit.
   * @returns {ScoreReport} Report.
   */
  function report(rawState, options) {
    const state = /** @type {ScorerState} */ (rawState);
    return buildReport(state, options, accidentClauses);
  }

  return { initial, step, report };
}

/**
 * Worst other episode active since `fromT` (and not before the last discontinuity) of a rule the
 * filter accepts.
 * @param {Episode[]} episodes Episodes.
 * @param {Set<string>} crashRuleIds Collision rule ids, excluded.
 * @param {number} fromT Window start.
 * @param {number} floorT Last discontinuity.
 * @param {import('../contracts/index.js').DecreeGroup} group Decree group.
 * @param {(ruleId: string) => boolean} accept Rules that may be the cause.
 * @returns {import('./resolve.js').CrashCause | null} Cause.
 */
function findCause(episodes, crashRuleIds, fromT, floorT, group, accept) {
  /** @type {Episode | null} */
  let best = null;
  for (const e of episodes) {
    if (crashRuleIds.has(e.ruleId) || !accept(e.ruleId) || e.lastActiveT < Math.max(fromT, floorT) - 1e-9) continue;
    if (!best || causeRank(e, best, group) >= 0) best = e;
  }
  if (!best) return null;
  const clauseId = best.breach.clause ? best.breach.clause.id : null;
  return {
    ruleId: best.ruleId,
    title: best.breach.title,
    clauseId: clauseId && clauseId.startsWith(`${group}.`) ? clauseId : null,
    episodeId: best.episodeId,
  };
}

/**
 * Orders two candidate crash causes: higher danger first; at equal danger one whose clause belongs
 * to the vehicle's decree group (a legal cause) before one without (score only); then the most
 * recently active.
 * @param {Episode} a Candidate.
 * @param {Episode} b Current best.
 * @param {import('../contracts/index.js').DecreeGroup} group Decree group.
 * @returns {number} Positive or zero when `a` should replace `b`, negative otherwise.
 */
function causeRank(a, b, group) {
  if (a.breach.danger !== b.breach.danger) return a.breach.danger - b.breach.danger;
  const legal = (/** @type {Episode} */ e) => (e.breach.clause?.id.startsWith(`${group}.`) ? 1 : 0);
  if (legal(a) !== legal(b)) return legal(a) - legal(b);
  return a.lastActiveT - b.lastActiveT;
}

/**
 * Clause id a rule tier cites for a decree group, or null for a score-only tier.
 * @param {Rule['tiers'][number]} tier Tier.
 * @param {import('../contracts/index.js').DecreeGroup} group Decree group.
 * @returns {string | null} Clause id.
 */
function tierClauseId(tier, group) {
  return tier.clause?.[group] ?? null;
}

/**
 * Marks the cause of each accident as absorbed: the accident clause (10.a or 10.b) names its cause
 * as an element of the offence, so the cause's band is not added to the total a second time. An
 * inferred accident (a cause named in neither list) and a score-only cause absorb nothing; a cause
 * is absorbed by its first accident only. Score deductions are not changed.
 * @param {Breach[]} breaches Breaches, one per episode.
 * @param {Set<string>} accidentClauses Accident clause ids.
 * @returns {Breach[]} Breaches, with `fineAbsorbedBy` on absorbed causes (copies, not the inputs).
 */
export function absorbAccidentCauses(breaches, accidentClauses) {
  /** @type {Map<string, string>} */
  const absorbedBy = new Map();
  for (const b of breaches) {
    if (!b.causeEpisodeId || b.inferred || !b.clause || !accidentClauses.has(b.clause.id)) continue;
    if (absorbedBy.has(b.causeEpisodeId)) continue;
    const cause = breaches.find((c) => c.episodeId === b.causeEpisodeId);
    if (!cause?.clause?.fineVnd) continue;
    absorbedBy.set(cause.episodeId, b.episodeId);
  }
  if (absorbedBy.size === 0) return breaches;
  return breaches.map((b) => {
    const by = absorbedBy.get(b.episodeId);
    return by ? { ...b, fineAbsorbedBy: by } : b;
  });
}

/**
 * Final (or running) report of a scorer state.
 * @param {ScorerState} state State.
 * @param {{quit: boolean}} options Whether the player quit.
 * @param {Set<string>} accidentClauses Accident clause ids.
 * @returns {ScoreReport} Report.
 */
function buildReport(state, options, accidentClauses) {
  const breaches = absorbAccidentCauses(
    state.episodes.map((e) => e.breach),
    accidentClauses,
  );
  const deducted = breaches.reduce((sum, b) => sum + b.deduction, 0);
  const score = state.pedestrianHit ? 0 : Math.max(0, Math.round((10 - deducted) * 100) / 100);
  const maxPoints = breaches.reduce((m, b) => Math.max(m, b.clause ? b.clause.licencePoints : 0), 0);
  const licenceDeducted = Math.min(LICENCE_START_POINTS, maxPoints);
  const fineTotalVnd = breaches.reduce(
    (acc, b) => (b.clause?.fineVnd && !b.fineAbsorbedBy ? { min: acc.min + b.clause.fineVnd.min, max: acc.max + b.clause.fineVnd.max } : acc),
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
    notices: state.notices,
    licence: { start: LICENCE_START_POINTS, deducted: licenceDeducted, remaining: LICENCE_START_POINTS - licenceDeducted },
    fineTotalVnd,
    finished: endedBy === 'finish',
    endedBy,
  };
}

/**
 * Folds a scorer over frames; equals the live fold. With `options.initialState` (a state saved
 * at a checkpoint, as plain JSON) it folds only the frames after that checkpoint and still gives
 * the report of the whole run.
 * @param {RulesBundle} bundle Bundle.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {Frame[]} frames Frames in tick order.
 * @param {import('../contracts/index.js').ScoreRunOptions} options Quit flag and an optional start state.
 * @returns {ScoreReport} Report.
 */
export function scoreRun(bundle, map, vehicleInfo, frames, options) {
  const scorer = createScorer(bundle, map, vehicleInfo);
  let state = options.initialState ?? scorer.initial;
  for (const frame of frames) state = scorer.step(state, frame).state;
  return scorer.report(state, options);
}
