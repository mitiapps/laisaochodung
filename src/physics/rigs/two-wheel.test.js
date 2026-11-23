import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { kmhToMps } from '../../contracts/units.js';
import { neutralInput } from '../../contracts/controls.js';
import { brakeToStop, createBench, driveCircle } from '../bench.js';
import { scooter } from '../vehicles/scooter.js';
import { twoWheelCommands } from './two-wheel.js';

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
