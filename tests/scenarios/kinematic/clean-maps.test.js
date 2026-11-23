import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/rules/lib/test-support.js';
import { gatesOf, laneLineCrossings, loadShippedMap, planDrive, runPlan, vehicleOf } from './drive.js';

/** Ids of every shipped map, from the generated index. */
const MAP_IDS = JSON.parse(readFileSync(path.join(ROOT, 'public', 'maps', 'index.json'), 'utf8')).map((m) => m.id);
const VEHICLES = /** @type {const} */ (['car-sedan', 'scooter']);

describe('clean kinematic runs of every shipped map', () => {
  it('the index lists all four shipped maps', () => {
    expect(MAP_IDS.sort()).toEqual(['osm-pasteur', 'tutorial-01-co-ban', 'tutorial-02-nga-tu', 'tutorial-03-ban-dem']);
  });

  for (const id of MAP_IDS) {
    for (const vehicleId of VEHICLES) {
      it(`${id} as ${vehicleId} scores 10, finishes, and halts for the lights, signs and crossings`, async () => {
        const map = loadShippedMap(id);
        const plan = planDrive(map, vehicleOf(vehicleId));
        const { report, frames } = await runPlan(map, vehicleId, plan);
        expect(report.breaches).toEqual([]);
        expect(report.score).toBe(10);
        expect(report.endedBy).toBe('finish');
        const halfLength = vehicleOf(vehicleId).lengthM / 2;
        for (const gate of gatesOf(map, plan.path, halfLength)) {
          if (gate.kind === 'signal') {
            // The front crosses a signalised line only on green.
            const k = plan.sPerTick.findIndex((sd) => sd >= gate.s - halfLength);
            expect(k, `${gate.id} is crossed`).toBeGreaterThanOrEqual(0);
            expect(frames[k].trafficLights[gate.signalId], `${gate.id} at crossing`).toBe('green');
          }
          if (gate.kind === 'stop-sign') {
            // The car halts within a metre of its stop point before the R.122 line.
            const halted = frames.some((f, k) => f.ego.speed < 0.05 && Math.abs(plan.sPerTick[k] - gate.sStop) < 1);
            expect(halted, `${gate.id} halt`).toBe(true);
          }
        }
      }, 120000);
    }
  }

  it('the routes draw one lane change to the kerb lane on tutorial 01 and on osm-pasteur, none on the others', () => {
    const sides = (/** @type {string} */ id) => {
      const map = loadShippedMap(id);
      return laneLineCrossings(map, planDrive(map, vehicleOf('car-sedan')).path).map((c) => c.side);
    };
    expect(sides('tutorial-01-co-ban')).toEqual(['right']);
    expect(sides('osm-pasteur')).toEqual(['right']);
    expect(sides('tutorial-02-nga-tu')).toEqual([]);
    expect(sides('tutorial-03-ban-dem')).toEqual([]);
  }, 120000);

  it('gives byte-equal frames for the same plan', async () => {
    const map = loadShippedMap('tutorial-02-nga-tu');
    const a = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan')));
    const b = await runPlan(map, 'car-sedan', planDrive(map, vehicleOf('car-sedan')));
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  }, 120000);
});
