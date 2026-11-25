// Fault by law: every row of the collision policy's fault table, the aftermath window, the
// contact-speed gate and the notice texts, on kinematic frames over the junction fixture map.

import { describe, expect, it } from 'vitest';
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../contracts/index.js';
import { junctionMap, realBundle, scoreScript, summary } from '../../scripts/rules/lib/test-support.js';
import { scriptValue } from '../testing/frame-builder.js';
import { bothSidesNote, decideFault, noticeText, vehicleWord } from './fault.js';

/** @typedef {import('../contracts/index.js').CollisionEvent} CollisionEvent */
/** @typedef {import('../contracts/index.js').ActorPose} ActorPose */
/** @typedef {import('../contracts/index.js').NpcViolation} NpcViolation */
/** @typedef {import('../contracts/index.js').GameMap} GameMap */

/** Straight east along the inner eastbound lane `rw-e1`, through the junction. */
/** @type {[number, number][]} */
const EAST = [[-150, 1.75], [150, 1.75]];
/** Legal speed in the built-up area (36 km/h). */
const LEGAL = 10;
/** Well over every default limit (80 km/h). */
const FAST = 22.2;
const MAP = junctionMap();

/**
 * Collision event with a vehicle: a lawful NPC car that strikes the ego from the side by default.
 * @param {Partial<CollisionEvent>} e Fields.
 * @returns {CollisionEvent} Event.
 */
function hit(e) {
  return {
    type: 'collision',
    otherKind: 'car',
    otherId: 'npc-1',
    impulse: 500,
    egoSpeed: LEGAL,
    relSpeed: 2,
    sameLaneAhead: false,
    otherModel: 'car',
    striker: 'other',
    otherFromBehind: false,
    otherViolations: [],
    ...e,
  };
}

/**
 * Scores a drive east with contacts injected at given times.
 * @param {{t: number, event: import('../contracts/index.js').FrameEvent}[]} events Events.
 * @param {Partial<Parameters<typeof scoreScript>[0]>} [more] Further script options.
 * @returns {ReturnType<typeof scoreScript>} Result.
 */
function drive(events, more = {}) {
  return scoreScript({ map: MAP, path: EAST, speed: LEGAL, durationS: 6, events, ...more });
}

/**
 * The crash breach of a report.
 * @param {import('../contracts/index.js').ScoreReport} report Report.
 * @returns {import('../contracts/index.js').Breach | undefined} Breach.
 */
const crashOf = (report) => report.breaches.find((b) => b.ruleId === 'crash');

describe('decideFault', () => {
  const facts = { aftermath: false, cause: null, anyCause: null, rearEndCause: null, egoSpedUp: false, otherMoving: true };

  it('charges every contact as before when the policy has no fault table', async () => {
    const { faultRows, ...policy } = (await realBundle()).collisionPolicy;
    expect(faultRows).toBeDefined();
    const d = decideFault(policy, hit({}), facts);
    expect(d).toEqual({ rowId: null, result: 'deduction', cause: null });
  });

  it('keeps pedestrians out of the table, even in the aftermath', async () => {
    const policy = (await realBundle()).collisionPolicy;
    const d = decideFault(policy, hit({ otherKind: 'pedestrian', striker: 'other' }), { ...facts, aftermath: true });
    expect(d.rowId).toBeNull();
    expect(d.result).toBe('deduction');
  });

  it('lets statics, kerbs and falls match only the aftermath row', async () => {
    const policy = (await realBundle()).collisionPolicy;
    expect(decideFault(policy, hit({ otherKind: 'kerb', otherId: null }), facts).result).toBe('deduction');
    expect(decideFault(policy, { type: 'fall' }, facts).result).toBe('deduction');
    expect(decideFault(policy, { type: 'fall' }, { ...facts, aftermath: true })).toEqual({ rowId: 'aftermath', result: 'notice', cause: null });
  });

  it('defaults the traffic fields of older events so they are charged as the ego striking', async () => {
    const policy = (await realBundle()).collisionPolicy;
    /** @type {CollisionEvent} */
    const old = { type: 'collision', otherKind: 'car', otherId: 'npc', impulse: 500, egoSpeed: 5, relSpeed: 2, sameLaneAhead: false };
    expect(decideFault(policy, old, facts)).toEqual({ rowId: 'ego-strikes', result: 'deduction', cause: null });
    expect(decideFault(policy, { ...old, sameLaneAhead: true }, facts).rowId).toBe('same-lane-ahead');
  });

  it('words notices by the first violation, from behind, or none, with the vehicle word', async () => {
    const policy = (await realBundle()).collisionPolicy;
    expect(noticeText(policy, hit({ otherKind: 'motorbike', otherModel: 'motorbike', otherViolations: ['red-light'] }), false).vi).toBe(
      'Xe máy vượt đèn đỏ va vào bạn. Trò chơi không ghi nhận lỗi của bạn, không trừ điểm.',
    );
    expect(noticeText(policy, hit({ otherFromBehind: true }), false).vi).toBe(
      'Xe khác va vào bạn từ phía sau. Trò chơi không ghi nhận lỗi của bạn, không trừ điểm.',
    );
    expect(noticeText(policy, hit({ otherModel: 'bus' }), false).vi).toMatch(/^Xe buýt va vào bạn\./u);
    expect(noticeText(policy, { type: 'fall' }, true).vi).toMatch(/^Va chạm tiếp theo/u);
    expect(vehicleWord('car', 'taxi')).toBe('xe taxi');
    expect(vehicleWord('motorbike', null)).toBe('xe máy');
    expect(vehicleWord('static', null)).toBe('xe khác');
  });

  it('writes the two-sided note only when the other party broke a rule', () => {
    const cause = { ruleId: 'speeding', title: { vi: 'Chạy quá tốc độ quy định' }, clauseId: null, episodeId: 'speeding@1' };
    expect(bothSidesNote(cause, ['red-light'])).toBe('Bạn chạy quá tốc độ quy định; xe kia vượt đèn đỏ.');
    expect(bothSidesNote(cause, [])).toBeNull();
    expect(bothSidesNote(null, ['red-light'])).toBeNull();
  });
});

