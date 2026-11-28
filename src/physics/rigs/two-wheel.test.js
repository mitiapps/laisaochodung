import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { kmhToMps } from '../../contracts/units.js';
import { DT } from '../../contracts/units.js';
import { neutralInput } from '../../contracts/controls.js';
import { brakeToStop, createBench, driveCircle } from '../bench.js';
import { GROUP, interactionGroups } from '../collision-groups.js';
import { carSedan } from '../vehicles/car-sedan.js';
import { scooter } from '../vehicles/scooter.js';
import { pushBackForce, twoWheelCommands } from './two-wheel.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('twoWheelCommands', () => {
  it('brakes front and rear independently and never drives a braking wheel', () => {
    const c = twoWheelCommands(scooter, { ...neutralInput(), brakeFront: 1, throttle: 1 }, 500, 0.1);
    expect(c[0]).toMatchObject({ brake: scooter.brakes.frontCap, engine: 0, steer: 0.1 });
    expect(c[1]).toMatchObject({ engine: 500, steer: 0 });
    const r = twoWheelCommands(scooter, { ...neutralInput(), brakeRear: 1, throttle: 1 }, 500, 0);
    expect(r[1]).toMatchObject({ brake: scooter.brakes.rearCap, engine: 0 });
  });
});

describe('pushBackForce', () => {
  const spec = scooter.pushBack;
  const held = { ...neutralInput(), pushBack: true };

  it('pushes at full force from rest or rolling slowly forward, fading to zero at the cap', () => {
    expect(pushBackForce(spec, held, 0)).toEqual({ acting: true, forceN: -150 });
    expect(pushBackForce(spec, held, 0.5)).toEqual({ acting: true, forceN: -150 });
    expect(pushBackForce(spec, held, -0.4).forceN).toBeCloseTo(-75);
    expect(pushBackForce(spec, held, -0.8)).toEqual({ acting: true, forceN: 0 });
    expect(pushBackForce(spec, held, -1.2)).toEqual({ acting: true, forceN: 0 });
  });

  it('does not act without the key, with throttle or a brake, above 0.5 m/s forward, or on a car', () => {
    expect(pushBackForce(spec, neutralInput(), 0).acting).toBe(false);
    expect(pushBackForce(spec, { ...held, throttle: 0.02 }, 0).acting).toBe(true);
    expect(pushBackForce(spec, { ...held, throttle: 0.03 }, 0).acting).toBe(false);
    expect(pushBackForce(spec, { ...held, brakeFront: 0.1 }, 0).acting).toBe(false);
    expect(pushBackForce(spec, { ...held, brakeRear: 0.1 }, 0).acting).toBe(false);
    expect(pushBackForce(spec, held, 0.51).acting).toBe(false);
    expect(pushBackForce(carSedan.pushBack, held, 0)).toEqual({ acting: false, forceN: 0 });
  });

  it('drives the rear wheel backwards and lifts the coast brake from both wheels while pushing', () => {
    const c = twoWheelCommands(scooter, held, 18, 0, -150);
    expect(c[0]).toMatchObject({ engine: 0, brake: 0 });
    expect(c[1]).toMatchObject({ engine: -150, brake: 0 });
    const idle = twoWheelCommands(scooter, held, 0, 0, 0);
    expect(idle.map((w) => w.brake)).toEqual([scooter.brakes.coastCap, scooter.brakes.coastCap]);
  });
});

/**
 * Runs the bench for a time with one input.
 * @param {import('../bench.js').Bench} bench Bench.
 * @param {number} seconds Seconds.
 * @param {Partial<import('../../contracts/controls.js').ControlInput>} input Input.
 * @returns {import('../vehicle.js').VehicleReadout[]} Readouts.
 */
function hold(bench, seconds, input) {
  /** @type {import('../vehicle.js').VehicleReadout[]} */
  const out = [];
  for (let k = 0; k < Math.round(seconds / DT); k += 1) out.push(bench.step(input));
  return out;
}

