import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { footprint } from '../geometry/index.js';
import { DT } from '../contracts/units.js';
import { ACTOR_LIGHTS, NO_VIOLATIONS } from '../contracts/telemetry.js';
import {
  CHECKPOINT_DEPTH_M,
  clockAt,
  createActorState,
  createRouteState,
  finishTarget,
  signalState,
  actorStoppingDistance,
  stepActors,
  stepRoute,
  trafficLightStates,
} from './index.js';
import { againstLane } from './actors.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-minimal.json', import.meta.url), 'utf8'));

/** A footprint far from every path and trigger. */
const AWAY = footprint({ x: -500, z: -500 }, 0, 4.5, 1.8);

/**
 * @param {Partial<import('../contracts/index.js').SignalCycle>} cycle Cycle fields.
 * @returns {import('../contracts/index.js').Signal} Signal.
 */
function signal(cycle) {
  return {
    id: 's',
    pos: { x: 0, z: 0 },
    heading: 0,
    stopLineIds: [],
    cycle: { green: 10, yellow: 3, red: 7, offset: 0, ...cycle },
  };
}

describe('signalState', () => {
  it('switches on half-open phase edges', () => {
    const s = signal({});
    expect(signalState(s, 0)).toBe('green');
    expect(signalState(s, 9.999)).toBe('green');
    expect(signalState(s, 10)).toBe('yellow');
    expect(signalState(s, 12.999)).toBe('yellow');
    expect(signalState(s, 13)).toBe('red');
    expect(signalState(s, 19.999)).toBe('red');
    expect(signalState(s, 20)).toBe('green');
  });

  it('applies the offset as the cycle position at t = 0', () => {
    const s = signal({ offset: 13 });
    expect(signalState(s, 0)).toBe('red');
    expect(signalState(s, 7)).toBe('green');
  });

  it('rejects an empty cycle', () => {
    expect(() => signalState(signal({ green: 0, yellow: 0, red: 0 }), 1)).toThrow(RangeError);
  });

  it('keeps the fixture junction phases opposed', () => {
    for (const t of [0, 10, 26.9, 31, 45, 56.9]) {
      const lights = trafficLightStates(MAP, t);
      expect(lights['sig-w']).toBe(lights['sig-e']);
      expect(lights['sig-w'] === 'green' && lights['sig-n'] === 'green').toBe(false);
    }
  });
});

describe('clockAt', () => {
  it('advances one minute per 60 s and wraps at midnight', () => {
    expect(clockAt({ startClockMin: 600, weather: 'clear', surfaceGrip: 1 }, 120)).toBeCloseTo(602);
    expect(clockAt({ startClockMin: 1439, weather: 'clear', surfaceGrip: 1 }, 120)).toBeCloseTo(1);
  });
});