describe('row 1: struck from behind', () => {
  it('gives a moving legal ego a notice and no deduction', async () => {
    const { report } = await drive([{ t: 3, event: hit({ otherFromBehind: true }) }]);
    expect(summary(report)).toEqual([]);
    expect(report.score).toBe(10);
    expect(report.notices).toHaveLength(1);
    expect(report.notices[0]).toMatchObject({ kind: 'npc-fault', otherKind: 'car', otherModel: 'car', violations: [] });
    expect(report.notices[0].text.vi).toBe('Xe khác va vào bạn từ phía sau. Trò chơi không ghi nhận lỗi của bạn, không trừ điểm.');
  });

  it('charges the ego that cut in without a signal, with the lane change as cause', async () => {
    // rw-e1 to the kerb lane rw-e0 across the dashed line rw-k (z 3.5) at about x −125, t 2.5.
    const path = /** @type {[number, number][]} */ ([[-150, 1.75], [-130, 1.75], [-120, 5.25], [150, 5.25]]);
    const { report } = await drive([{ t: 3.2, event: hit({ otherFromBehind: true }) }], { path });
    expect(summary(report)).toEqual(['lane-change:0:D6.2.a', 'crash:0:-']);
    expect(crashOf(report)?.cause).toBe('lane-change');
    expect(report.notices).toEqual([]);
  });

  it('keeps speeding a notice matter when struck from behind, and the speeding episode single', async () => {
    const { report } = await drive([{ t: 3, event: hit({ otherFromBehind: true, egoSpeed: FAST }) }], { speed: FAST, durationS: 5 });
    expect(report.breaches.map((b) => b.ruleId)).toEqual(['speeding']);
    expect(report.notices).toHaveLength(1);
  });

  it('gives a stopped ego a notice despite the contact-speed gate', async () => {
    const { report } = await drive([{ t: 2, event: hit({ otherFromBehind: true, egoSpeed: 0, relSpeed: 6 }) }], { speed: 0, durationS: 4 });
    expect(summary(report)).toEqual([]);
    expect(report.notices).toHaveLength(1);
  });

  it('treats an NPC behind a reversing ego (otherFromBehind false) as the ego striking', async () => {
    const { report } = await drive([{ t: 2, event: hit({ striker: 'ego', otherFromBehind: false, egoSpeed: 1.5 }) }], { speed: 0, durationS: 3 });
    expect(summary(report)).toEqual(['crash:0:-']);
    expect(report.notices).toEqual([]);
  });
});

