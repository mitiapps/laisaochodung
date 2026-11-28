import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTOR_LIGHTS, assertFrame, checkFrame, DT } from '../contracts/index.js';
import { pointInPolygon } from '../geometry/index.js';
import { buildFrames, laneCenterline, scriptValue } from './index.js';

const FIXTURES = new URL('../../tests/fixtures/', import.meta.url);
/** @type {import('../contracts/index.js').GameMap} */
const MAP = JSON.parse(readFileSync(new URL('map-minimal.json', FIXTURES), 'utf8'));
/** @type {import('../contracts/index.js').VehicleInfo[]} */
const VEHICLES = JSON.parse(readFileSync(new URL('../../data/vehicles/vehicles.json', import.meta.url), 'utf8'));
const CAR = /** @type {import('../contracts/index.js').VehicleInfo} */ (VEHICLES.find((v) => v.id === 'car-sedan'));
const SCOOTER = /** @type {import('../contracts/index.js').VehicleInfo} */ (VEHICLES.find((v) => v.id === 'scooter'));

/** Script of the committed `frames-straight.json` fixture. */
const STRAIGHT = { map: MAP, vehicle: CAR, laneId: 'rw-e', startS: 5, durationS: 2, speed: 15 };

/**
 * @param {import('../contracts/index.js').Polygon} polygon Lane polygon.
 * @param {import('../contracts/index.js').Frame} f Frame.
 * @returns {boolean} Every footprint corner inside.
 */
function footprintInside(polygon, f) {
  return f.ego.footprint.every((p) => pointInPolygon(p, polygon));
}

describe('scriptValue', () => {
  it('interpolates keyframes and holds the ends', () => {
    const k = [
      { t: 1, value: 0 },
      { t: 3, value: 10 },
    ];
    expect(scriptValue(k, 0)).toBe(0);
    expect(scriptValue(k, 2)).toBe(5);
    expect(scriptValue(k, 9)).toBe(10);
    expect(scriptValue(7, 3)).toBe(7);
  });
});

