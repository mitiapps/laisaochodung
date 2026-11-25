import { expect, test } from '@playwright/test';
import { KEY_BINDINGS } from '../../src/contracts/controls.js';
import { TICK_HZ } from '../../src/contracts/units.js';
import { MAX_STEPS_PER_FRAME } from '../../src/game/loop.js';
import { HUD_HZ } from '../../src/game/session.js';
import { CONTROL_PRESET_STORAGE_KEY } from '../../src/ui/lib/control-preset-store.js';

/**
 * Full runs of tutorial 01 through the shipped build, driven only through the keyboard and read
 * only from the HUD, as a player would: every control is tried and seen on the HUD, then a small
 * DOM-only autopilot follows the navigation arrow to the finish. The car run signals its lane
 * change; the scooter run changes lane with no indicator, so a breach toast and a non-empty result
 * screen are checked against real data.
 *
 * Every control is proven with real key presses in `exerciseControls`, and the autopilot drives
 * the throttle, brakes, gears and indicators with real keys too. Its steering corrections are the
 * one exception: they are key events dispatched in the page, on the window the game listens to,
 * so a correction lasts a fixed number of simulated steps. A real key held between two round
 * trips stays down for as long as those round trips take, which on a loaded runner is most of a
 * second, and the corrections then overshoot until the car leaves its lane.
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
 * Arrow angle, in degrees, inside which the autopilot leaves the wheel alone; near a checkpoint
 * the band widens to the angle of `LATERAL_TOLERANCE_M` at that distance, so a small sideways
 * offset close to a gate does not ask for a large correction.
 */
const DEAD_BAND_DEG = 2;
/** Sideways offset from the checkpoint, metres, the autopilot accepts. */
const LATERAL_TOLERANCE_M = 0.6;
/** Within this distance of a checkpoint, metres, its bearing swings, so the wheel stays straight. */
const GATE_M = 8;
/**
 * Beyond this arrow angle, in degrees, the autopilot steers with a double correction on every HUD
 * update and lifts the throttle; between the dead band and this it steers with a single one on
 * every other update. A correction is seen one loop period late, which on a loaded runner is a few
 * hundred milliseconds, so small errors get little authority and a large one is corrected at a
 * lower speed.
 */
const FULL_STEER_DEG = 6;
/** Below this speed, km/h, the throttle stays on whatever the arrow says, so the car never stalls. */
const MIN_ROLL_KMH = 8;
/**
 * The autopilot backs off after standing still with the throttle held for this many decisions in
 * a row and at least `STUCK_MS` of wall time; from rest the car moves within a fraction of a
 * simulated second, so only a vehicle held by a kerb or an obstacle stands that long.
 */
const STUCK_DECISIONS = 6;
/** Wall milliseconds of the standstill before backing off; see `STUCK_DECISIONS`. */
const STUCK_MS = 4000;
/** Most metres the car reverses when it is stuck; it stops earlier once it points at the target. */
const BACK_OFF_M = 4;

/**
 * @typedef {object} HudReading
 * @property {number} rotationDeg Nav arrow rotation; positive when the target is to the right.
 * @property {number} distanceM Distance to the next checkpoint or the finish.
 * @property {number} speedKmh Speed.
 * @property {number} steer Steering −1..1 as the HUD shows it.
 * @property {string} gear Gear readout.
 * @property {boolean} finished The result screen is shown.
 */

/**
 * Reads the HUD in one round trip, on the next rendered frame, so each decision sees a new frame
 * and decisions never run faster than the game draws.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<HudReading>} Reading.
 */
function readHud(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
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
      steer: Number(q('hud-steer')?.getAttribute('data-value') ?? 0),
      gear: (q('hud-gear')?.textContent ?? '').trim(),
      finished: q('result-screen') !== null,
    };
  });
}

/**
 * Fixed steps of one small steering correction (design): a quarter of the way to full lock, then
 * back to centre, a correction of a few degrees of heading at cruising speed.
 */
const STEER_PULSE_STEPS = 5;

/**
 * Holds a steering key for a number of simulated steps, then reads the HUD on the next frame, all
 * in one round trip. The key events are dispatched in the page, on the window the game listens
 * to, so the hold is counted in the game's own steps (from the frame times, at most
 * `MAX_STEPS_PER_FRAME` each) and does not stretch with slow round trips to a loaded browser.
 * @param {import('@playwright/test').Page} page Page.
 * @param {string} code Key code.
 * @param {number} steps Fixed steps to hold it for.
 */
async function steerPulse(page, code, steps) {
  await page.evaluate(
    async ([key, budget, maxPerFrame, hz]) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      let last = /** @type {number} */ (await frame());
      window.dispatchEvent(new KeyboardEvent('keydown', { code: key, bubbles: true }));
      try {
        let held = 0;
        while (held < budget) {
          const t = /** @type {number} */ (await frame());
          held += Math.min(maxPerFrame, Math.max(1, Math.round(((t - last) * hz) / 1000)));
          last = t;
        }
      } finally {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: key, bubbles: true }));
      }
    },
    /** @type {[string, number, number, number]} */ ([code, steps, MAX_STEPS_PER_FRAME, TICK_HZ]),
  );
}