describe('row 2: a contributing ego episode', () => {
  /**
   * Waits at x −60 until t 31, then drives east at 10 m/s, so the front crosses the west stop line
   * (x −9) on red (sig-w red from t 30 to 60) at about t 36.
   * @param {CollisionEvent} event Contact at t 37.
   * @returns {ReturnType<typeof scoreScript>} Result.
   */
  const redRun = (event) =>
    scoreScript({
      map: MAP,
      path: [[-60, 1.75], [150, 1.75]],
      speed: [{ t: 0, value: 0 }, { t: 31, value: 0 }, { t: 31.01, value: LEGAL }],
      durationS: 38,
      events: [{ t: 37, event }],
    });

  it('charges an ego that ran the red light and was T-boned', async () => {
    const { report } = await redRun(hit({ relSpeed: 6 }));
    expect(report.breaches.map((b) => b.ruleId)).toEqual(['red-light', 'crash']);
    expect(crashOf(report)?.cause).toBe('red-light');
    expect(report.notices).toEqual([]);
  });

  it('charges a speeding ego struck by a red-light runner and names both sides', async () => {
    const { report } = await drive([{ t: 3, event: hit({ otherKind: 'motorbike', otherModel: 'motorbike', otherViolations: ['red-light'], egoSpeed: FAST }) }], {
      speed: FAST,
      durationS: 5,
    });
    expect(report.breaches.map((b) => b.ruleId)).toEqual(['speeding', 'crash']);
    const crash = crashOf(report);
    expect(crash?.cause).toBe('speeding');
    expect(crash?.note?.vi).toContain('Bạn chạy quá tốc độ quy định; xe kia vượt đèn đỏ.');
    expect(report.notices).toEqual([]);
  });

  it('counts an open headlights episode at night', async () => {
    const night = junctionMap((m) => {
      m.environment.startClockMin = 1200;
    });
    const { report } = await scoreScript({ map: night, path: EAST, speed: LEGAL, durationS: 6, events: [{ t: 5, event: hit({}) }] });
    expect(report.breaches.map((b) => b.ruleId)).toEqual(['headlights', 'crash']);
    expect(crashOf(report)?.cause).toBe('headlights');
  });

  it('does not count a night-horn episode', async () => {
    const late = junctionMap((m) => {
      m.environment.startClockMin = 1380;
    });
    const { report } = await scoreScript({
      map: late,
      path: EAST,
      speed: LEGAL,
      durationS: 6,
      controls: [{ t: 0, lights: 'low' }, { t: 2, horn: true }, { t: 2.5, horn: false }],
      events: [{ t: 3, event: hit({}) }],
    });
    expect(report.breaches.map((b) => b.ruleId)).toEqual(['night-horn']);
    expect(report.notices).toHaveLength(1);
  });
});

describe('row 3: the vehicle ahead in the same lane', () => {
  it('charges the ego that rear-ends a slow lawful NPC', async () => {
    const { report } = await drive([{ t: 3, event: hit({ striker: 'ego', sameLaneAhead: true }) }]);
    expect(summary(report)).toEqual(['crash:0:D6.4.l']);
  });

  it('gives a notice for a wrong-way NPC head-on in the ego lane', async () => {
    const { report } = await drive([{ t: 3, event: hit({ striker: 'both', sameLaneAhead: true, relSpeed: 15, otherViolations: ['wrong-way'] }) }]);
    expect(summary(report)).toEqual([]);
    expect(report.notices[0].text.vi).toMatch(/^Ô tô đi ngược chiều va vào bạn\./u);
  });

  it('gives a notice for a fresh motorbike cut-in with a latched unsafe lane change', async () => {
    const event = hit({ otherKind: 'motorbike', otherModel: 'motorbike', striker: 'ego', sameLaneAhead: true, otherViolations: ['unsafe-lane-change'] });
    const { report } = await drive([{ t: 3, event }]);
    expect(summary(report)).toEqual([]);
    expect(report.notices).toHaveLength(1);
  });

  it('cites the motorbike clause when the ego is a scooter', async () => {
    const event = hit({ otherKind: 'motorbike', otherModel: 'motorbike', striker: 'ego', sameLaneAhead: true });
    const { report } = await drive([{ t: 3, event }], { vehicleId: 'scooter', speed: 8 });
    expect(summary(report)).toEqual(['crash:0:D7.3.i']);
  });
});

describe('row 4: the ego strikes', () => {
  it('charges a side-swipe of a lawful NPC', async () => {
    const { report } = await drive([{ t: 3, event: hit({ striker: 'ego' }) }]);
    expect(summary(report)).toEqual(['crash:0:-']);
    expect(crashOf(report)?.cause).toBeUndefined();
  });

  it('charges ramming a merely speeding NPC as an accident', async () => {
    const { report } = await drive([{ t: 3, event: hit({ striker: 'ego', relSpeed: 6, otherViolations: ['speeding'] }) }]);
    expect(summary(report)).toEqual(['crash:1:D6.10.a']);
  });
});

