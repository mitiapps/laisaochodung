import { expect, test } from '@playwright/test';
import { KEY_BINDINGS } from '../../src/contracts/controls.js';
import { CONTROL_PRESET_STORAGE_KEY } from '../../src/ui/lib/control-preset-store.js';

/**
 * Full runs of tutorial 01 through the shipped build, driven only through the keyboard and read
 * only from the HUD, as a player would: every control is tried and seen on the HUD, then a small
 * DOM-only autopilot follows the navigation arrow to the finish. The car run signals its lane
 * change; the scooter run changes lane with no indicator, so a breach toast and a non-empty result
 * screen are checked against real data.
 *
 * Tutorial 01 is a straight road east: checkpoints at x 160, 235, 290, 370 and 560 (the last three
 * in the kerb lane, past road works in the inner lane), the finish band at about x 615. While the
 * first checkpoint is the target, the ego's x is 160 minus the navigation distance. A pedestrian
 * starts across the crosswalk at x 120 when the ego passes x 70 to 85, so the autopilot stops
 * before it and waits until the pedestrian has crossed.
 */

/** Keys of one action, from the game's own bindings. */
const KEY = Object.fromEntries(KEY_BINDINGS.map((b) => [b.action, b.keys[0]]));

/** x of the first checkpoint on tutorial 01. */
const FIRST_CHECKPOINT_X = 160;
/** The autopilot halts for the pedestrian with its centre here (front about 2 m behind). */
const HALT_X = 98;
/** Simulated seconds to wait at the halt: the pedestrian crosses 7 m of road plus the kerbs. */
const PEDESTRIAN_WAIT_S = 12;
/** Cruising speed, km/h: under every limit on the map. */
const CRUISE_KMH = 20;

/**
 * @typedef {object} HudReading
 * @property {number} rotationDeg Nav arrow rotation; positive when the target is to the right.
 * @property {number} distanceM Distance to the next checkpoint or the finish.
 * @property {number} speedKmh Speed.
 * @property {string} gear Gear readout.
 * @property {boolean} finished The result screen is shown.
 */

/**
 * Reads the HUD in one round trip.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<HudReading>} Reading.
 */
function readHud(page) {
  return page.evaluate(() => {
    /**
     * @param {string} id Test id.
     * @returns {Element | null} Element.
     */
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const style = q('hud-nav')?.querySelector('svg')?.getAttribute('style') ?? '';
    const rot = /rotate\((-?[\d.e+-]+)deg\)/u.exec(style);
    const dist = (q('hud-nav-distance')?.textContent ?? '').trim();
    const km = /^([\d,]+) km$/u.exec(dist);
    const metres = km ? Number(km[1].replace(',', '.')) * 1000 : Number.parseFloat(dist);
    return {
      rotationDeg: rot ? Number(rot[1]) : 0,
      distanceM: Number.isFinite(metres) ? metres : Number.NaN,
      speedKmh: Number(q('hud-speed')?.textContent ?? 'NaN'),
      gear: (q('hud-gear')?.textContent ?? '').trim(),
      finished: q('result-screen') !== null,
    };
  });
}

/**
 * Holds a key for a while.
 * @param {import('@playwright/test').Page} page Page.
 * @param {string} key Key code.
 * @param {number} ms Hold time.
 */