describe('stepActors', () => {
  it('starts a time-triggered car and moves it speed · DT per step', () => {
    let state = createActorState(MAP);
    const first = stepActors(state, MAP, [AWAY], 0, DT);
    const npc = first.poses.find((p) => p.id === 'npc-1');
    expect(npc).toMatchObject({ pos: { x: 195, z: -1.75 }, active: true, speed: 10 });
    expect(npc?.heading).toBeCloseTo(Math.PI);
    state = first.state;
    const second = stepActors(state, MAP, [AWAY], 0, DT);
    expect(second.poses.find((p) => p.id === 'npc-1')?.pos.x).toBeCloseTo(195 - 10 * DT);
  });

  it('holds an NPC car behind a stationary footprint on its path and releases it when it leaves', () => {
    // Ego stopped in the westbound lane 6 m ahead of the NPC's front.
    const blocker = footprint({ x: 195 - 2.25 - 6 - 2.25, z: -1.75 }, Math.PI, 4.5, 1.8);
    let state = createActorState(MAP);
    for (let i = 0; i < 120; i += 1) {
      const r = stepActors(state, MAP, [blocker], 0, DT);
      const npc = r.poses.find((p) => p.id === 'npc-1');
      expect(npc?.speed).toBe(0);
      expect(npc?.active).toBe(true);
      expect(npc?.pos.x).toBeCloseTo(195);
      state = r.state;
    }
    const released = stepActors(state, MAP, [AWAY], 0, DT);
    expect(released.poses.find((p) => p.id === 'npc-1')?.speed).toBe(10);
    expect(stepActors(released.state, MAP, [AWAY], 0, DT).poses.find((p) => p.id === 'npc-1')?.pos.x).toBeLessThan(195);
  });

  it('does not hold for a footprint in the opposite lane', () => {
    const beside = footprint({ x: 185, z: 1.75 }, 0, 4.5, 1.8);
    const r = stepActors(createActorState(MAP), MAP, [beside], 0, DT);
    expect(r.poses.find((p) => p.id === 'npc-1')?.speed).toBe(10);
  });

  it('starts a pedestrian only when the ego reaches its trigger, then holds it for a car on the crossing', () => {
    let state = createActorState(MAP);
    let r = stepActors(state, MAP, [AWAY], 0, DT);
    expect(r.poses.find((p) => p.id === 'ped-1')?.active).toBe(false);
    const inTrigger = footprint({ x: 50, z: 1.75 }, 0, 4.5, 1.8);
    r = stepActors(r.state, MAP, [inTrigger], 10, DT);
    expect(r.poses.find((p) => p.id === 'ped-1')).toMatchObject({ active: true, speed: 1.4 });
    state = r.state;
    // A car standing on the zebra right in front of the pedestrian.
    const onCrossing = footprint({ x: 92, z: -1.75 }, Math.PI, 4.5, 1.8);
    r = stepActors(state, MAP, [onCrossing], 0, DT);
    expect(r.poses.find((p) => p.id === 'ped-1')?.speed).toBe(0);
  });

  it('stops a non-looping actor at the end of its path and marks it inactive', () => {
    let state = createActorState(MAP);
    /** @type {import('../contracts/index.js').ActorPose | undefined} */
    let last;
    for (let i = 0; i < 60 * 20 + 5; i += 1) {
      const r = stepActors(state, MAP, [AWAY], 0, DT);
      last = r.poses.find((p) => p.id === 'npc-1');
      state = r.state;
    }
    expect(last).toMatchObject({ active: false, speed: 0 });
    expect(last?.pos.x).toBeCloseTo(5);
  });

  it('wraps a looping actor back to its first point', () => {
    /** @type {import('../contracts/index.js').GameMap} */
    const loopMap = {
      ...MAP,
      actors: [
        {
          id: 'loop',
          kind: 'car',
          model: 'npc-sedan',
          lengthM: 4,
          widthM: 1.8,
          path: [[0, 0], [10, 0], [10, 10], [0, 10]],
          speed: 10,
          trigger: { atS: 0 },
          loop: true,
        },
      ],
    };
    let state = createActorState(loopMap);
    for (let i = 0; i < 60 * 4; i += 1) state = stepActors(state, loopMap, [AWAY], 0, DT).state;
    const pose = stepActors(state, loopMap, [AWAY], 0, DT).poses[0];
    expect(pose.active).toBe(true);
    expect(pose.pos.x).toBeCloseTo(0, 6);
    expect(pose.pos.z).toBeCloseTo(0, 6);
  });

  it('rejects a state built for another map', () => {
    expect(() => stepActors({ t: 0, actors: [] }, MAP, [AWAY], 0, DT)).toThrow();
  });

  it('holds for any blocker but fires polygon triggers only for the ego, the first blocker', () => {
    const blocker = footprint({ x: 195 - 2.25 - 6 - 2.25, z: -1.75 }, Math.PI, 4.5, 1.8);
    const inTrigger = footprint({ x: 50, z: 1.75 }, 0, 4.5, 1.8);
    const r = stepActors(createActorState(MAP), MAP, [AWAY, blocker, inTrigger], 0, DT);
    expect(r.poses.find((p) => p.id === 'npc-1')?.speed).toBe(0);
    expect(r.poses.find((p) => p.id === 'ped-1')?.active).toBe(false);
    const noEgo = stepActors(createActorState(MAP), MAP, [], 0, DT);
    expect(noEgo.poses.find((p) => p.id === 'npc-1')).toMatchObject({ active: true, speed: 10 });
    expect(noEgo.poses.find((p) => p.id === 'ped-1')?.active).toBe(false);
    expect(() => stepActors(createActorState(MAP), MAP, /** @type {never} */ (AWAY), 0, DT)).toThrow(TypeError);
  });

  it('carries the declared violations only while the actor is active, with wrong-way ahead of them against the lane', () => {
    const declared = structuredClone(MAP);
    const carOf = (/** @type {GameMap} */ m) => /** @type {GameMap['actors'][number]} */ (m.actors.find((a) => a.id === 'npc-1'));
    carOf(declared).violations = ['unsafe-lane-change'];
    const flagsOf = (/** @type {GameMap} */ m, /** @type {number} */ t) => {
      const state = { ...createActorState(m), t };
      return stepActors(state, m, [AWAY], 0, DT).poses.find((p) => p.id === 'npc-1')?.violations;
    };
    expect(flagsOf(declared, 0)).toEqual(['unsafe-lane-change']);
    const later = structuredClone(declared);
    carOf(later).trigger = { atS: 1 };
    expect(flagsOf(later, 0)).toBe(NO_VIOLATIONS);
    expect(flagsOf(later, 1)).toEqual(['unsafe-lane-change']);
    const against = structuredClone(declared);
    const npc = carOf(MAP);
    carOf(against).path = npc.path.map(([x, z]) => /** @type {[number, number]} */ ([x, -z]));
    expect(flagsOf(against, 0)).toEqual(['wrong-way', 'unsafe-lane-change']);
  });

  it('brakes a scripted motorbike at the motorbike deceleration', () => {
    const npc = /** @type {GameMap['actors'][number]} */ (MAP.actors.find((a) => a.id === 'npc-1'));
    expect(actorStoppingDistance({ ...npc, kind: 'motorbike', speed: 8 })).toBeCloseTo(8);
  });

  it('fills the traffic pose fields from the map actor with the shared constants', () => {
    const { poses } = stepActors(createActorState(MAP), MAP, [AWAY], 0, DT);
    poses.forEach((pose, i) => {
      const actor = MAP.actors[i];
      expect(pose).toMatchObject({ id: actor.id, model: actor.model, variant: 0, lengthM: actor.lengthM, widthM: actor.widthM });
      expect(pose.lights).toBe(ACTOR_LIGHTS.off);
      expect(pose.violations).toBe(NO_VIOLATIONS);
      expect(pose.state).toBe(pose.speed > 0 ? 'moving' : 'stopped');
    });
    expect(poses.find((p) => p.id === 'npc-1')?.state).toBe('moving');
    expect(poses.find((p) => p.id === 'ped-1')?.state).toBe('stopped');
  });

  it('flags a scripted car travelling against its lane as wrong-way, and only while it travels', () => {
    // npc-1 runs west in the westbound lane; the same path driven in the eastbound lane runs
    // against it.
    const npc = /** @type {GameMap['actors'][number]} */ (MAP.actors.find((a) => a.id === 'npc-1'));
    const against = structuredClone(MAP);
    const car = /** @type {GameMap['actors'][number]} */ (against.actors.find((a) => a.id === 'npc-1'));
    car.path = npc.path.map(([x, z]) => /** @type {[number, number]} */ ([x, -z]));
    car.loop = false;
    let state = createActorState(against);
    let r = stepActors(state, against, [AWAY], 0, DT);
    expect(r.poses.find((p) => p.id === 'npc-1')?.violations).toEqual(['wrong-way']);
    expect(stepActors(createActorState(MAP), MAP, [AWAY], 0, DT).poses.find((p) => p.id === 'npc-1')?.violations).toBe(NO_VIOLATIONS);
    // Parked at the end of its path, it no longer travels against anything.
    for (let i = 0; i < 6000 && r.poses.find((p) => p.id === 'npc-1')?.active; i += 1) {
      state = r.state;
      r = stepActors(state, against, [AWAY], 0, DT);
    }
    expect(r.poses.find((p) => p.id === 'npc-1')?.active).toBe(false);
    expect(r.poses.find((p) => p.id === 'npc-1')?.violations).toBe(NO_VIOLATIONS);
    // Pedestrians never carry it.
    expect(r.poses.find((p) => p.id === 'ped-1')?.violations).toBe(NO_VIOLATIONS);
    expect(againstLane(MAP, [150, 1.75], Math.PI)).toBe(true);
    expect(againstLane(MAP, [150, 1.75], 0)).toBe(false);
    expect(againstLane(MAP, [150, 50], Math.PI)).toBe(false);
  });
});