describe('below the contact-speed gate', () => {
  /** Under the 0.5 m/s gate. */
  const CREEP = 0.2;

  it('turns a contributing-episode contact into a notice, keeping the episode breach', async () => {
    // Speeding until t 2.5, then creeping when a red-light runner strikes at t 3.
    const event = hit({ otherViolations: ['red-light'], egoSpeed: CREEP, relSpeed: 6 });
    const { report } = await drive([{ t: 3, event }], {
      speed: [{ t: 0, value: FAST }, { t: 2.5, value: FAST }, { t: 2.51, value: CREEP }],
      durationS: 5,
    });
    expect(report.breaches.map((b) => b.ruleId)).toEqual(['speeding']);
    expect(report.notices).toHaveLength(1);
    expect(report.notices[0].violations).toEqual(['red-light']);
  });

  it('turns creeping into the car ahead in the lane into a notice that asks for a safe distance', async () => {
    const { report } = await drive([{ t: 2, event: hit({ striker: 'ego', sameLaneAhead: true, egoSpeed: CREEP }) }], { speed: CREEP, durationS: 4 });
    expect(summary(report)).toEqual([]);
    expect(report.notices).toHaveLength(1);
    // The vehicle word stays lower case in mid-sentence.
    expect(report.notices[0].text.vi).toBe('Bạn chạm nhẹ vào ô tô ở tốc độ rất thấp. Trò chơi không trừ điểm; hãy giữ khoảng cách an toàn.');
  });

  it('turns a pedestrian contact into a notice, never a deduction or a run end', async () => {
    const event = hit({ otherKind: 'pedestrian', otherId: 'p', otherModel: null, striker: 'ego', egoSpeed: CREEP, relSpeed: 0.2 });
    const { report } = await drive([{ t: 2, event }], { speed: CREEP, durationS: 4 });
    expect(summary(report)).toEqual([]);
    expect(report.score).toBe(10);
    expect(report.endedBy).not.toBe('crash');
    expect(report.notices.map((n) => [n.otherKind, n.text.vi])).toEqual([
      ['pedestrian', 'Có va chạm nhẹ với người đi bộ ở tốc độ rất thấp. Trò chơi không trừ điểm; hãy dừng hẳn và nhường đường cho người đi bộ.'],
    ]);
  });

  it('gives nothing for a static object or a kerb', async () => {
    const { report } = await drive(
      [
        { t: 1, event: hit({ otherKind: 'kerb', otherId: null, otherModel: null, striker: 'ego', egoSpeed: CREEP, relSpeed: 0.2 }) },
        { t: 2, event: hit({ otherKind: 'static', otherId: 'bollard-1', otherModel: null, striker: 'ego', egoSpeed: CREEP, relSpeed: 0.2 }) },
      ],
      { speed: CREEP, durationS: 4 },
    );
    expect(summary(report)).toEqual([]);
    expect(report.notices).toEqual([]);
  });

  it('turns creeping into a lawful NPC into a notice', async () => {
    const { report } = await drive([{ t: 2, event: hit({ striker: 'ego', egoSpeed: CREEP }) }], { speed: CREEP, durationS: 4 });
    expect(summary(report)).toEqual([]);
    expect(report.notices).toHaveLength(1);
  });

  it('opens the aftermath window, so the shove that follows is a notice too', async () => {
    const { report } = await drive(
      [
        { t: 2, event: hit({ striker: 'ego', egoSpeed: CREEP }) },
        { t: 2.8, event: hit({ otherKind: 'kerb', otherId: null, otherModel: null, striker: 'ego', relSpeed: 5 }) },
      ],
      { durationS: 4 },
    );
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.otherKind)).toEqual(['car', 'kerb']);
    expect(report.notices[1].text.vi).toMatch(/^Va chạm tiếp theo/u);
  });
});

