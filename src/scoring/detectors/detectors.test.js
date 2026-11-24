// Every detector on kinematic frames over the minimal fixture map and validated variants of it:
// fire, no-fire, boundaries, and the clean cases that lawful driving must pass.

import { describe, expect, it } from 'vitest';
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../../contracts/index.js';
import { clone, junctionMap, mapVariant, minimalMap, realBundle, scoreScript, summary } from '../../../scripts/rules/lib/test-support.js';

/** @typedef {import('../../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../../contracts/index.js').FrameEvent} FrameEvent */
/** @typedef {import('../../contracts/index.js').ActorPose} ActorPose */
/** @typedef {import('../../testing/frame-builder.js').Keyframe} Keyframe */
/** @typedef {[number, number]} Vec2 */

/** Straight east along rw-e, through the junction, to the finish. */
/** @type {Vec2[]} */
const STRAIGHT = [[5, 1.75], [195, 1.75]];
/** Left turn from rw-e into the northbound lane rn-n. */
/** @type {Vec2[]} */
const LEFT_TURN = [[5, 1.75], [101.75, 1.75], [101.75, -40]];

/**
 * Piecewise-constant speed: `[duration, speed]` segments with 1 ms ramps between them.
 * @param {[number, number][]} segments Segments.
 * @returns {Keyframe[]} Keyframes.
 */
function steps(segments) {
  /** @type {Keyframe[]} */
  const out = [];
  let t = 0;
  for (const [duration, value] of segments) {
    out.push({ t: t + (out.length ? 0.001 : 0), value }, { t: t + duration, value });
    t += duration;
  }
  return out;
}

/**
 * Collision event.
 * @param {Partial<import('../../contracts/index.js').CollisionEvent>} e Fields.
 * @returns {FrameEvent} Event.
 */
function hit(e) {
  return { type: 'collision', otherKind: 'car', otherId: 'npc', impulse: 500, egoSpeed: 5, relSpeed: 2, sameLaneAhead: false, ...e };
}

/**
 * Minimal map without actors, optionally edited.
 * @param {(m: GameMap) => void} [edit] Further edits.
 * @returns {GameMap} Map.
 */
function quiet(edit) {
  return mapVariant((m) => {
    m.actors = [];
    edit?.(m);
  });
}

/**
 * Replaces the west arm's signal with an unsignalled line of the given control.
 * @param {GameMap} m Map to edit.
 * @param {'stop-sign' | 'give-way'} control Control.
 */
function unsignalledWest(m, control) {
  const line = m.stopLines.find((s) => s.id === 'sl-w');
  if (!line) throw new Error('fixture changed');
  line.control = control;
  delete line.signalId;
  m.signals = m.signals.filter((s) => s.id !== 'sig-w');
  for (const c of m.crosswalks) delete c.signalId;
}

/**
 * Scores and summarises.
 * @param {Parameters<typeof scoreScript>[0]} script Script.
 * @returns {Promise<string[]>} Summary.
 */
async function run(script) {
  return summary((await scoreScript(script)).report);
}

describe('speed-over-limit', () => {
  const at = (/** @type {number} */ over, /** @type {'car-sedan' | 'scooter'} */ vehicleId = 'car-sedan') =>
    run({ map: quiet(), vehicleId, path: STRAIGHT, speed: (50 + over) / 3.6, durationS: 2.5 });

  it('follows the car bands [5, 10), [10, 20], (20, 35], over 35 exactly', async () => {
    expect(await at(4.9)).toEqual([]);
    expect(await at(5)).toEqual(['speeding:0:D6.3.a']);
    expect(await at(9.9)).toEqual(['speeding:0:D6.3.a']);
    expect(await at(10)).toEqual(['speeding:1:D6.5.đ']);
    expect(await at(20)).toEqual(['speeding:1:D6.5.đ']);
    expect(await at(20.1)).toEqual(['speeding:2:D6.6.a']);
    expect(await at(35)).toEqual(['speeding:2:D6.6.a']);
    expect(await at(35.1)).toEqual(['speeding:3:D6.7.a']);
  });

  it('follows the motorbike bands [5, 10), [10, 20], over 20', async () => {
    expect(await at(5, 'scooter')).toEqual(['speeding:0:D7.2.b']);
    expect(await at(20, 'scooter')).toEqual(['speeding:1:D7.4.a']);
    expect(await at(20.1, 'scooter')).toEqual(['speeding:2:D7.8.a']);
    expect(await at(35.1, 'scooter')).toEqual(['speeding:3:D7.8.a']);
  });

  it('needs the over-speed held for sustainS', async () => {
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 60 / 3.6, durationS: 0.95 })).toEqual([]);
  });

  it('falls back to the TT 38 default outside a sign zone', async () => {
    const rural = quiet((m) => {
      m.zones = [];
    });
    // Outside a built-up zone a car on a two-way road may do 80 km/h.
    expect(await run({ map: rural, path: STRAIGHT, speed: 84.9 / 3.6, durationS: 2.5 })).toEqual([]);
    expect(await run({ map: rural, path: STRAIGHT, speed: 85 / 3.6, durationS: 2.5 })).toEqual(['speeding:0:D6.3.a']);
    // The scooter's default there is 60 km/h.
    expect(await run({ map: rural, vehicleId: 'scooter', path: STRAIGHT, speed: 65 / 3.6, durationS: 2.5 })).toEqual([
      'speeding:0:D7.2.b',
    ]);
  });

  it('marks a breach against an unverified default limit, not one against a verified default or a sign', async () => {
    const rural = quiet((m) => {
      m.zones = [];
    });
    const verified = await scoreScript({ map: rural, path: STRAIGHT, speed: 85 / 3.6, durationS: 2.5 });
    expect(verified.report.breaches.map((b) => b.basisVerified)).toEqual([true]);
    const bundle = clone(await realBundle());
    for (const d of bundle.speedDefaults) d.verified = false;
    const unverified = await scoreScript({ map: rural, path: STRAIGHT, speed: 85 / 3.6, durationS: 2.5, bundle });
    expect(unverified.report.breaches.map((b) => b.basisVerified)).toEqual([false]);
    const signed = await scoreScript({ map: quiet(), path: STRAIGHT, speed: 60 / 3.6, durationS: 2.5 });
    expect(signed.report.breaches.map((b) => b.basisVerified)).toEqual([true]);
  });
});

