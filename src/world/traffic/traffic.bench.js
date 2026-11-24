// Traffic step budget: mean ≤ 1.5 ms and p99 ≤ 3.0 ms with 200 agents, asserted after the run.
// Run: npx vitest bench src/world/traffic --run. One bench iteration is one step, so the mean and
// p99 in the table are the budget numbers.
//
// The budget is for `vitest bench`, which runs the step about twice as slow as plain Node. It was
// 1.0 ms while the junction here stood gridlocked (a handful of the 200 agents moving); with the
// junction flowing, every agent plans and moves each step. The real frame check is the browser's
// traffic-perf test.
//
// Measured with the junction flowing, three runs on a quiet machine: mean 1.06 to 1.10 ms and p99
// 1.57 to 1.61 ms under `vitest bench`; the same steps in plain Node, mean 0.56 ms and p99 0.87 ms.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DT } from '../../contracts/units.js';
import { trafficLightStates } from '../signals.js';
import { createTraffic, stepTraffic } from './index.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
/** @type {import('../../contracts/traffic.js').TrafficParams} */
const PARAMS = JSON.parse(readFileSync(new URL('../../generated/traffic-params.json', import.meta.url), 'utf8'));
const AGENTS = 200;

// The junction fixture with 450 m arms, dense on every road, the ring covering the map.
const map = structuredClone(MAP);
for (const lane of map.roads.flatMap((r) => r.lanes)) {
  for (const p of lane.centerline) for (const i of [0, 1]) if (Math.abs(p[i]) === 157) p[i] = 457 * Math.sign(p[i]);
}
const traffic = /** @type {import('../../contracts/map.js').TrafficConfig} */ (map.traffic);
traffic.maxAgents = AGENTS;
traffic.spawnRingM = [0, 700];
traffic.densityPerKm = { rw: 80, re: 80, rn: 80, rs: 80 };

// The ego beside the junction, off the road and looking at it.
const ego = { pos: { x: 20, z: 20 }, heading: 2.4, speed: 0, lengthM: 4.5, widthM: 1.8 };
const st = createTraffic(map, PARAMS, 1);
let tick = 0;

/** One step at the next tick. */
function step() {
  const t = tick * DT;
  stepTraffic(st, { ego, egoReset: false, scripted: [], lights: trafficLightStates(map, t), egoContacts: [], t });
  tick += 1;
}

// Warm up until the map holds the stress size.
for (let i = 0; i < 180 * 60 && st.activeCount < AGENTS; i += 1) step();

/** Step budget, milliseconds. */
const BUDGET = Object.freeze({ meanMs: 1.5, p99Ms: 3.0 });

test(`traffic step with ${AGENTS} agents`, async ({ bench }) => {
  expect(st.activeCount).toBeGreaterThanOrEqual(AGENTS * 0.95);
  const result = await bench('stepTraffic', step).run({ iterations: 10_000, time: 0 });
  expect(st.activeCount).toBeGreaterThanOrEqual(AGENTS * 0.9);
  console.log(`stepTraffic, ${st.activeCount} agents: mean ${result.latency.mean.toFixed(3)} ms, p99 ${result.latency.p99.toFixed(3)} ms`);
  expect(result.latency.mean).toBeLessThanOrEqual(BUDGET.meanMs);
  expect(result.latency.p99).toBeLessThanOrEqual(BUDGET.p99Ms);
});