describe('an excusing violation and a player who speeds up', () => {
  /** The rider cuts in at t 1; the contact comes at t 2.5, inside the latch. */
  const CUT_AT = 1;
  const CONTACT_AT = 2.5;
  /**
   * The rider ahead in the ego's lane, flagged from the cut-in on.
   * @param {number} t Time.
   * @returns {ActorPose} Pose.
   */
  const riderAt = (t) => ({
    id: 'npc-8',
    kind: 'motorbike',
    pos: { x: -150 + LEGAL * t + 6, z: 1.75 },
    heading: 0,
    speed: 6,
    active: true,
    model: 'motorbike',
    variant: 0,
    lengthM: 1.9,
    widthM: 0.7,
    lights: ACTOR_LIGHTS.off,
    state: 'moving',
    violations: t >= CUT_AT ? Object.freeze(/** @type {NpcViolation[]} */ (['unsafe-lane-change'])) : NO_VIOLATIONS,
  });

  /**
   * Scores the ego striking the rider at CONTACT_AT.
   * @param {number | import('../testing/frame-builder.js').Keyframe[]} speed Ego speed script.
   * @returns {ReturnType<typeof scoreScript>} Result.
   */
  const strike = (speed) =>
    drive([], {
      speed,
      extraActors: (t) => [riderAt(t)],
      extraEvents: (t) =>
        Math.abs(t - CONTACT_AT) < 1e-6
          ? [
              hit({
                otherKind: 'motorbike',
                otherId: 'npc-8',
                otherModel: 'motorbike',
                striker: 'ego',
                sameLaneAhead: true,
                egoSpeed: scriptValue(speed, t),
                otherViolations: riderAt(t).violations,
              }),
            ]
          : [],
    });

  it('excuses an ego that held its speed when the rider cut in', async () => {
    const { report } = await strike(LEGAL);
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.violations)).toEqual([['unsafe-lane-change']]);
  });

  it('charges an ego that sped up into the rider after it cut in', async () => {
    const { report } = await strike([
      { t: 0, value: LEGAL },
      { t: CUT_AT + 0.2, value: LEGAL },
      { t: CONTACT_AT - 0.1, value: LEGAL + 2 },
    ]);
    // The va chạm with the vehicle ahead in the same lane.
    expect(summary(report)).toEqual(['crash:0:D6.4.l']);
    expect(report.notices).toEqual([]);
  });

  it('lets the speed gain lift the excuse in the table', async () => {
    const policy = (await realBundle()).collisionPolicy;
    const facts = { aftermath: false, cause: null, anyCause: null, rearEndCause: null, egoSpedUp: true, otherMoving: true };
    const event = hit({ otherKind: 'motorbike', striker: 'ego', otherViolations: ['unsafe-lane-change'] });
    expect(decideFault(policy, event, facts)).toMatchObject({ rowId: 'ego-strikes', result: 'deduction' });
    expect(decideFault(policy, event, { ...facts, egoSpedUp: false })).toMatchObject({ rowId: 'otherwise', result: 'notice' });
    expect(decideFault(policy, { ...event, sameLaneAhead: true }, facts).rowId).toBe('same-lane-ahead');
  });
});