describe('stop-line-on-red', () => {
  // sig-w: green [0, 27), yellow [27, 30), red [30, 60). The car's front is 2.25 m ahead of its
  // centre; the stop line is at x = 88, the crosswalk at 90–94, the junction from 96.5.
  it('cites 6.9.b when the car runs through on red', async () => {
    expect(await run({ map: quiet(), path: STRAIGHT, speed: steps([[31, 0], [12, 10]]), durationS: 43 })).toEqual([
      'red-light:1:D6.9.b',
    ]);
  });

  it('cites the signal clause at the lower score tier when the front stops just past the line', async () => {
    // Front at x = 88.5: half a metre past the line, before the crosswalk.
    const speed = steps([[31, 0], [12, 10]]);
    const { report } = await scoreScript({ map: quiet(), path: [[5, 1.75], [86.25, 1.75]], speed, durationS: 45 });
    expect(summary(report)).toEqual(['red-light:0:D6.9.b']);
    const [breach] = report.breaches;
    expect(breach.inferred).toBe(false);
    expect(breach.clause?.licencePoints).toBe(4);
    expect(breach.deduction).toBe(0.5);
    expect(breach.note?.vi).toMatch(/vạch dừng/u);
    const scooter = await scoreScript({ map: quiet(), vehicleId: 'scooter', path: [[5, 1.75], [87.575, 1.75]], speed, durationS: 45 });
    expect(summary(scooter.report)).toEqual(['red-light:0:D7.7.c']);
    expect(scooter.report.breaches[0].inferred).toBe(false);
  });

  it('stays at the line tier for a front less than entryToleranceM into the crosswalk', async () => {
    const speed = steps([[31, 0], [12, 10]]);
    // Front at x = 90.75: 0.75 m into the crosswalk.
    const short = await scoreScript({ map: quiet(), path: [[5, 1.75], [88.5, 1.75]], speed, durationS: 45 });
    expect(summary(short.report)).toEqual(['red-light:0:D6.9.b']);
    // Front at x = 91.75: 1.75 m into it.
    const deep = await scoreScript({ map: quiet(), path: [[5, 1.75], [89.5, 1.75]], speed, durationS: 45 });
    expect(summary(deep.report)).toEqual(['red-light:1:D6.9.b']);
  });

  it('is quiet for a stop before the line and a start on green', async () => {
    const speed = steps([[31, 0], [8.025, 10], [25, 0], [10, 10]]);
    expect(await run({ map: quiet(), path: STRAIGHT, speed, durationS: 74 })).toEqual([]);
  });

  it('on yellow fires only when the car could have stopped at the onset', async () => {
    // Front 20 m before the line when yellow starts at 10 m/s: 16.7 m to stop, so it must stop.
    expect(await run({ map: quiet(), path: STRAIGHT, speed: steps([[20.925, 0], [6, 10]]), durationS: 27 + 3 })).toEqual([
      'red-light:1:D6.9.b',
    ]);
    // Front 5 m before the line: it cannot stop and may go on.
    expect(await run({ map: quiet(), path: STRAIGHT, speed: steps([[19.425, 0], [10, 10]]), durationS: 29 })).toEqual([]);
  });

  it('cites 7.7.c for a motorbike', async () => {
    expect(await run({ map: quiet(), vehicleId: 'scooter', path: STRAIGHT, speed: steps([[31, 0], [12, 10]]), durationS: 43 })).toEqual([
      'red-light:1:D7.7.c',
    ]);
  });
});

describe('stopped-in-zone', () => {
  // West arm with the stop line 1.5 m from the junction and no crosswalk.
  const nearLine = (/** @type {(m: GameMap) => void} */ more = () => {}) =>
    quiet((m) => {
      const line = m.stopLines.find((s) => s.id === 'sl-w');
      if (line) line.segment = [[95, 0], [95, 3.5]];
      m.crosswalks = [];
      more(m);
    });

  it('is quiet while waiting at a red light inside the 5 m buffer', async () => {
    // Front at 94.5, 2 m from the junction edge, from t ≈ 39.7 to 47.7 on red.
    expect(await run({ map: nearLine(), path: STRAIGHT, speed: steps([[31, 0], [8.725, 10], [8, 0]]), durationS: 47.7 })).toEqual([]);
  });

  it('cites 6.3.đ for a car stopped in the buffer on green, but not a motorbike (7.2.e names no range)', async () => {
    expect(await run({ map: nearLine(), path: STRAIGHT, speed: steps([[8.725, 10], [5, 0]]), durationS: 13.7 })).toEqual([
      'stopping:1:D6.3.đ',
    ]);
    expect(
      await run({ map: nearLine(), vehicleId: 'scooter', path: STRAIGHT, speed: steps([[8.8575, 10], [5, 0]]), durationS: 13.8 }),
    ).toEqual([]);
  });

  it('is quiet for a 4 s stop behind a crossing pedestrian', async () => {
    const map = nearLine((m) => {
      m.actors = [
        { id: 'ped-x', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, path: [[96, 0], [96, 10]], speed: 0.3, trigger: { atS: 0 }, loop: false },
      ];
    });
    expect(await run({ map, path: STRAIGHT, speed: steps([[8.725, 10], [5, 0]]), durationS: 13.7 })).toEqual([]);
  });

  it('is quiet waiting on green for a pedestrian on the zebra ahead but outside the car\'s path', async () => {
    const map = quiet((m) => {
      const line = m.stopLines.find((s) => s.id === 'sl-w');
      if (line) line.segment = [[92, 0], [92, 3.5]];
      m.crosswalks = [{ id: 'cw-j', polygon: [[93, -3.5], [96.5, -3.5], [96.5, 3.5], [93, 3.5]], signalId: 'sig-w' }];
    });
    // Front on the line at 92, 4.5 m from the junction, from t ≈ 8.5 to 13.5 on green.
    const script = { map, path: STRAIGHT, speed: steps([[8.475, 10], [5, 0]]), durationS: 13.5 };
    expect(await run(script)).toEqual(['stopping:1:D6.3.đ']);
    const withPed = quiet((m) => {
      Object.assign(m, map);
      m.actors = [
        { id: 'ped-far', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, path: [[94.5, -5], [94.5, 5]], speed: 0.3, trigger: { atS: 0 }, loop: false },
      ];
    });
    expect(await run({ ...script, map: withPed })).toEqual([]);
  });

  it('cites 6.3.đ in a junction and 7.2.e for a motorbike there', async () => {
    const script = { map: quiet(), path: /** @type {Vec2[]} */ ([[5, 1.75], [100, 1.75]]), speed: 10, durationS: 14 };
    expect(await run(script)).toEqual(['stopping:0:D6.3.đ']);
    expect(await run({ ...script, vehicleId: 'scooter' })).toEqual(['stopping:0:D7.2.e']);
  });

  it('cites 6.2.đ on a crosswalk and in a P.130 zone bound to the lane, after minStopS only', async () => {
    const map = quiet((m) => {
      m.crosswalks.push({ id: 'cw-mid', polygon: [[40, -3.5], [44, -3.5], [44, 3.5], [40, 3.5]] });
      m.zones.push({ id: 'z-p130', type: 'no-stopping', polygon: [[20, 0], [30, 0], [30, 3.5], [20, 3.5]], laneIds: ['rw-e'], signIds: [], source: 'tutorial' });
    });
    expect(await run({ map, path: [[5, 1.75], [42, 1.75]], speed: 10, durationS: 9 })).toEqual(['stopping:2:D6.2.đ']);
    expect(await run({ map, path: [[5, 1.75], [42, 1.75]], speed: 10, durationS: 6.5 })).toEqual([]);
    expect(await run({ map, path: [[5, 1.75], [25, 1.75]], speed: 10, durationS: 6 })).toEqual(['stopping:2:D6.2.đ']);
    const otherLane = quiet((m) => {
      m.zones.push({ id: 'z-p130', type: 'no-stopping', polygon: [[20, 0], [30, 0], [30, 3.5], [20, 3.5]], laneIds: ['rw-w'], signIds: [], source: 'tutorial' });
    });
    expect(await run({ map: otherLane, path: [[5, 1.75], [25, 1.75]], speed: 10, durationS: 6 })).toEqual([]);
    expect(await run({ map: quiet(), vehicleId: 'scooter', path: [[5, 1.75], [92, 1.75]], speed: 10, durationS: 13 })).toEqual([
      'stopping:2:D7.2.e',
    ]);
  });
});

