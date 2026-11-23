import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { kmhToMps } from '../../contracts/units.js';
import { neutralInput } from '../../contracts/controls.js';
import { brakeToStop, createBench, driveCircle } from '../bench.js';
import { carSedan } from '../vehicles/car-sedan.js';
import { fourWheelCommands } from './four-wheel.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('fourWheelCommands', () => {
  it('splits one pedal 70/30 and gives no engine force to a braking wheel', () => {
    const c = fourWheelCommands(carSedan, { ...neutralInput(), brakeFront: 1, throttle: 1 }, 4000, 0.2);
    const front = c[0].brake + c[1].brake;
    const rear = c[2].brake + c[3].brake;
    expect(front / (front + rear)).toBeCloseTo(0.7);
    expect(c.every((w) => w.engine === 0)).toBe(true);
    expect(c.map((w) => w.steer)).toEqual([0.2, 0.2, 0, 0]);
  });

  it('drives the rear wheels only', () => {
    const c = fourWheelCommands(carSedan, { ...neutralInput(), throttle: 1 }, 4000, 0);
    expect(c.map((w) => w.engine)).toEqual([0, 0, 2000, 2000]);
    expect(c[0].brake).toBe(carSedan.brakes.coastCap);
  });

  it('locks the rear and lowers its side grip on the handbrake', () => {
    const c = fourWheelCommands(carSedan, { ...neutralInput(), handbrake: true, throttle: 1 }, 4000, 0);
    expect(c[2]).toMatchObject({ brake: carSedan.brakes.handbrakeCap, engine: 0, sideStiffness: 0.3 });
    expect(c[0].sideStiffness).toBe(1);
  });
});

describe('car rig', () => {
  it('stops from 50 km/h in 11 to 16 m on dry asphalt with a skid flag (friction-limited)', () => {
    const bench = createBench(RAPIER, carSedan);
    const r = brakeToStop(bench, kmhToMps(50), { brakeFront: 1 });
    expect(r.distance).toBeGreaterThan(11);
    expect(r.distance).toBeLessThan(16);
    expect(r.skidSteps).toBeGreaterThan(30);
    bench.dispose();
  });

  it('does not move backwards after stopping', () => {
    const bench = createBench(RAPIER, carSedan);
    const r = brakeToStop(bench, kmhToMps(50), { brakeFront: 1 }, 3);
    expect(r.backwardM).toBeLessThan(0.05);
    expect(r.minSpeedAfterStop).toBeGreaterThan(-0.1);
    bench.dispose();
  });

  it('flags no skid on a stop limited by the brake cap', () => {
    const bench = createBench(RAPIER, carSedan);
    const r = brakeToStop(bench, kmhToMps(50), { brakeFront: 0.2 });
    expect(r.skidSteps).toBe(0);
    expect(r.distance).toBeGreaterThan(16);
    bench.dispose();
  });

  it('stops longer in rain', () => {
    const dry = createBench(RAPIER, carSedan);
    const wet = createBench(RAPIER, carSedan, 0.6);
    const d = brakeToStop(dry, kmhToMps(50), { brakeFront: 1 }).distance;
    const w = brakeToStop(wet, kmhToMps(50), { brakeFront: 1 }).distance;
    expect(w).toBeGreaterThan(d * 1.4);
    dry.dispose();
    wet.dispose();
  });

  it('holds a 20 m radius turn at 30 km/h without skidding', () => {
    const bench = createBench(RAPIER, carSedan);
    bench.step({ gearCmd: 'up' });
    bench.step({ gearCmd: 'up' });
    bench.launch(kmhToMps(30));
    const r = driveCircle(bench, { cx: 0, cz: -20, radius: 20, left: true, speedMps: kmhToMps(30), seconds: 20, settleS: 5 });
    expect(r.maxRadialError).toBeLessThan(0.9);
    expect(r.meanSpeed).toBeGreaterThan(kmhToMps(28));
    expect(r.skidSteps).toBe(0);
    bench.dispose();
  });

  it('accelerates in first gear, not in neutral, and reverses in R', () => {
    const neutral = createBench(RAPIER, carSedan);
    let r = neutral.vehicle.read();
    for (let k = 0; k < 60; k += 1) r = neutral.step({ throttle: 1 });
    expect(r.speed).toBeLessThan(0.05);
    expect(r.gear).toBe('N');
    neutral.dispose();

    const first = createBench(RAPIER, carSedan);
    first.step({ gearCmd: 'up' });
    for (let k = 0; k < 120; k += 1) r = first.step({ throttle: 1 });
    expect(r.gear).toBe(1);
    // About 4 m/s² for two seconds.
    expect(r.speed).toBeGreaterThan(6);
    expect(r.rpm).toBeGreaterThan(carSedan.gearbox.idleRpm);
    first.dispose();

    const rev = createBench(RAPIER, carSedan);
    rev.step({ gearCmd: 'down' });
    for (let k = 0; k < 60; k += 1) r = rev.step({ throttle: 0.5 });
    expect(r.gear).toBe('R');
    expect(r.speed).toBeLessThan(-0.5);
    rev.dispose();
  });

  it('turns left for negative steer input and reports the wheel angle + left', () => {
    const bench = createBench(RAPIER, carSedan);
    bench.step({ gearCmd: 'up' });
    bench.launch(8);
    let r = bench.vehicle.read();
    for (let k = 0; k < 30; k += 1) r = bench.step({ steer: -1, throttle: 0.3 });
    expect(r.yawRate).toBeGreaterThan(0.1);
    expect(r.wheels[0].steer).toBeGreaterThan(0);
    expect(r.wheels[0].spin).toBeGreaterThan(0);
    bench.dispose();
  });
});