describe('stepRoute', () => {
  const at = (/** @type {number} */ x) => ({ x, z: 1.75 });

  it('emits checkpoints in order, then the finish, and points nav at the next target', () => {
    let state = createRouteState();
    let r = stepRoute(state, MAP, at(10), 1);
    expect(r.events).toEqual([]);
    expect(r.nav.nextCheckpoint).toBe(0);
    expect(r.nav.distanceM).toBeCloseTo(50);
    expect(r.nav.bearingRad).toBeCloseTo(0);

    // Reaching the finish area before the checkpoints does nothing.
    r = stepRoute(state, MAP, at(190), 2);
    expect(r.events).toEqual([]);

    r = stepRoute(state, MAP, at(60 - CHECKPOINT_DEPTH_M + 0.1), 3);
    expect(r.events).toEqual([{ type: 'checkpoint', index: 0 }]);
    state = r.state;
    r = stepRoute(state, MAP, at(150), 4);
    expect(r.events).toEqual([{ type: 'checkpoint', index: 1 }]);
    state = r.state;
    expect(r.nav.nextCheckpoint).toBe(2);
    expect(r.nav.distanceM).toBeCloseTo(40);
    r = stepRoute(state, MAP, at(186), 5);
    expect(r.events).toEqual([{ type: 'finish' }]);
    expect(stepRoute(r.state, MAP, at(186), 200).events).toEqual([]);
  });

  it('emits timeout once at timeLimitS', () => {
    let r = stepRoute(createRouteState(), MAP, at(10), MAP.route.timeLimitS - DT);
    expect(r.events).toEqual([]);
    r = stepRoute(r.state, MAP, at(10), MAP.route.timeLimitS);
    expect(r.events).toEqual([{ type: 'timeout' }]);
    expect(stepRoute(r.state, MAP, at(10), MAP.route.timeLimitS + 1).events).toEqual([]);
  });

  it('gives the bearing in the heading convention', () => {
    const r = stepRoute(createRouteState(), MAP, { x: 60, z: 51.75 }, 0);
    expect(r.nav.bearingRad).toBeCloseTo(Math.PI / 2);
  });
});

describe('finishTarget', () => {
  /**
   * A map with only the route fields finishTarget reads.
   * @param {{x: number, z: number}} lastPos Last checkpoint position (heading east).
   * @returns {import('../contracts/index.js').GameMap} Map.
   */
  const withRoute = (lastPos) =>
    /** @type {import('../contracts/index.js').GameMap} */ (
      /** @type {unknown} */ ({
        route: {
          start: { pos: { x: 0, z: 1.75 }, heading: 0 },
          checkpoints: [{ pos: lastPos, heading: 0 }],
          // A finish band across both lanes of one direction (z 0 to 7), from x 100 to 110.
          finish: { polygon: [[100, 0], [110, 0], [110, 7], [100, 7]] },
          timeLimitS: 60,
        },
      })
    );

  it('aims at the band straight ahead of the last checkpoint, in its lane', () => {
    expect(finishTarget(withRoute({ x: 50, z: 5.25 }))).toEqual([105, 5.25]);
    expect(finishTarget(withRoute({ x: 50, z: 1.75 }))).toEqual([105, 1.75]);
  });

  it('falls back to the centroid when the band is not straight ahead', () => {
    expect(finishTarget(withRoute({ x: 50, z: 20 }))).toEqual([105, 3.5]);
  });
});