describe('against-lane-dir', () => {
  it('is quiet while overtaking across the dashed centre line', async () => {
    const offset = [{ t: 1, value: 0 }, { t: 2, value: 3.5 }, { t: 5, value: 3.5 }, { t: 6, value: 0 }];
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 10, offset, durationS: 7 })).toEqual([]);
  });

  it('cites 6.5.b after staying in the opposing lane past maxOpposingS', async () => {
    const offset = [{ t: 1, value: 0 }, { t: 2, value: 3.5 }];
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 5, offset, durationS: 14 })).toEqual(['wrong-side:0:D6.5.b']);
  });

  it('cites 6.5.b and 7.3.d at once over a solid centre line', async () => {
    const script = { map: quiet(), path: /** @type {Vec2[]} */ ([[110, 1.75], [195, 1.75]]), speed: 10, offset: [{ t: 0.5, value: 0 }, { t: 1.5, value: 3.5 }], durationS: 3 };
    expect(await run(script)).toEqual(['wrong-side:0:D6.5.b']);
    expect(await run({ ...script, vehicleId: 'scooter' })).toEqual(['wrong-side:0:D7.3.d']);
  });

  it('cites 6.9.d against a one-way road, and through a P.102 entry without a no-entry breach', async () => {
    expect(await run({ map: quiet(), path: [[100, 8], [100, 40]], speed: 8, durationS: 3 })).toEqual(['wrong-way:0:D6.9.d']);
    const { report } = await scoreScript({ map: quiet(), path: [[100, -2], [100, 40]], speed: 8, durationS: 3 });
    expect(summary(report)).toEqual(['wrong-way:0:D6.9.d']);
    expect(await run({ map: quiet(), vehicleId: 'scooter', path: [[100, 8], [100, 40]], speed: 8, durationS: 3 })).toEqual([
      'wrong-way:0:D7.7.a',
    ]);
  });
});

describe('entry-cross', () => {
  const map = quiet((m) => {
    m.signs.push({ id: 's-p101', code: 'P.101', pos: { x: 50, z: 5 }, heading: 0, source: 'tutorial' });
    m.entries.push({ id: 'en-car', segment: [[50, 0], [50, 3.5]], heading: 0, bannedClasses: ['car'], signId: 's-p101' });
  });

  it('cites 6.5.i for a banned class and spares the others', async () => {
    expect(await run({ map, path: STRAIGHT, speed: 10, durationS: 6 })).toEqual(['no-entry:0:D6.5.i']);
    expect(await run({ map, vehicleId: 'scooter', path: STRAIGHT, speed: 10, durationS: 6 })).toEqual([]);
  });

  it('carries the ND 238 amendment on the clause', async () => {
    const { report } = await scoreScript({ map, path: STRAIGHT, speed: 10, durationS: 6 });
    expect(report.breaches[0].clause?.amendments?.[0].quote).toMatch(/cấp có thẩm quyền/u);
  });
});