describe('a right-of-way violation and a player who speeds up', () => {
  /** The runner shows its flag at t 1; the contact comes at t 2.5, inside the latch. */
  const FLAG_AT = 1;
  const CONTACT_AT = 2.5;
  /** Speed script of a player pulling away and gaining well over the excuse margin. */
  const PULLING_AWAY = [
    { t: 0, value: LEGAL - 4 },
    { t: FLAG_AT, value: LEGAL - 4 },
    { t: CONTACT_AT - 0.1, value: LEGAL },
  ];

  /**
   * A party crossing the player's path from the right, flagged from FLAG_AT on.
   * @param {NpcViolation} violation Its violation.
   * @param {Partial<ActorPose>} [over] Pose fields that replace the moving crosser's.
   * @returns {(t: number) => ActorPose} Pose by time.
   */
  const crosserAt = (violation, over = {}) => (t) => ({
    id: 'npc-9',
    kind: 'car',
    pos: { x: -120, z: 8 - 6 * t },
    heading: Math.PI / 2,
    speed: 6,
    active: true,
    model: 'car',
    variant: 0,
    lengthM: 4.5,
    widthM: 1.8,
    lights: ACTOR_LIGHTS.off,
    state: 'moving',
    violations: t >= FLAG_AT ? Object.freeze(/** @type {NpcViolation[]} */ ([violation])) : NO_VIOLATIONS,
    ...over,
  });

  /** The flagged party halted across the player's lane, as a runner held on the junction connector. */
  const STANDING = { pos: { x: -120, z: 1.75 }, speed: 0, state: /** @type {const} */ ('stopped') };
  /** The flagged party wrecked across the player's lane, still sliding. */
  const WRECKED = { pos: { x: -120, z: 1.75 }, speed: 3, state: /** @type {const} */ ('crashed') };

  /**
   * Scores the player's front meeting the crossing party at CONTACT_AT.
   * @param {NpcViolation} violation The crossing party's violation.
   * @param {boolean} sameLaneAhead The contact is reported as with the vehicle ahead in the lane.
   * @param {Partial<ActorPose>} [over] Pose fields that replace the moving crosser's.
   * @returns {ReturnType<typeof scoreScript>} Result.
   */
  const meet = (violation, sameLaneAhead, over = {}) => {
    const at = crosserAt(violation, over);
    return drive([], {
      speed: PULLING_AWAY,
      extraActors: (t) => [at(t)],
      extraEvents: (t) => (Math.abs(t - CONTACT_AT) < 1e-6 ? [hit({ otherId: 'npc-9', striker: 'ego', sameLaneAhead, otherViolations: at(t).violations })] : []),
    });
  };

  it('keeps excusing a player who pulls away into a red-light runner crossing its path', async () => {
    const { report } = await meet('red-light', false);
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.violations)).toEqual([['red-light']]);
  });

  it('keeps excusing a player who pulls away into a vehicle that did not yield', async () => {
    const { report } = await meet('no-yield', false);
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.violations)).toEqual([['no-yield']]);
  });

  it('still charges a player who speeds up into a red-light runner ahead in its lane', async () => {
    const { report } = await meet('red-light', true);
    expect(summary(report)).toEqual(['crash:0:D6.4.l']);
    expect(report.notices).toEqual([]);
  });

  it('lets only the right-of-way violations outlast the speed gain in the table', async () => {
    const policy = (await realBundle()).collisionPolicy;
    const facts = { aftermath: false, cause: null, anyCause: null, rearEndCause: null, egoSpedUp: true, otherMoving: true };
    for (const v of /** @type {NpcViolation[]} */ (['red-light', 'no-yield'])) {
      const event = hit({ otherKind: 'motorbike', striker: 'ego', otherViolations: [v] });
      expect(decideFault(policy, event, facts), v).toMatchObject({ rowId: 'otherwise', result: 'notice' });
      expect(decideFault(policy, { ...event, sameLaneAhead: true }, facts), v).toMatchObject({ rowId: 'same-lane-ahead', result: 'deduction' });
    }
    for (const v of /** @type {NpcViolation[]} */ (['unsafe-lane-change', 'wrong-way'])) {
      const event = hit({ otherKind: 'motorbike', striker: 'ego', otherViolations: [v] });
      expect(decideFault(policy, event, facts), v).toMatchObject({ rowId: 'ego-strikes', result: 'deduction' });
    }
  });

  it('lets a right-of-way violation outlast the speed gain only while the other party moves', async () => {
    const policy = (await realBundle()).collisionPolicy;
    const facts = { aftermath: false, cause: null, anyCause: null, rearEndCause: null, egoSpedUp: true, otherMoving: false };
    for (const v of /** @type {NpcViolation[]} */ (['red-light', 'no-yield'])) {
      const event = hit({ otherKind: 'motorbike', striker: 'ego', otherViolations: [v] });
      expect(decideFault(policy, event, facts), v).toMatchObject({ rowId: 'ego-strikes', result: 'deduction' });
      expect(decideFault(policy, event, { ...facts, otherMoving: true }), v).toMatchObject({ rowId: 'otherwise', result: 'notice' });
    }
  });

  for (const v of /** @type {NpcViolation[]} */ (['red-light', 'no-yield'])) {
    it(`charges a player who speeds up into a ${v} party standing across its path`, async () => {
      const { report } = await meet(v, false, STANDING);
      expect(summary(report)).toEqual(['crash:0:-']);
      expect(report.notices).toEqual([]);
    });
  }

  it('charges a player who speeds up into a wrecked red-light runner, although the wreck still slides', async () => {
    const { report } = await meet('red-light', false, WRECKED);
    expect(summary(report)).toEqual(['crash:0:-']);
    expect(report.notices).toEqual([]);
  });
});