describe('buildFrames', () => {
  it('regenerates tests/fixtures/frames-straight.json exactly', () => {
    const frames = buildFrames(STRAIGHT);
    const url = new URL('frames-straight.json', FIXTURES);
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(url, `${JSON.stringify(frames)}\n`);
    expect(JSON.parse(readFileSync(url, 'utf8'))).toEqual(JSON.parse(JSON.stringify(frames)));
  });

  it('emits a null route and no route events with the route off', () => {
    const scored = buildFrames({ ...STRAIGHT, startS: 0, durationS: undefined, speed: 30 });
    expect(scored.some((f) => f.events.some((e) => e.type === 'checkpoint'))).toBe(true);
    const free = buildFrames({ ...STRAIGHT, startS: 0, durationS: undefined, speed: 30, route: 'off' });
    expect(free.length).toBeGreaterThan(0);
    for (const f of free) {
      assertFrame(f);
      expect(f.route).toBeNull();
      expect(f.events.filter((e) => ['checkpoint', 'finish', 'timeout'].includes(e.type))).toEqual([]);
    }
  });

  it('drives 120 valid frames at 15 m/s inside the eastbound lane', () => {
    const frames = buildFrames(STRAIGHT);
    expect(frames).toHaveLength(120);
    const lane = MAP.roads[0].lanes[0];
    expect(lane.id).toBe('rw-e');
    frames.forEach((f, i) => {
      assertFrame(f);
      expect(f.tick).toBe(i);
      expect(f.t).toBeCloseTo(i * DT, 12);
      expect(f.ego.speed).toBe(15);
      expect(footprintInside(lane.polygon, f)).toBe(true);
    });
    expect(frames[0].events).toEqual([{ type: 'run-start' }]);
    expect(frames[0].ego.pos).toEqual({ x: 5, y: 0, z: 1.75 });
    expect(frames[119].ego.pos.x).toBeCloseTo(5 + 119 * 15 * DT, 9);
    expect(frames[0].ego.gear).toBe(4);
    expect(frames[0].env.clockMin).toBe(600);
    expect(frames[0].trafficLights).toEqual({ 'sig-w': 'green', 'sig-e': 'green', 'sig-n': 'red', 'sig-s': 'red' });
  });

  it('stops at a red light with a keyframed speed and shows the NPC passing', () => {
    const frames = buildFrames({
      map: MAP,
      vehicle: SCOOTER,
      laneId: 'rw-e',
      durationS: 12,
      speed: [
        { t: 0, value: 10 },
        { t: 6, value: 10 },
        { t: 8, value: 0 },
      ],
      controls: [{ t: 0, lights: 'low' }],
    });
    const last = frames[frames.length - 1];
    expect(last.ego.speed).toBe(0);
    expect(last.ego.gear).toBe('D');
    expect(last.ego.wheels).toHaveLength(2);
    expect(last.ego.lights).toBe('low');
    expect(frames.some((f) => f.ego.input.brakeFront > 0)).toBe(true);
    expect(frames.every((f) => checkFrame(f).length === 0)).toBe(true);
    const npc = last.actors.find((a) => a.id === 'npc-1');
    expect(npc?.pos.x).toBeLessThan(195);
  });

  it('applies lateral offset to the left, controls and forced events', () => {
    const frames = buildFrames({
      map: MAP,
      vehicle: CAR,
      laneId: 'rw-e',
      durationS: 3,
      speed: 10,
      offset: [
        { t: 1, value: 0 },
        { t: 2, value: 3.5 },
      ],
      controls: [
        { t: 0.5, indicators: 'left' },
        { t: 2.5, indicators: 'off', horn: true },
      ],
      events: [
        {
          t: 2,
          event: {
            type: 'collision',
            otherKind: 'static',
            otherId: null,
            impulse: 10,
            egoSpeed: 10,
            relSpeed: 10,
            sameLaneAhead: false,
          },
        },
      ],
    });
    const atTick = (/** @type {number} */ t) => frames[Math.round(t / DT)];
    expect(atTick(0.25).ego.indicators).toBe('off');
    expect(atTick(1).ego.indicators).toBe('left');
    expect(atTick(2.9).ego.pos.z).toBeCloseTo(-1.75, 9);
    expect(atTick(1.5).ego.heading).toBeGreaterThan(0);
    // The heading turns where the offset ramp starts, then stays constant along the ramp.
    expect(atTick(1).ego.yawRate).toBeGreaterThan(0);
    expect(atTick(1.5).ego.yawRate).toBeCloseTo(0, 9);
    expect(atTick(2.9).ego.horn).toBe(true);
    expect(atTick(2).events.map((e) => e.type)).toEqual(['collision']);
    frames.forEach((f) => assertFrame(f));
  });

  it('emits checkpoints and the finish on a full drive and stops there', () => {
    const path = [...laneCenterline(MAP, 'rw-e'), ...laneCenterline(MAP, 're-e')];
    const frames = buildFrames({ map: MAP, vehicle: CAR, path, startS: 5, speed: 14 });
    const events = frames.flatMap((f) => f.events.map((e) => e.type));
    expect(events).toEqual(['run-start', 'checkpoint', 'checkpoint', 'finish']);
    expect(frames[frames.length - 1].events).toEqual([{ type: 'finish' }]);
  });

  it('times out at the map time limit when the ego never arrives', () => {
    const frames = buildFrames({ map: MAP, vehicle: CAR, laneId: 'rw-e', speed: 0 });
    expect(frames[frames.length - 1].events).toEqual([{ type: 'timeout' }]);
    expect(frames[frames.length - 1].t).toBeCloseTo(MAP.route.timeLimitS, 9);
  });

  it('rejects a missing path and an unknown lane', () => {
    expect(() => buildFrames({ map: MAP, vehicle: CAR, speed: 1 })).toThrow();
    expect(() => buildFrames({ map: MAP, vehicle: CAR, laneId: 'nope', speed: 1 })).toThrow(/Unknown lane/);
  });

  it('appends extra traffic poses and events, and holds scripted actors behind them', () => {
    // A stopped motorbike in the westbound lane 6 m ahead of the scripted NPC car.
    /** @type {import('../contracts/index.js').ActorPose} */
    const moto = {
      id: 'npc-0',
      kind: 'motorbike',
      pos: { x: 195 - 2.25 - 6 - 0.95, z: -1.75 },
      heading: Math.PI,
      speed: 0,
      active: true,
      model: 'motorbike',
      variant: 1,
      lengthM: 1.9,
      widthM: 0.8,
      lights: ACTOR_LIGHTS.hazard,
      state: 'fallen',
      violations: Object.freeze(/** @type {import('../contracts/index.js').NpcViolation[]} */ (['red-light'])),
    };
    /** @type {import('../contracts/index.js').FrameEvent} */
    const hit = {
      type: 'collision',
      otherKind: 'motorbike',
      otherId: 'npc-0',
      impulse: 300,
      egoSpeed: 5,
      relSpeed: 5,
      sameLaneAhead: false,
      otherModel: 'motorbike',
      striker: 'other',
      otherFromBehind: false,
      otherViolations: moto.violations,
    };
    const frames = buildFrames({
      ...STRAIGHT,
      extraActors: (t) => (t < 1 ? [moto] : []),
      extraEvents: (t) => (Math.abs(t - 0.5) < DT / 2 ? [hit] : []),
    });
    frames.forEach((f) => assertFrame(f));
    const early = frames[10];
    expect(early.actors.map((a) => a.id)).toEqual(['ped-1', 'npc-1', 'npc-0']);
    expect(early.actors.find((a) => a.id === 'npc-1')?.speed).toBe(0);
    expect(frames[90].actors.map((a) => a.id)).toEqual(['ped-1', 'npc-1']);
    expect(frames[90].actors.find((a) => a.id === 'npc-1')?.speed).toBe(10);
    expect(frames[30].events).toEqual([hit]);
    expect(frames.flatMap((f) => f.events).filter((e) => e.type === 'collision')).toHaveLength(1);
  });
});