describe('lane-line-cross', () => {
  // rw with two eastbound lanes (rw-e, rw-w); `more` may add a third.
  const twoLanes = (/** @type {(m: GameMap) => void} */ more = () => {}) =>
    quiet((m) => {
      const rw = m.roads[0];
      const west = rw.lanes[1];
      west.dir = 'forward';
      west.centerline = [[0, -1.75], [96.5, -1.75]];
      more(m);
    });
  const offset = [{ t: 2, value: 0 }, { t: 3, value: 3.5 }];
  const base = { path: STRAIGHT, speed: 10, offset, durationS: 5 };

  it('cites 6.2.a with no indicator, a late indicator, or over a solid line', async () => {
    expect(await run({ ...base, map: twoLanes() })).toEqual(['lane-change:0:D6.2.a']);
    expect(await run({ ...base, map: twoLanes(), controls: [{ t: 2.2, indicators: 'left' }] })).toEqual(['lane-change:0:D6.2.a']);
    const solid = twoLanes((m) => {
      m.roads[0].laneLines[0].type = 'solid';
      m.roads[0].laneLines[0].crossable = 'none';
    });
    expect(await run({ ...base, map: solid, controls: [{ t: 0, indicators: 'left' }] })).toEqual(['lane-change:0:D6.2.a']);
  });

  it('is quiet with the indicator held for signalLeadS', async () => {
    expect(await run({ ...base, map: twoLanes(), controls: [{ t: 0, indicators: 'left' }] })).toEqual([]);
    expect(await run({ ...base, map: twoLanes(), vehicleId: 'scooter', controls: [{ t: 1.4, indicators: 'left' }] })).toEqual([]);
  });

  it('uses the unsafe-gap tier for a car close in the target lane', async () => {
    const map = twoLanes((m) => {
      m.actors = [
        { id: 'npc-side', kind: 'car', model: 'npc-sedan', lengthM: 4.5, widthM: 1.8, path: [[12, -1.75], [200, -1.75]], speed: 10, trigger: { atS: 0 }, loop: false },
      ];
    });
    const { report } = await scoreScript({ ...base, map, controls: [{ t: 0, indicators: 'left' }] });
    // Cutting in 2.5 m behind it is tailgating too.
    expect(summary(report)).toEqual(['lane-change:1:D6.2.a', 'following-distance:0:-']);
    expect(report.breaches[0].danger).toBe(3);
  });

  it('counts two lanes at once as a fault even when signalled', async () => {
    const map = twoLanes((m) => {
      const rw = m.roads[0];
      rw.lanes.push({ id: 'rw-x', dir: 'forward', index: 2, polygon: [[0, -7], [96.5, -7], [96.5, -3.5], [0, -3.5]], centerline: [[0, -5.25], [96.5, -5.25]] });
      rw.laneLines.push({ id: 'rw-c2', left: 'rw-x', right: 'rw-w', type: 'dashed', polyline: [[0, -3.5], [96.5, -3.5]], crossable: 'both' });
      m.pavements = m.pavements.filter((p) => p.id !== 'pv-w-north');
    });
    const wide = [{ t: 2, value: 0 }, { t: 3.5, value: 7 }];
    expect(await run({ ...base, map, offset: wide, durationS: 5, controls: [{ t: 0, indicators: 'left' }] })).toEqual([
      'lane-change:0:D6.2.a',
    ]);
  });
});

describe('junction-turn', () => {
  const base = { map: quiet(), path: LEFT_TURN, speed: 8, durationS: 15 };

  it('cites 6.3.c and 7.3.a for a turn without the indicator held from 30 m', async () => {
    expect(await run(base)).toEqual(['turn-signal:0:D6.3.c']);
    expect(await run({ ...base, vehicleId: 'scooter' })).toEqual(['turn-signal:0:D7.3.a']);
    // Switched on 16.5 m before the junction.
    expect(await run({ ...base, controls: [{ t: 9.375, indicators: 'left' }] })).toEqual(['turn-signal:0:D6.3.c']);
    expect(await run({ ...base, controls: [{ t: 0, indicators: 'right' }] })).toEqual(['turn-signal:0:D6.3.c']);
  });

  it('is quiet with the indicator held through the turn, and for straight on', async () => {
    expect(await run({ ...base, controls: [{ t: 0, indicators: 'left' }] })).toEqual([]);
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 8, durationS: 15 })).toEqual([]);
  });

  // From rn-s (southbound) a left turn into re-e is banned (P.123a). sig-n is green from t = 30.
  const banned = { map: quiet(), path: /** @type {Vec2[]} */ ([[98.25, -40], [98.25, -1.5], [101.5, 1.75], [150, 1.75]]), speed: steps([[31, 0], [12, 8]]), durationS: 43 };

  it('cites 6.4.k for a banned turn, plus 6.3.c for a car without the indicator', async () => {
    expect(await run(banned)).toEqual(['banned-turn:0:D6.4.k', 'turn-signal:0:D6.3.c']);
    expect(await run({ ...banned, controls: [{ t: 0, indicators: 'left' }] })).toEqual(['banned-turn:0:D6.4.k']);
  });

  it('gives a motorbike one breach under 7.3.a (banned-turn supersedes turn-signal)', async () => {
    expect(await run({ ...banned, vehicleId: 'scooter' })).toEqual(['banned-turn:0:D7.3.a']);
  });

  it('cites 7.2.k for a banned U-turn on a motorbike and keeps the separate 7.3.a for no indicator', async () => {
    const map = quiet((m) => {
      m.signs.push({ id: 's-p124a', code: 'P.124a', pos: { x: 95.5, z: -12 }, heading: -Math.PI / 2, source: 'tutorial' });
      m.restrictions.push({ id: 'rx-n-u', junctionId: 'j1', fromLaneIds: ['rn-s'], banned: ['uturn'], signId: 's-p124a' });
    });
    const path = /** @type {Vec2[]} */ ([[98.25, -40], [98.25, -1], [101.75, -1], [101.75, -40]]);
    const speed = steps([[31, 0], [12, 8]]);
    expect(await run({ map, vehicleId: 'scooter', path, speed, durationS: 43 })).toEqual([
      'banned-turn:1:D7.2.k',
      'turn-signal:0:D7.3.a',
    ]);
    // With the indicator on, only the banned U-turn remains.
    expect(await run({ map, vehicleId: 'scooter', path, speed, durationS: 43, controls: [{ t: 0, indicators: 'left' }] })).toEqual([
      'banned-turn:1:D7.2.k',
    ]);
  });
});