describe('scooter push-back on the bench', () => {
  it('moves a stopped scooter back at least 1 m in 3 s, never faster than 0.8 m/s, in gear R', () => {
    const bench = createBench(RAPIER, scooter);
    const x0 = bench.vehicle.pose().pos.x;
    const r = hold(bench, 3, { pushBack: true });
    expect(x0 - r[r.length - 1].pos.x).toBeGreaterThanOrEqual(1);
    expect(Math.min(...r.map((s) => s.speed))).toBeGreaterThanOrEqual(-0.8);
    expect(r.every((s) => s.gear === 'R')).toBe(true);
    // Released, the gear reads D again and the coast brake stops the bike (about 0.1 m/s²).
    const after = hold(bench, 10, {});
    expect(after[0].gear).toBe('D');
    expect(Math.abs(after[after.length - 1].speed)).toBeLessThan(0.01);
    bench.dispose();
  });

  it('does not move with a brake held for 2 s', () => {
    for (const brake of [{ brakeFront: 1 }, { brakeRear: 1 }, { brakeFront: 0.1 }]) {
      const bench = createBench(RAPIER, scooter);
      const x0 = bench.vehicle.pose().pos.x;
      const r = hold(bench, 2, { pushBack: true, ...brake });
      expect(Math.abs(r[r.length - 1].pos.x - x0)).toBeLessThan(0.01);
      expect(r.every((s) => s.gear === 'D')).toBe(true);
      bench.dispose();
    }
  });

  it('is cancelled by the throttle: the bike drives forward in D', () => {
    const bench = createBench(RAPIER, scooter);
    const x0 = bench.vehicle.pose().pos.x;
    hold(bench, 1, { pushBack: true });
    const r = hold(bench, 2, { pushBack: true, throttle: 0.5 });
    expect(r[r.length - 1].pos.x).toBeGreaterThan(x0 + 1);
    expect(r[r.length - 1].gear).toBe('D');
    expect(r[r.length - 1].speed).toBeGreaterThan(1);
    bench.dispose();
  });

  it('does nothing while rolling forward at 2 m/s', () => {
    const pushed = createBench(RAPIER, scooter);
    const coasting = createBench(RAPIER, scooter);
    pushed.launch(2);
    coasting.launch(2);
    const a = hold(pushed, 1, { pushBack: true });
    const b = hold(coasting, 1, {});
    expect(a.every((s) => s.gear === 'D')).toBe(true);
    expect(a[a.length - 1].speed).toBeGreaterThan(0.5);
    expect(a[a.length - 1].pos.x).toBeCloseTo(b[b.length - 1].pos.x, 3);
    pushed.dispose();
    coasting.dispose();
  });

  it('is ignored by the car', () => {
    const bench = createBench(RAPIER, carSedan);
    const x0 = bench.vehicle.pose().pos.x;
    const r = hold(bench, 3, { pushBack: true });
    expect(Math.abs(r[r.length - 1].pos.x - x0)).toBeLessThan(0.01);
    expect(r.every((s) => s.gear === 'N')).toBe(true);
    bench.dispose();
  });

  it('backs a scooter clear of a wall it stopped against head-on, then rides off past it', () => {
    const bench = createBench(RAPIER, scooter);
    // A 3 m wide wall square across the path, its near face 6 m ahead.
    bench.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 1, 1.5)
        .setTranslation(6.5, 1, 0)
        .setCollisionGroups(interactionGroups(GROUP.STATIC, GROUP.EGO)),
    );
    let r = hold(bench, 3, { throttle: 0.3 });
    const nose = r[r.length - 1].pos.x + scooter.chassis.halfLength;
    expect(nose).toBeGreaterThan(5.8);
    expect(nose).toBeLessThan(6.1);
    expect(Math.abs(r[r.length - 1].speed)).toBeLessThan(0.1);
    // Throttle alone cannot get past it.
    r = hold(bench, 1, { throttle: 0.3, steer: -1 });
    expect(r[r.length - 1].pos.x + scooter.chassis.halfLength).toBeLessThan(6.1);
    // Back off on full right lock (steer +1 is right), so the nose swings left.
    const backed = hold(bench, 3, { pushBack: true, steer: 1 });
    const end = backed[backed.length - 1];
    expect(nose - scooter.chassis.halfLength - end.pos.x).toBeGreaterThan(1);
    // Ride off on full left lock, then straight: the bike ends past the wall.
    hold(bench, 1.5, { throttle: 0.4, steer: -1 });
    r = hold(bench, 4, { throttle: 0.4 });
    expect(r[r.length - 1].pos.x).toBeGreaterThan(8);
    bench.dispose();
  });
});