/**
 * Presses a real key down across the next rendered frame, for a short brake. The key stays down
 * for at least that frame and for as long as the round trips take, which on a loaded runner can be
 * most of a second; that is harmless for the brake, so steering uses `steerPulse` instead.
 * @param {import('@playwright/test').Page} page Page.
 * @param {string} key Key code.
 */
async function tap(page, key) {
  await page.keyboard.down(key);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
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
 * Follows the navigation arrow to the finish, one decision per rendered frame. A steering
 * correction is a one-frame tap toward the arrow, sized for a loop that may run most of a second
 * behind the car (see `FULL_STEER_DEG`); the throttle holds the cruising speed and lifts while the
 * arrow is far off; the car shifts between first and second. When the car stands still with the
 * throttle held (against a kerb or the road works), it lets go and backs off (the car in reverse
 * with the wheel turned away from the target; the scooter, which has none, only stops and lets the
 * wheel centre) and drives on. The autopilot stops
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
  let stuck = 0;
  let stuckSinceMs = 0;
  let lastPulseMs = 0;
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

  /**
   * Shifts until the HUD shows a gear.
   * @param {string} key Shift key.
   * @param {string} gear Wanted gear.
   */
  const shiftTo = async (key, gear) => {
    for (let i = 0; i < 4; i += 1) {
      const before = (await readHud(page)).gear;
      if (before === gear) return;
      await page.keyboard.press(key);
      await expect.poll(async () => (await readHud(page)).gear).not.toBe(before);
    }
    await expect(page.getByTestId('hud-gear')).toHaveText(gear);
  };

  /** Gets a stuck vehicle moving again: release, straighten, back off, stop, drive on. */
  const backOff = async () => {
    await setThrottle(false);
    await page.keyboard.down(KEY.brake);
    await expect.poll(async () => (await readHud(page)).speedKmh, { timeout: 30_000 }).toBe(0);
    await page.keyboard.up(KEY.brake);
    if (!isCar) return;
    await shiftTo(KEY.gearDown, 'R');
    const start = await readHud(page);
    // Reversing with the wheel turned away from the target swings the nose toward it.
    const counter = start.rotationDeg < 0 ? KEY.steerRight : KEY.steerLeft;
    await page.keyboard.down(counter);
    await setThrottle(true);
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const r = await readHud(page);
      if (r.distanceM >= start.distanceM + BACK_OFF_M || Math.abs(r.rotationDeg) <= DEAD_BAND_DEG) break;
    }
    await setThrottle(false);
    await page.keyboard.up(counter);
    await page.keyboard.down(KEY.brake);
    await expect.poll(async () => (await readHud(page)).speedKmh, { timeout: 30_000 }).toBe(0);
    await page.keyboard.up(KEY.brake);
    await shiftTo(KEY.gearUp, '1');
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
        if (isCar) await shiftTo(KEY.gearDown, '1');
        await page.waitForTimeout((PEDESTRIAN_WAIT_S / simPerWall) * 1000);
        await page.keyboard.up(KEY.brake);
        halted = true;
        lastSampleMs = Date.now();
        continue;
      }
    }
    lastSampleMs = now;

    if (throttleDown && s.speedKmh === 0) {
      if (stuck === 0) stuckSinceMs = now;
      stuck += 1;
    } else {
      stuck = 0;
    }
    if (stuck >= STUCK_DECISIONS && now - stuckSinceMs >= STUCK_MS) {
      stuck = 0;
      await backOff();
      continue;
    }

    // The HUD publishes at `HUD_HZ`, slower than decisions, so a shift waits for the HUD to show
    // it instead of being pressed again on a stale reading.
    if (isCar && s.gear === '1' && s.speedKmh > 15) await shiftTo(KEY.gearUp, '2');
    // Near a checkpoint its bearing swings; hold the wheel straight through the gate.
    const off = s.distanceM > GATE_M ? Math.abs(s.rotationDeg) : 0;
    const deadBand = Math.max(DEAD_BAND_DEG, (Math.atan(LATERAL_TOLERANCE_M / Math.max(1, s.distanceM)) * 180) / Math.PI);
    await setThrottle(s.speedKmh < MIN_ROLL_KMH || (s.speedKmh < CRUISE_KMH && off <= FULL_STEER_DEG));
    if (s.speedKmh > CRUISE_KMH + 6) await tap(page, KEY.brake);

    // A correction toward the arrow, unless the wheel is still turned that way from the last one.
    // At most one per HUD update, since a reading taken before the HUD caught up with the last
    // correction would ask for it again; small errors get one per two updates.
    const side = Math.sign(s.rotationDeg);
    const big = off > FULL_STEER_DEG;
    const gapMs = (big ? 1 : 2) * (1000 / HUD_HZ);
    if ((big || off > deadBand) && s.steer * side <= 0 && Date.now() - lastPulseMs >= gapMs) {
      await steerPulse(page, side > 0 ? KEY.steerRight : KEY.steerLeft, big ? 2 * STEER_PULSE_STEPS : STEER_PULSE_STEPS);
      lastPulseMs = Date.now();
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