describe('stop-line-no-stop and stop-line-no-slow', () => {
  it('cites the catch-all at a STOP line passed without stopping, and is quiet after a full stop', async () => {
    const map = quiet((m) => unsignalledWest(m, 'stop-sign'));
    expect(await run({ map, path: STRAIGHT, speed: 10, durationS: 10 })).toEqual(['stop-sign:0:D6.1.a']);
    expect(await run({ map, path: STRAIGHT, speed: steps([[8.025, 10], [1, 0], [5, 10]]), durationS: 14 })).toEqual([]);
  });

  it('cites 6.5.n at a give-way line passed fast, and is quiet after slowing', async () => {
    const map = quiet((m) => unsignalledWest(m, 'give-way'));
    expect(await run({ map, path: STRAIGHT, speed: 10, durationS: 10 })).toEqual(['give-way:0:D6.5.n']);
    expect(await run({ map, path: STRAIGHT, speed: steps([[7.025, 10], [6, 2], [3, 10]]), durationS: 16 })).toEqual([]);
  });

  it('cites 6.5.n and 7.6.c entering a priority junction from a minor road', async () => {
    const map = quiet((m) => {
      m.signals = [];
      m.stopLines = [];
      for (const c of m.crosswalks) delete c.signalId;
      m.junctions[0].signalized = false;
      m.junctions[0].priorityRoadIds = ['rn', 'rs'];
    });
    expect(await run({ map, path: STRAIGHT, speed: 10, durationS: 11 })).toEqual(['give-way:0:D6.5.n']);
    expect(await run({ map, vehicleId: 'scooter', path: STRAIGHT, speed: 10, durationS: 11 })).toEqual(['give-way:0:D7.6.c']);
    expect(await run({ map, path: STRAIGHT, speed: steps([[7.9, 10], [6, 2], [3, 10]]), durationS: 16 })).toEqual([]);
  });

  it('judges a STOP or give-way line before a priority junction at the line only', async () => {
    const priority = (/** @type {'stop-sign' | 'give-way'} */ control) =>
      quiet((m) => {
        unsignalledWest(m, control);
        m.signals = [];
        m.stopLines = m.stopLines.filter((s) => s.id === 'sl-w');
        m.junctions[0].signalized = false;
        m.junctions[0].priorityRoadIds = ['rn', 'rs'];
      });
    // The junction is 8.5 m past the line, so the 10 m window still holds the stop; start 2 m
    // earlier so it does not, and the line alone must decide.
    const stopThenGo = steps([[7.825, 10], [1, 0], [6, 10]]);
    expect(await run({ map: priority('stop-sign'), path: STRAIGHT, speed: stopThenGo, durationS: 14 })).toEqual([]);
    const slowThenGo = steps([[6.825, 10], [6, 2], [4, 10]]);
    expect(await run({ map: priority('give-way'), path: STRAIGHT, speed: slowThenGo, durationS: 16 })).toEqual([]);
  });
});

describe('lights', () => {
  const night = quiet((m) => {
    m.environment.startClockMin = 1100;
  });

  it('cites 6.3.g with headlights off at night after sustainS, and in rain', async () => {
    expect(await run({ map: night, path: STRAIGHT, speed: 10, durationS: 4 })).toEqual(['headlights:0:D6.3.g']);
    expect(await run({ map: night, path: STRAIGHT, speed: 10, durationS: 2.9 })).toEqual([]);
    expect(await run({ map: night, path: STRAIGHT, speed: 10, durationS: 4, controls: [{ t: 0, lights: 'low' }] })).toEqual([]);
    const rain = quiet((m) => {
      m.environment.weather = 'rain';
      m.environment.surfaceGrip = 0.7;
    });
    expect(await run({ map: rain, vehicleId: 'scooter', path: STRAIGHT, speed: 10, durationS: 4 })).toEqual(['headlights:0:D7.1.g']);
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 10, durationS: 4 })).toEqual([]);
  });

  it('cites 6.3.b for high beam toward an oncoming car, and on a lit street', async () => {
    const withNpc = mapVariant((m) => {
      m.actors = m.actors.filter((a) => a.id === 'npc-1');
      m.environment.startClockMin = 1200;
    });
    const high = [{ t: 0, lights: /** @type {const} */ ('high') }];
    expect(await run({ map: withNpc, path: STRAIGHT, speed: 10, durationS: 5, controls: high })).toEqual(['high-beam:0:D6.3.b']);
    expect(await run({ map: withNpc, path: STRAIGHT, speed: 10, durationS: 5, controls: [{ t: 0, lights: 'low' }] })).toEqual([]);
    const lit = quiet((m) => {
      m.zones.push({ id: 'z-lit', type: 'lit', polygon: [[0, -3.5], [96.5, -3.5], [96.5, 3.5], [0, 3.5]], laneIds: ['rw-e', 'rw-w'], signIds: [], source: 'tutorial' });
    });
    expect(await run({ map: lit, path: STRAIGHT, speed: 10, durationS: 3, controls: high })).toEqual(['high-beam:0:D6.3.b']);
    // A 0.5 s flash is a lawful signal.
    const flash = [{ t: 1, lights: /** @type {const} */ ('high') }, { t: 1.5, lights: /** @type {const} */ ('low') }];
    expect(await run({ map: lit, path: STRAIGHT, speed: 10, durationS: 3, controls: flash })).toEqual([]);
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 10, durationS: 3, controls: high })).toEqual([]);
  });

  it('counts a pedestrian crossing the road but not one on the pavement, and no oncoming car on a divided road', async () => {
    const high = [{ t: 0, lights: /** @type {const} */ ('high') }];
    /**
     * @param {[number, number][]} path Pedestrian path.
     * @returns {GameMap} Night map with one slow pedestrian on that path.
     */
    const withPed = (path) =>
      quiet((m) => {
        m.environment.startClockMin = 1200;
        m.actors = [{ id: 'ped-x', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, path, speed: 0.3, trigger: { atS: 0 }, loop: false }];
      });
    expect(await run({ map: withPed([[70, 4.5], [80, 4.5]]), path: STRAIGHT, speed: 10, durationS: 3, controls: high })).toEqual([]);
    expect(await run({ map: withPed([[70, -1], [70, 1]]), path: STRAIGHT, speed: 10, durationS: 3, controls: high })).toEqual([
      'high-beam:0:D6.3.b',
    ]);
    const dividedNpc = mapVariant((m) => {
      m.actors = m.actors.filter((a) => a.id === 'npc-1');
      m.environment.startClockMin = 1200;
      for (const r of m.roads) r.divided = true;
    });
    expect(await run({ map: dividedNpc, path: STRAIGHT, speed: 10, durationS: 5, controls: high })).toEqual([]);
  });

  it('cites 6.1.đ and 7.1.i for the horn between 22:00 and 05:00 in a built-up zone only', async () => {
    const late = quiet((m) => {
      m.environment.startClockMin = 1340;
    });
    const horn = [{ t: 1, horn: true }, { t: 1.5, horn: false }];
    expect(await run({ map: late, path: STRAIGHT, speed: 10, durationS: 3, controls: horn })).toEqual(['night-horn:0:D6.1.đ']);
    expect(await run({ map: late, vehicleId: 'scooter', path: STRAIGHT, speed: 10, durationS: 3, controls: horn })).toEqual([
      'night-horn:0:D7.1.i',
    ]);
    expect(await run({ map: quiet(), path: STRAIGHT, speed: 10, durationS: 3, controls: horn })).toEqual([]);
  });
});

describe('footprint-in-polygon', () => {
  it('cites 6.6.d and 7.7.a with the centre on the pavement', async () => {
    const script = { map: quiet(), path: STRAIGHT, speed: 5, offset: [{ t: 0.5, value: 0 }, { t: 1, value: -3 }], durationS: 3 };
    expect(await run(script)).toEqual(['pavement:0:D6.6.d']);
    expect(await run({ ...script, vehicleId: 'scooter' })).toEqual(['pavement:0:D7.7.a']);
    expect(await run({ ...script, offset: [{ t: 0.5, value: 0 }, { t: 1, value: -1.5 }] })).toEqual([]);
  });
});