describe('rig A (two in-line ray wheels, roll and pitch locked)', () => {
  it('holds a 20 m radius turn at 30 km/h inside a 3.5 m lane without skidding', () => {
    const bench = createBench(RAPIER, scooter);
    bench.launch(kmhToMps(30));
    const r = driveCircle(bench, { cx: 0, cz: -20, radius: 20, left: true, speedMps: kmhToMps(30), seconds: 20, settleS: 5 });
    // Lane half width 1.75 m minus the half body width 0.35 m.
    expect(r.maxRadialError).toBeLessThan(1.4);
    expect(r.meanSpeed).toBeGreaterThan(kmhToMps(28));
    expect(r.skidSteps).toBe(0);
    const q = bench.vehicle.body.rotation();
    expect(Math.abs(q.x) + Math.abs(q.z)).toBeLessThan(1e-6);
    bench.dispose();
  });

  it('stops from 50 km/h on both brakes in 11 to 16 m without a front skid', () => {
    const bench = createBench(RAPIER, scooter);
    const r = brakeToStop(bench, kmhToMps(50), { brakeFront: 0.5, brakeRear: 1 });
    expect(r.distance).toBeGreaterThan(11);
    expect(r.distance).toBeLessThan(16);
    expect(r.fell).toBe(false);
    expect(r.frontSkidSteps).toBe(0);
    expect(r.backwardM).toBeLessThan(0.05);
    bench.dispose();
  });

  it('flags a front skid and falls on a hard front-only stop above 30 km/h', () => {
    const bench = createBench(RAPIER, scooter);
    const r = brakeToStop(bench, kmhToMps(40), { brakeFront: 1 });
    expect(r.frontSkidSteps).toBeGreaterThan(18);
    expect(r.fell).toBe(true);
    bench.dispose();
  });

  it('does not fall on a hard front-only stop from below 30 km/h', () => {
    const bench = createBench(RAPIER, scooter);
    expect(brakeToStop(bench, kmhToMps(25), { brakeFront: 1 }).fell).toBe(false);
    bench.dispose();
  });

  it('locks the front at full lever whatever the rear does (no load transfer with pitch locked)', () => {
    const bench = createBench(RAPIER, scooter);
    expect(brakeToStop(bench, kmhToMps(50), { brakeFront: 1, brakeRear: 1 }).fell).toBe(true);
    bench.dispose();
  });

  it('keeps a front lever of 0.35 with full rear safe in rain at 50 km/h', () => {
    const bench = createBench(RAPIER, scooter, 0.6);
    expect(brakeToStop(bench, kmhToMps(50), { brakeFront: 0.35, brakeRear: 1 }).fell).toBe(false);
    bench.dispose();
  });

  it('stops longer in rain', () => {
    const dry = createBench(RAPIER, scooter);
    const wet = createBench(RAPIER, scooter, 0.6);
    const input = { brakeFront: 0.3, brakeRear: 1 };
    expect(brakeToStop(wet, kmhToMps(50), input).distance).toBeGreaterThan(brakeToStop(dry, kmhToMps(50), input).distance + 2);
    dry.dispose();
    wet.dispose();
  });
});
