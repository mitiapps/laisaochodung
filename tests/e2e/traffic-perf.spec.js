import { expect, test } from '@playwright/test';
import { DT } from '../../src/contracts/units.js';
import { REPLAY_CHECKPOINT_S } from '../../src/game/session.js';

/**
 * Traffic diagnostics on the vite dev server (the dev build exposes
 * `window.__laisaochodung.debugInfo()`), `osm-pasteur` on a fixed seed: the agent count stays
 * within the map's cap, the renderer stays within the draw-call budget, and the dev replay check of
 * the run (the windowed replay of the kept frames) equals the live report after a quit.
 *
 * No preset is stored: the run relies on the Đơn giản default on purpose, since it only idles.
 */

const SEED = 20261124;
/** Draw calls of one frame, shadow pass included. */
const MAX_DRAW_CALLS = 160;
/** Fewest one-second samples taken, whatever the simulated rate. */
const MIN_SAMPLES = 20;
/**
 * Simulated tick the sampling runs to: two replay checkpoint intervals plus a margin of one
 * second, so the run has passed its second checkpoint and the replay is windowed. Simulated time
 * runs slower than the wall clock below 12 frames per second (the loop takes at most 5 steps per
 * frame), so the test waits on ticks, not on wall seconds.
 */
const TARGET_TICK = Math.round((2 * REPLAY_CHECKPOINT_S + 1) / DT);

/**
 * Dev diagnostics of the session.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<import('../../src/game/session.js').DebugInfo>} Debug info.
 */
function debugInfo(page) {
  return page.evaluate(() =>
    /** @type {{__laisaochodung: {debugInfo: () => import('../../src/game/session.js').DebugInfo}}} */ (/** @type {unknown} */ (window)).__laisaochodung.debugInfo(),
  );
}

test('osm-pasteur keeps agents within the cap, draw calls within budget, and replays equal', async ({ page, request }) => {
  test.setTimeout(180_000);
  /** @type {string[]} */
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  const map = await (await request.get('/maps/osm-pasteur.json')).json();
  const maxAgents = map.traffic.maxAgents;

  await page.goto(`/#/play?map=osm-pasteur&vehicle=car-sedan&seed=${SEED}`);
  await expect(page.getByTestId('play-screen')).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await debugInfo(page)).status, { timeout: 60_000 }).toBe('running');

  const first = await debugInfo(page);
  expect(first.traffic).toBe('map');
  expect(first.runSeed).toBe(SEED);

  let peakAgents = 0;
  let minAgents = Infinity;
  let peakDrawCalls = 0;
  let samples = 0;
  let tick = first.tick;
  while (samples < MIN_SAMPLES || tick < TARGET_TICK) {
    await page.waitForTimeout(1000);
    const info = await debugInfo(page);
    samples += 1;
    tick = info.tick;
    peakAgents = Math.max(peakAgents, info.agents);
    minAgents = Math.min(minAgents, info.agents);
    if (typeof info.drawCalls === 'number') peakDrawCalls = Math.max(peakDrawCalls, info.drawCalls);
  }
  const info = await debugInfo(page);
  console.log(
    `${samples} samples to tick ${tick}; agents ${minAgents}..${peakAgents} of ${maxAgents}; draw calls up to ${peakDrawCalls}; ` +
      `sim step ${JSON.stringify(info.simStepMs)} ms; traffic step ${JSON.stringify(info.trafficStepMs)} ms`,
  );
  expect(minAgents).toBeGreaterThan(0);
  expect(peakAgents).toBeLessThanOrEqual(maxAgents);
  expect(peakDrawCalls).toBeGreaterThan(0);
  expect(peakDrawCalls).toBeLessThanOrEqual(MAX_DRAW_CALLS);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-overlay')).toBeVisible();
  await page.getByTestId('pause-quit').click();
  await expect.poll(async () => (await debugInfo(page)).replayCheck, { timeout: 60_000 }).not.toBeNull();
  const check = /** @type {NonNullable<import('../../src/game/session.js').DebugInfo['replayCheck']>} */ ((await debugInfo(page)).replayCheck);
  console.log(`replay check ${JSON.stringify(check)}`);
  expect(problems).toEqual([]);
  expect(check.windowed).toBe(true);
  expect(check.equal).toBe(true);
});