describe('crosswalk-occupied', () => {
  it('cites the catch-all by inference going straight onto an occupied zebra', async () => {
    const { report } = await scoreScript({ map: minimalMap(), path: STRAIGHT, speed: 15, durationS: 8 });
    expect(summary(report)).toEqual(['crosswalk-yield:0:D6.1.a']);
    expect(report.breaches[0].inferred).toBe(true);
  });

  it('is quiet when the car waits until the pedestrian has crossed', async () => {
    const map = mapVariant((m) => {
      m.actors = m.actors.filter((a) => a.id === 'ped-1');
    });
    expect(await run({ map, path: STRAIGHT, speed: steps([[4.5, 10], [8, 0], [6, 10]]), durationS: 18.5 })).toEqual([]);
  });

  it('still fires when the car creeps onto the zebra and then drives across an occupied one', async () => {
    // A slow pedestrian is still on the zebra when the car, having crept onto it at 0.3 m/s, goes on.
    const map = mapVariant((m) => {
      m.actors = m.actors.filter((a) => a.id === 'ped-1').map((a) => ({ ...a, speed: 0.5 }));
    });
    const creep = steps([[8.2, 10], [3, 0.3], [2, 5]]);
    expect(await run({ map, path: STRAIGHT, speed: creep, durationS: 13.2 })).toEqual(['crosswalk-yield:0:D6.1.a']);
    // Creeping onto it and stopping there is not an entry.
    expect(await run({ map, path: STRAIGHT, speed: steps([[8.2, 10], [3, 0.3], [2, 0]]), durationS: 13.2 })).toEqual([]);
  });

  it('cites 6.5.l when turning onto an occupied zebra', async () => {
    const map = mapVariant((m) => {
      m.crosswalks.push({ id: 'cw-n', polygon: [[96.5, -12], [103.5, -12], [103.5, -8], [96.5, -8]] });
      m.actors = [
        { id: 'ped-n', kind: 'pedestrian', model: 'pedestrian', lengthM: 0.5, widthM: 0.5, path: [[95, -10], [110, -10]], speed: 0.3, trigger: { atS: 0 }, loop: false },
      ];
    });
    expect(await run({ map, path: LEFT_TURN, speed: 8, durationS: 15, controls: [{ t: 0, indicators: 'left' }] })).toEqual([
      'crosswalk-yield:1:D6.5.l',
    ]);
  });
});

describe('gap-ahead', () => {
  const lead = (/** @type {number} */ x0, /** @type {number} */ speed) =>
    quiet((m) => {
      m.actors = [
        { id: 'lead', kind: 'car', model: 'npc-sedan', lengthM: 4.5, widthM: 1.8, path: [[x0, 1.75], [200, 1.75]], speed, trigger: { atS: 0 }, loop: false },
      ];
    });

  it('deducts score only for a time gap under 1 s held for 2 s above 5 m/s', async () => {
    const { report } = await scoreScript({ map: lead(14, 10), path: STRAIGHT, speed: 10, durationS: 4 });
    expect(summary(report)).toEqual(['following-distance:0:-']);
    expect(report.breaches[0].scoreOnly).toBe(true);
    expect(report.score).toBe(9.5);
    expect(report.fineTotalVnd).toEqual({ min: 0, max: 0 });
    expect(await run({ map: lead(20, 10), path: STRAIGHT, speed: 10, durationS: 4 })).toEqual([]);
  });

  it('is quiet in a slow queue', async () => {
    expect(await run({ map: lead(12, 4), path: STRAIGHT, speed: 4, durationS: 4 })).toEqual([]);
  });
});