describe('the speed gain runs to the speed at contact', () => {
  /** The rider cuts in at t 1; the contact comes at t 2.5. */
  const CUT_AT = 1;
  const CONTACT_AT = 2.5;
  /**
   * A rider ahead in the ego's lane, flagged from `flagAt` on.
   * @param {number} flagAt Time its flag first shows.
   * @returns {(t: number) => ActorPose} Pose by time.
   */
  const riderAt = (flagAt) => (t) => ({
    id: 'npc-8',
    kind: 'motorbike',
    pos: { x: -150 + LEGAL * t + 6, z: 1.75 },
    heading: 0,
    speed: 6,
    active: true,
    model: 'motorbike',
    variant: 0,
    lengthM: 1.9,
    widthM: 0.7,
    lights: ACTOR_LIGHTS.off,
    state: 'moving',
    violations: t >= flagAt - 1e-6 ? Object.freeze(/** @type {NpcViolation[]} */ (['unsafe-lane-change'])) : NO_VIOLATIONS,
  });

  /**
   * Scores a hard contact: the frame's ego speed collapses at the contact, the event keeps the
   * speed the ego struck with.
   * @param {number} flagAt Time the rider's flag first shows.
   * @param {number} contactSpeed The event's ego speed.
   * @returns {ReturnType<typeof scoreScript>} Result.
   */
  const hard = (flagAt, contactSpeed) => {
    const at = riderAt(flagAt);
    return drive([], {
      speed: [
        { t: 0, value: 5.47 },
        { t: CONTACT_AT - 0.1, value: 5.47 },
        { t: CONTACT_AT, value: 0.32 },
      ],
      extraActors: (t) => [at(t)],
      extraEvents: (t) =>
        Math.abs(t - CONTACT_AT) < 1e-6
          ? [hit({ otherKind: 'motorbike', otherId: 'npc-8', otherModel: 'motorbike', striker: 'ego', sameLaneAhead: true, egoSpeed: contactSpeed, otherViolations: at(t).violations })]
          : [],
    });
  };

  it('charges a player that struck well above its speed when the flag showed, though the frame speed collapsed', async () => {
    const { report } = await hard(CUT_AT, 10.87);
    expect(summary(report)).toEqual(['crash:0:D6.4.l']);
    expect(report.notices).toEqual([]);
  });

  it('excuses a player that struck at the speed it held when the flag showed', async () => {
    const { report } = await hard(CUT_AT, 5.47);
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.violations)).toEqual([['unsafe-lane-change']]);
  });

  it('sees no gain when the flag first shows in the contact frame', async () => {
    const { report } = await hard(CONTACT_AT, 10.87);
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.violations)).toEqual([['unsafe-lane-change']]);
  });
});

describe('row 5: otherwise', () => {
  it('gives a legal ego struck by a red-light runner a notice', async () => {
    const event = hit({ otherKind: 'motorbike', otherModel: 'motorbike', otherViolations: ['red-light'], relSpeed: 8 });
    const { report } = await drive([{ t: 3, event }]);
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.text.vi)).toEqual(['Xe máy vượt đèn đỏ va vào bạn. Trò chơi không ghi nhận lỗi của bạn, không trừ điểm.']);
  });
});

describe('latched versus expired NPC flags', () => {
  /** The NPC ran the red light at t 1; the traffic module latches the flag for 3 s. */
  const RED_AT = 1;
  /**
   * The NPC pose at `t`, its violations latched for the cause window.
   * @param {number} t Time.
   * @returns {ActorPose} Pose.
   */
  const npcAt = (t) => ({
    id: 'npc-7',
    kind: 'car',
    pos: { x: -150 + LEGAL * t + 3, z: -1.75 },
    heading: Math.PI,
    speed: 8,
    active: true,
    model: 'car',
    variant: 0,
    lengthM: 4.5,
    widthM: 1.8,
    lights: ACTOR_LIGHTS.off,
    state: 'moving',
    violations: t - RED_AT < 3 ? Object.freeze(/** @type {NpcViolation[]} */ (['red-light'])) : NO_VIOLATIONS,
  });

  /**
   * Scores a contact the ego strikes at `contactT`, carrying the NPC pose's flags.
   * @param {number} contactT Contact time.
   * @returns {ReturnType<typeof scoreScript>} Result.
   */
  const contactAt = (contactT) =>
    drive([], {
      extraActors: (t) => [npcAt(t)],
      extraEvents: (t) =>
        Math.abs(t - contactT) < 1e-6 ? [hit({ otherId: 'npc-7', striker: 'ego', otherViolations: npcAt(t).violations })] : [],
    });

  it('charges the contact once the flag has expired (3.1 s after the violation): row 4', async () => {
    const { report } = await contactAt(RED_AT + 3.1);
    expect(summary(report)).toEqual(['crash:0:-']);
  });

  it('gives a notice while the flag is latched (2.9 s after it): row 5', async () => {
    const { report } = await contactAt(RED_AT + 2.9);
    expect(summary(report)).toEqual([]);
    expect(report.notices).toHaveLength(1);
  });
});