async function hold(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/**
 * Collects console errors, page errors and CSP violations.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<string[]>} Live list of problems.
 */
async function watchProblems(page) {
  /** @type {string[]} */
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.exposeFunction('reportCspViolation', (/** @type {string} */ text) => problems.push(`csp: ${text}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      /** @type {{reportCspViolation: (text: string) => void}} */ (/** @type {unknown} */ (window)).reportCspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });
  return problems;
}

/**
 * Starts tutorial 01 with a vehicle from the home page.
 * @param {import('@playwright/test').Page} page Page.
 * @param {'car-sedan' | 'scooter'} vehicleId Vehicle.
 */
async function startRun(page, vehicleId) {
  await page.goto('/#/');
  await page.getByTestId(`vehicle-${vehicleId}`).check();
  await page.getByTestId('map-tutorial-01-co-ban').check();
  await page.getByTestId('start-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('osm-attribution')).toHaveCount(0);
}

/**
 * Tries every control and checks the HUD shows it: throttle, steering both ways, both brakes,
 * gears (car), both indicators, hazards, low and high beam, and the horn. Leaves the vehicle at a
 * standstill with everything off (and the car in first gear).
 * @param {import('@playwright/test').Page} page Page.
 * @param {boolean} isCar Car (foot brake, handbrake, manual gears) or scooter (front and rear brakes).
 */
async function exerciseControls(page, isCar) {
  const value = async (/** @type {string} */ id) => Number(await page.getByTestId(id).getAttribute('data-value'));
  const on = (/** @type {string} */ id) => page.getByTestId(id);

  if (isCar) {
    await expect(on('hud-gear')).toHaveText('N');
    await page.keyboard.press(KEY.gearUp);
    await expect(on('hud-gear')).toHaveText('1');
    await page.keyboard.press(KEY.gearUp);
    await expect(on('hud-gear')).toHaveText('2');
    await page.keyboard.press(KEY.gearDown);
    await expect(on('hud-gear')).toHaveText('1');
  }

  for (const [key, id, check] of /** @type {const} */ ([
    [KEY.throttle, 'hud-throttle', (/** @type {number} */ v) => v > 0],
    [KEY.brake, 'hud-brake-front', (/** @type {number} */ v) => v > 0],
    [KEY.steerLeft, 'hud-steer', (/** @type {number} */ v) => v < 0],
    [KEY.steerRight, 'hud-steer', (/** @type {number} */ v) => v > 0],
  ])) {
    await page.keyboard.down(key);
    await expect.poll(async () => check(await value(id)), { message: `${key} on ${id}` }).toBe(true);
    await page.keyboard.up(key);
  }
  await page.keyboard.down(KEY.handbrake);
  if (isCar) await expect(on('hud-handbrake')).toHaveAttribute('data-on', 'true');
  else await expect.poll(() => value('hud-brake-rear')).toBeGreaterThan(0);
  await page.keyboard.up(KEY.handbrake);
  if (isCar) await expect(on('hud-handbrake')).toHaveAttribute('data-on', 'false');

  for (const [key, id] of [
    [KEY.signalLeft, 'hud-indicator-left'],
    [KEY.signalRight, 'hud-indicator-right'],
    [KEY.hazard, 'hud-hazard'],
  ]) {
    await page.keyboard.press(key);
    await expect(on(id)).toHaveAttribute('data-on', 'true');
    await page.keyboard.press(key);
    await expect(on(id)).toHaveAttribute('data-on', 'false');
  }

  // Lights cycle off, low, high, off.
  await page.keyboard.press(KEY.lightsCycle);
  await expect(on('hud-low-beam')).toHaveAttribute('data-on', 'true');
  await page.keyboard.press(KEY.lightsCycle);
  await expect(on('hud-high-beam')).toHaveAttribute('data-on', 'true');
  await expect(on('hud-low-beam')).toHaveAttribute('data-on', 'false');
  await page.keyboard.press(KEY.lightsCycle);
  await expect(on('hud-high-beam')).toHaveAttribute('data-on', 'false');

  await page.keyboard.down(KEY.horn);
  await expect(on('hud-horn')).toHaveAttribute('data-on', 'true');
  await page.keyboard.up(KEY.horn);
  await expect(on('hud-horn')).toHaveAttribute('data-on', 'false');
}

/**
 * Follows the navigation arrow to the finish. Steering pulses scale with the arrow's angle; the
 * throttle holds the cruising speed; the car shifts between first and second. The autopilot stops
 * for the pedestrian, measuring how fast simulated time runs against the wall clock on the way so
 * the wait is long enough in simulated seconds.
 * @param {import('@playwright/test').Page} page Page.
 * @param {{isCar: boolean, signalLaneChange: boolean, timeoutMs: number}} options Options.
 * @returns {Promise<void>}
 */
async function driveToFinish(page, { isCar, signalLaneChange, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let checkpoint = 0;
  let lastDistance = Number.NaN;
  let throttleDown = false;
  let halted = false;
  // Simulated metres covered against HUD speed integrated over wall time, for the wait.
  let wallMetres = 0;
  let startX = Number.NaN;
  let lastSampleMs = Date.now();

  const setThrottle = async (/** @type {boolean} */ want) => {
    if (want === throttleDown) return;
    if (want) await page.keyboard.down(KEY.throttle);
    else await page.keyboard.up(KEY.throttle);
    throttleDown = want;
  };

  while (Date.now() < deadline) {
    const s = await readHud(page);
    if (s.finished) {
      await setThrottle(false);
      return;
    }
    const now = Date.now();
    if (Number.isFinite(lastDistance) && s.distanceM > lastDistance + 5) {
      checkpoint += 1;
      // The kerb-lane checkpoint after the widening: the move to the right lane starts here.
      if (signalLaneChange && checkpoint === 2) await page.keyboard.press(KEY.signalRight);
      if (signalLaneChange && checkpoint === 3) await page.keyboard.press(KEY.signalRight);
    }
    lastDistance = s.distanceM;

    if (checkpoint === 0 && !halted) {
      const x = FIRST_CHECKPOINT_X - s.distanceM;
      if (!Number.isFinite(startX)) startX = x;
      wallMetres += (s.speedKmh / 3.6) * ((now - lastSampleMs) / 1000);
      if (x >= HALT_X) {
        await setThrottle(false);
        await page.keyboard.down(KEY.brake);
        await expect.poll(async () => (await readHud(page)).speedKmh, { timeout: 30_000 }).toBe(0);
        // Simulated seconds per wall second, from the approach; at least 0.1 so a stall cannot hang.
        const simPerWall = Math.max(0.1, Math.min(1, (x - startX) / Math.max(1, wallMetres)));
        if (isCar) {
          await page.keyboard.press(KEY.gearDown);
          await expect(page.getByTestId('hud-gear')).toHaveText('1');
        }
        await page.waitForTimeout((PEDESTRIAN_WAIT_S / simPerWall) * 1000);
        await page.keyboard.up(KEY.brake);
        halted = true;
        lastSampleMs = Date.now();
        continue;
      }
    }
    lastSampleMs = now;

    if (isCar && s.gear === '1' && s.speedKmh > 15) await page.keyboard.press(KEY.gearUp);
    await setThrottle(s.speedKmh < CRUISE_KMH);
    if (s.speedKmh > CRUISE_KMH + 6) await hold(page, KEY.brake, 60);

    // Near a checkpoint its bearing swings; hold the wheel straight through the gate.
    if (s.distanceM > 6 && Math.abs(s.rotationDeg) > 1.5) {
      const ms = Math.min(120, Math.max(20, Math.abs(s.rotationDeg) * 12));
      await hold(page, s.rotationDeg > 0 ? KEY.steerRight : KEY.steerLeft, ms);
    } else {
      await page.waitForTimeout(30);
    }
  }
  await setThrottle(false);
  throw new Error(`No finish within ${timeoutMs} ms (checkpoint ${checkpoint})`);
}

// These runs drive the Thực tế preset (manual gears, separate brakes); the preset is stored before load.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [CONTROL_PRESET_STORAGE_KEY, 'real']);
});

test.describe.configure({ mode: 'serial' });

test('the car drives tutorial 01 to the finish with every control, signalling its lane change', async ({ page }) => {
  test.setTimeout(480_000);
  const problems = await watchProblems(page);
  await startRun(page, 'car-sedan');
  await exerciseControls(page, true);
  await driveToFinish(page, { isCar: true, signalLaneChange: true, timeoutMs: 420_000 });

  await expect(page.getByTestId('result-ended-by')).toHaveText('Về đích');
  await expect(page.getByTestId('result-score')).toHaveText(/^\d+(,\d+)?\/10$/u);
  await expect(page.getByTestId('result-licence')).toHaveText(/^12 → \d+ điểm$/u);
  expect(problems).toEqual([]);
});

test('the scooter drives tutorial 01 to the finish; an unsignalled lane change shows a full toast and result', async ({ page }) => {
  test.setTimeout(480_000);
  const problems = await watchProblems(page);
  await startRun(page, 'scooter');
  await exerciseControls(page, false);

  const drive = driveToFinish(page, { isCar: false, signalLaneChange: false, timeoutMs: 420_000 });
  // The lane change with no indicator raises a toast with the fine band, licence points and a
  // linked citation; it lasts six seconds, so it is caught while the run goes on.
  const toast = page.getByTestId('breach-toast').filter({ hasText: 'Chuyển làn không đúng quy định' }).first();
  await expect(toast).toBeVisible({ timeout: 300_000 });
  await expect(toast.getByTestId('breach-fine')).toHaveText(/Phạt tiền: [\d.]+–[\d.]+ ₫/u);
  await expect(toast.getByTestId('breach-points')).toHaveText(/điểm giấy phép lái xe/u);
  await expect(toast.getByTestId('breach-citation').locator('a')).toHaveAttribute('href', /^https:\/\//u);
  await expect(toast.getByTestId('breach-citation')).toContainText('Nghị định 168/2024/NĐ-CP');
  await drive;

  await expect(page.getByTestId('result-ended-by')).toHaveText('Về đích');
  const score = await page.getByTestId('result-score').innerText();
  expect(Number(score.replace('/10', '').replace(',', '.'))).toBeLessThan(10);
  const breaches = page.getByTestId('result-breach');
  await expect(breaches.filter({ hasText: 'Chuyển làn không đúng quy định' })).not.toHaveCount(0);
  await expect(page.getByTestId('result-screen')).toContainText('(ước tính)');
  await expect(page.getByTestId('result-fine-total')).toHaveText(/^[\d.]+(–[\d.]+)? ₫$/u);
  // Licence after the single largest deduction: 12 minus the largest points of any breach shown.
  const pointsTexts = await page.getByTestId('result-screen').getByTestId('breach-points').allInnerTexts();
  const largest = Math.max(0, ...pointsTexts.map((t) => Number(/Trừ (\d+) điểm/u.exec(t)?.[1] ?? 0)));
  await expect(page.getByTestId('result-licence')).toHaveText(`12 → ${Math.max(0, 12 - largest)} điểm`);
  expect(problems).toEqual([]);
});

test('an OSM-derived map shows its attribution and the simulated-map note', async ({ page }) => {
  const problems = await watchProblems(page);
  await page.goto('/#/');
  await page.getByTestId('vehicle-car-sedan').check();
  await page.getByTestId('map-osm-pasteur').check();
  await page.getByTestId('start-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  const note = page.getByTestId('osm-attribution');
  await expect(note).toContainText('OpenStreetMap');
  await expect(note).toContainText('bản đồ mô phỏng');
  await expect(note.locator('a')).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  expect(problems).toEqual([]);
});