describe('collision', () => {
  const base = { map: quiet(), path: STRAIGHT, durationS: 3 };

  it('never counts a contact while the ego is slower than 0.5 m/s', async () => {
    const { report } = await scoreScript({ ...base, speed: 0, events: [{ t: 1, event: hit({ egoSpeed: 0.2, impulse: 5000 }) }] });
    expect(report.breaches).toEqual([]);
    expect(report.endedBy).toBe('quit');
  });

  it('chooses 10.a or 10.b from the cause clause for a pedestrian hit', async () => {
    const ped = { t: 2, event: hit({ otherKind: 'pedestrian', otherId: 'p' }) };
    const speeding = await scoreScript({ ...base, speed: 60 / 3.6, events: [ped] });
    expect(summary(speeding.report)).toEqual(['speeding:1:D6.5.đ', 'crash:1:D6.10.a']);
    expect(speeding.report.breaches[1].cause).toBe('speeding');
    expect(speeding.report.breaches[1].causeEpisodeId).toBe(speeding.report.breaches[0].episodeId);
    const late = quiet((m) => {
      m.environment.startClockMin = 1340;
    });
    const horn = await scoreScript({ ...base, map: late, speed: 10, controls: [{ t: 0.5, horn: true }, { t: 1, horn: false }], events: [ped] });
    expect(summary(horn.report)).toEqual(['night-horn:0:D6.1.đ', 'crash:1:D6.10.b']);
  });

  it('counts an accident and its cause once in the fine total, and both in the score', async () => {
    const ped = { t: 2, event: hit({ otherKind: 'pedestrian', otherId: 'p' }) };
    const { report } = await scoreScript({ ...base, speed: 60 / 3.6, events: [ped] });
    const [cause, accident] = report.breaches;
    expect(cause.fineAbsorbedBy).toBe(accident.episodeId);
    expect(accident.fineAbsorbedBy).toBeUndefined();
    expect(report.fineTotalVnd).toEqual(accident.clause?.fineVnd);
    const car = await scoreScript({ ...base, speed: 60 / 3.6, events: [{ t: 2, event: hit({ relSpeed: 6 }) }] });
    expect(summary(car.report)).toEqual(['speeding:1:D6.5.đ', 'crash:1:D6.10.a']);
    expect(car.report.fineTotalVnd).toEqual(car.report.breaches[1].clause?.fineVnd);
    expect(car.report.score).toBe(10 - car.report.breaches[0].deduction - car.report.breaches[1].deduction);
  });

  it('keeps both bands when the accident is inferred or the contact is light', async () => {
    const pavement = { ...base, speed: 5, offset: [{ t: 0.2, value: 0 }, { t: 0.6, value: -3 }], events: [{ t: 2.5, event: hit({ otherKind: 'pedestrian' }) }] };
    const inferred = await scoreScript(pavement);
    const sum = (/** @type {import('../../contracts/index.js').Breach[]} */ bs) =>
      bs.reduce((a, b) => ({ min: a.min + (b.clause?.fineVnd?.min ?? 0), max: a.max + (b.clause?.fineVnd?.max ?? 0) }), { min: 0, max: 0 });
    expect(inferred.report.breaches.some((b) => b.fineAbsorbedBy)).toBe(false);
    expect(inferred.report.fineTotalVnd).toEqual(sum(inferred.report.breaches));
    const light = await scoreScript({ ...base, speed: 60 / 3.6, events: [{ t: 2, event: hit({}) }] });
    expect(summary(light.report)).toEqual(['speeding:1:D6.5.đ', 'crash:0:-']);
    expect(light.report.breaches.some((b) => b.fineAbsorbedBy)).toBe(false);
    expect(light.report.fineTotalVnd).toEqual(sum(light.report.breaches));
  });

  it('marks a pavement cause as inferred, for both decree groups', async () => {
    const pavement = { ...base, speed: 5, offset: [{ t: 0.2, value: 0 }, { t: 0.6, value: -3 }], events: [{ t: 2.5, event: hit({ otherKind: 'pedestrian' }) }] };
    const car = await scoreScript(pavement);
    expect(summary(car.report)).toEqual(['pavement:0:D6.6.d', 'crash:1:D6.10.a']);
    expect(car.report.breaches[1].inferred).toBe(true);
    const moto = await scoreScript({ ...pavement, vehicleId: 'scooter' });
    expect(summary(moto.report)).toEqual(['pavement:0:D7.7.a', 'crash:1:D7.10.a']);
    expect(moto.report.breaches[1].inferred).toBe(true);
  });

  it('splits car contacts by closing speed and lane, the same for both vehicles', async () => {
    for (const vehicleId of ['car-sedan', 'scooter']) {
      const g = vehicleId === 'scooter' ? 'D7' : 'D6';
      const accident = await scoreScript({ ...base, vehicleId, speed: 10, events: [{ t: 1, event: hit({ relSpeed: 4.2 }) }] });
      expect(summary(accident.report)).toEqual([`crash:1:${g}.10.a`]);
      expect(accident.report.endedBy).toBe('quit');
      expect(accident.report.score).toBe(6);
      expect(accident.report.breaches[0].designParams).toEqual(['accidentRelSpeed']);
      const below = await scoreScript({ ...base, vehicleId, speed: 10, events: [{ t: 1, event: hit({ relSpeed: 4.19, impulse: 9000 }) }] });
      expect(summary(below.report)).toEqual(['crash:0:-']);
      expect(below.report.score).toBe(9);
    }
    const ahead = await scoreScript({ ...base, vehicleId: 'scooter', speed: 10, events: [{ t: 1, event: hit({ sameLaneAhead: true }) }] });
    expect(summary(ahead.report)).toEqual(['crash:0:D7.3.i']);
    const side = await scoreScript({ ...base, speed: 10, events: [{ t: 1, event: hit({}) }] });
    expect(summary(side.report)).toEqual(['crash:0:-']);
    expect(side.report.breaches[0].note?.vi).toMatch(/không có lỗi luật/u);
  });

  it('splits static and kerb hits by closing speed, score only', async () => {
    const kerb = await scoreScript({ ...base, speed: 10, events: [{ t: 1, event: hit({ otherKind: 'kerb', otherId: null }) }] });
    expect(kerb.report.breaches[0]).toMatchObject({ tierIndex: 0, danger: 3, scoreOnly: true, clause: null, deduction: 1 });
    const wall = await scoreScript({ ...base, speed: 10, events: [{ t: 1, event: hit({ otherKind: 'static', otherId: 'o', relSpeed: 8 }) }] });
    expect(wall.report.breaches[0]).toMatchObject({ tierIndex: 1, danger: 5, scoreOnly: true, clause: null, deduction: 4 });
  });

  it('escalates a light contact to a heavy static hit inside one episode', async () => {
    const { live, report } = await scoreScript({
      ...base,
      vehicleId: 'scooter',
      speed: 10,
      events: [
        { t: 1, event: hit({}) },
        { t: 1.5, event: hit({ otherKind: 'static', otherId: 'o', relSpeed: 6 }) },
      ],
    });
    expect(live.flat().map((b) => [b.kind, b.tierIndex])).toEqual([['new', 0], ['escalated', 1]]);
    expect(report.breaches).toHaveLength(1);
    expect(report.score).toBe(6);
  });

  it('takes a cause only inside crashCauseWindowS', async () => {
    const speed = [{ t: 0, value: 60 / 3.6 }, { t: 1.5, value: 60 / 3.6 }, { t: 1.51, value: 10 }];
    const near = await scoreScript({ ...base, durationS: 6, speed, events: [{ t: 4, event: hit({}) }] });
    expect(near.report.breaches[1].cause).toBe('speeding');
    const far = await scoreScript({ ...base, durationS: 6, speed, events: [{ t: 5, event: hit({}) }] });
    expect(far.report.breaches[1].cause).toBeUndefined();
  });

  it('escalates a contact to a pedestrian hit inside one episode', async () => {
    const { live, report } = await scoreScript({
      ...base,
      speed: 10,
      events: [
        { t: 1, event: hit({}) },
        { t: 1.5, event: hit({ otherKind: 'pedestrian' }) },
      ],
    });
    expect(live.flat().map((b) => [b.kind, b.tierIndex, b.clause?.id ?? null])).toEqual([['new', 0, null], ['escalated', 1, 'D6.10.a']]);
    expect(report.endedBy).toBe('crash');
    expect(report.breaches).toHaveLength(1);
  });
});