describe('several contacts', () => {
  it('resolves a notice contact and a fault contact on the same step', async () => {
    const t = 3;
    const { report } = await drive([
      { t, event: hit({ otherId: 'npc-1', otherViolations: ['red-light'] }) },
      { t, event: hit({ otherId: 'npc-2', striker: 'ego' }) },
    ]);
    expect(summary(report)).toEqual(['crash:0:-']);
    expect(report.notices).toHaveLength(1);
    expect(report.notices[0].violations).toEqual(['red-light']);
  });

  it('debounces repeated notices of one NPC until it stayed clear for rearmS', async () => {
    const events = [0, 0.5, 1, 2].map((dt) => ({ t: 2 + dt, event: hit({ otherFromBehind: true }) }));
    const again = (/** @type {number} */ t) => ({ t, event: hit({ otherFromBehind: true }) });
    const { report } = await drive([...events, again(7.5)], { durationS: 9 });
    expect(report.notices.map((n) => n.t)).toEqual([2, 7.5]);
  });
});

describe('row 0: aftermath', () => {
  /** Shoved from rw-e1 over the dashed line rw-k (z 3.5) into the kerb lane, no indicator. */
  const SHOVE = [
    { t: 0, value: 0 },
    { t: 2, value: 0 },
    { t: 3, value: -3.5 },
  ];

  it('makes a kerb hit and a second NPC within 1.5 s notices, and the shove no lane change', async () => {
    const { report } = await drive(
      [
        { t: 2, event: hit({ otherFromBehind: true, relSpeed: 6 }) },
        { t: 2.8, event: hit({ otherKind: 'kerb', otherId: null, otherModel: null, striker: 'ego', relSpeed: 5 }) },
        { t: 3, event: hit({ otherId: 'npc-2', striker: 'ego', sameLaneAhead: true }) },
      ],
      { offset: SHOVE },
    );
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.otherKind)).toEqual(['car', 'kerb', 'car']);
    expect(report.notices[1].text.vi).toMatch(/^Va chạm tiếp theo/u);
  });

  it('charges the same move without the earlier notice contact', async () => {
    const { report } = await drive([{ t: 3, event: hit({ otherId: 'npc-2', striker: 'ego', sameLaneAhead: true }) }], { offset: SHOVE });
    expect(summary(report)).toEqual(['lane-change:0:D6.2.a', 'crash:0:D6.4.l']);
  });

  it('charges contacts after the window ends', async () => {
    const { report } = await drive([
      { t: 2, event: hit({ otherFromBehind: true }) },
      { t: 3.6, event: hit({ otherId: 'npc-2', striker: 'ego' }) },
    ]);
    expect(summary(report)).toEqual(['crash:0:-']);
  });

  it('runs no pavement test across a shove onto the pavement', async () => {
    /**
     * Adds a pavement beside the kerb lane.
     * @param {GameMap} m Map.
     */
    const withPavement = (m) => {
      m.pavements = [{ id: 'pv-rw', polygon: [[-157, 7], [-7, 7], [-7, 10], [-157, 10]] }];
    };
    const map = junctionMap(withPavement);
    const script = {
      map,
      path: EAST,
      durationS: 6,
      // Shoved onto the pavement (z 8.5) between t 2 and 2.6, rolling there until t 3.3, stopped.
      speed: [{ t: 0, value: LEGAL }, { t: 2, value: LEGAL }, { t: 2.6, value: 3 }, { t: 3.3, value: 3 }, { t: 3.31, value: 0 }],
      offset: [{ t: 0, value: 0 }, { t: 2, value: 0 }, { t: 2.6, value: -6.75 }],
    };
    const shoved = await scoreScript({ ...script, events: [{ t: 2, event: hit({ otherFromBehind: true }) }] });
    expect(summary(shoved.report)).toEqual([]);
    const unprovoked = await scoreScript(script);
    expect(unprovoked.report.breaches.map((b) => b.ruleId)).toContain('pavement');
  });

  it('makes a scooter fall inside the window a notice', async () => {
    const { report } = await drive([
      { t: 2, event: hit({ otherFromBehind: true, otherKind: 'motorbike', otherModel: 'motorbike' }) },
      { t: 2.5, event: { type: 'fall' } },
    ], { vehicleId: 'scooter', speed: 8 });
    expect(summary(report)).toEqual([]);
    expect(report.notices.map((n) => n.otherKind)).toEqual(['motorbike', null]);
  });

  it('still ends the run on a pedestrian hit inside the window', async () => {
    const { report } = await drive([
      { t: 2, event: hit({ otherFromBehind: true }) },
      { t: 2.5, event: hit({ otherKind: 'pedestrian', otherId: 'p', otherModel: null }) },
    ]);
    expect(report.endedBy).toBe('crash');
    expect(report.score).toBe(0);
    expect(summary(report)).toEqual(['crash:1:D6.10.a']);
  });
});