describe('detectors in motorbike traffic', () => {
  const JUNCTION = junctionMap();
  /**
   * Ego centre x when driving east along rw-e1 at 10 m/s from x −150.
   * @param {number} t Time.
   * @returns {number} X.
   */
  const egoX = (t) => -150 + 10 * t;

  /**
   * A traffic pose.
   * @param {string} id Id.
   * @param {'car' | 'motorbike'} kind Kind.
   * @param {number} x X.
   * @param {number} z Z.
   * @param {Partial<ActorPose>} [more] Further fields.
   * @returns {ActorPose} Pose.
   */
  const pose = (id, kind, x, z, more = {}) => ({
    id,
    kind,
    pos: { x, z },
    heading: 0,
    speed: 10,
    active: true,
    model: kind,
    variant: 0,
    lengthM: kind === 'car' ? 4.5 : 1.9,
    widthM: kind === 'car' ? 1.8 : 0.8,
    lights: ACTOR_LIGHTS.off,
    state: 'moving',
    violations: NO_VIOLATIONS,
    ...more,
  });

  describe('gap-ahead', () => {
    /**
     * Scores 10 s east with motorbikes 5 m ahead of the ego centre (bumper gap about 1.8 m).
     * @param {(t: number) => ActorPose[]} extraActors Poses.
     * @returns {Promise<string[]>} Summary.
     */
    const follow = (extraActors) => run({ map: JUNCTION, path: [[-150, 1.75], [150, 1.75]], speed: 10, durationS: 10, extraActors });

    it('does not fire when motorbikes filter in ahead one after another', async () => {
      // A new rider every 1.5 s, each ahead for 1.5 s, shorter than sustainS 2.
      const riders = (/** @type {number} */ t) => {
        const i = Math.floor((t - 1) / 1.5);
        return t >= 1 && i < 5 ? [pose(`npc-${i}`, 'motorbike', egoX(t) + 5, 1.75 + (i % 2 ? 0.6 : -0.6))] : [];
      };
      expect(await follow(riders)).toEqual([]);
    });

    it('fires behind one motorbike held that close for the sustain time', async () => {
      const one = (/** @type {number} */ t) => (t >= 1 && t < 6 ? [pose('npc-1', 'motorbike', egoX(t) + 5, 1.75)] : []);
      expect(await follow(one)).toEqual(['following-distance:0:-']);
    });

    it('ignores a leader whose unsafe lane change is still latched', async () => {
      const cutIn = (/** @type {number} */ t) =>
        t >= 1 && t < 6 ? [pose('npc-1', 'motorbike', egoX(t) + 5, 1.75, { violations: Object.freeze(['unsafe-lane-change']) })] : [];
      expect(await follow(cutIn)).toEqual([]);
    });
  });

  describe('lane-change tier 2', () => {
    /**
     * Signalled merge from rw-e1 into the kerb lane rw-e0 over the dashed line rw-k (z 3.5).
     * @param {(t: number) => ActorPose[]} extraActors Poses.
     * @returns {Promise<string[]>} Summary.
     */
    const merge = (extraActors) =>
      run({
        map: JUNCTION,
        path: [[-150, 1.75], [-130, 1.75], [-120, 5.25], [-60, 5.25]],
        speed: 10,
        durationS: 8,
        controls: [{ t: 0, indicators: 'right' }],
        extraActors,
      });

    // The rider keeps pace just behind the ego (the merge path is a little longer than its own).
    it('stays quiet with a motorbike passing on the far side of the kerb lane, outside the ego strip', async () => {
      expect(await merge((t) => [pose('npc-1', 'motorbike', egoX(t) - 3, 6.6)])).toEqual([]);
    });

    it('fires with a motorbike alongside inside the strip the ego moves into', async () => {
      expect(await merge((t) => [pose('npc-1', 'motorbike', egoX(t) - 3, 4.4)])).toEqual(['lane-change:1:D6.2.a']);
    });

    it('fires with a stopped car within gapAheadM in the target lane', async () => {
      expect(await merge(() => [pose('npc-1', 'car', -118, 5.25, { speed: 0, state: 'stopped' })])).toEqual(['lane-change:1:D6.2.a']);
    });

    // The ego crosses the line at about (-125, 3.5), heading along (0.944, 0.330), at t 2.5 s.
    // Vehicles appear just before the crossing so nothing else sees them on the approach.
    const CROSS = { x: -125, z: 3.5, fx: 0.944, fz: 0.33 };
    /**
     * A point behind the crossing ego, measured along its heading and to its right.
     * @param {number} behind Distance behind the ego centre.
     * @param {number} right Distance to the right of the ego centre.
     * @returns {[number, number]} X and z.
     */
    const behindEgo = (behind, right) => [CROSS.x - behind * CROSS.fx - right * CROSS.fz, CROSS.z - behind * CROSS.fz + right * CROSS.fx];
    const EGO_HALF = 4.5 / 2;
    const BIKE_HALF = 1.9 / 2;

    it('keeps gapBehindM as the floor for a slowly moving car behind in the target lane', async () => {
      // Bumper gap about 3 m; the time gap alone would ask for only 0.3 m at 0.6 m/s.
      expect(await merge((t) => (t >= 2.3 ? [pose('npc-1', 'car', -133.5, 5.25, { speed: 0.6 })] : []))).toEqual(['lane-change:1:D6.2.a']);
    });

    it('uses the gapMotorbikeMinM floor for a moving motorbike behind in the strip', async () => {
      const bikeAt = (/** @type {number} */ gap) => {
        const [x, z] = behindEgo(gap + EGO_HALF + BIKE_HALF, 0.9);
        return (/** @type {number} */ t) => (t >= 2.3 ? [pose('npc-1', 'motorbike', x, z, { speed: 3 })] : []);
      };
      // At 3 m/s the time gap alone asks for 1.5 m, so 1.8 m fires only through the 2 m floor.
      expect(await merge(bikeAt(3))).toEqual([]);
      expect(await merge(bikeAt(1.8))).toEqual(['lane-change:1:D6.2.a']);
    });
  });

  describe('wrecks', () => {
    /**
     * Stands in the junction box for 5 s with a vehicle beside the ego, within yieldRadiusM.
     * @param {Partial<ActorPose>} more Pose fields of the vehicle.
     * @returns {Promise<string[]>} Summary.
     */
    const waitInBox = (more) =>
      run({ map: JUNCTION, path: [[0, 1.75], [10, 1.75]], speed: 0, durationS: 5, extraActors: () => [pose('npc-1', 'car', -5, -1.75, { heading: Math.PI, speed: 3, ...more })] });

    it('lets moving traffic in the junction exempt a stop', async () => {
      expect(await waitInBox({})).toEqual([]);
    });

    it('treats a wreck as a stopped vehicle that exempts nothing', async () => {
      expect(await waitInBox({ state: 'crashed' })).toEqual(['stopping:0:D6.3.đ']);
    });
  });
});
