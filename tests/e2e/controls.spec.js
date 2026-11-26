import { expect, test } from '@playwright/test';
import { KEY_BINDINGS } from '../../src/contracts/controls.js';
import { CAMERA_MODE_STORAGE_KEY } from '../../src/ui/lib/camera-mode-store.js';
import { CONTROL_PRESET_STORAGE_KEY } from '../../src/ui/lib/control-preset-store.js';
import { controlLayout, layoutActions } from '../../src/ui/lib/hud-view.js';
import { badgeFor } from '../../src/ui/lib/key-label.js';
import { readToastFit } from './toast-fit.js';

/**
 * Control presets, camera modes and the on-screen controls on the shipped build: Đơn giản is the
 * default, every action of the vehicle has a working on-screen control with its key badge in cabin
 * order, touch drives the same input as the keys, the camera switches by key and button, and the
 * one layout fits a desktop window and landscape phones without overlapping, centred where the
 * screen is wide enough.
 */

/** Keys of one action, from the game's own bindings. */
const KEY = Object.fromEntries(KEY_BINDINGS.map((b) => [b.action, b.keys[0]]));

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
  await expect(page.getByTestId('hud-speed')).not.toHaveText('');
}

/**
 * Numeric `data-value` of a HUD element.
 * @param {import('@playwright/test').Page} page Page.
 * @param {string} id Test id.
 * @returns {Promise<number>} Value.
 */
async function value(page, id) {
  return Number(await page.getByTestId(id).getAttribute('data-value'));
}

/**
 * Centre of an element in viewport coordinates.
 * @param {import('@playwright/test').Locator} locator Element.
 * @returns {Promise<{x: number, y: number}>} Centre.
 */
async function centre(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('The element has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Collects console errors and page errors.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {string[]} Live list of problems.
 */
function watchProblems(page) {
  /** @type {string[]} */
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  return problems;
}

test('Đơn giản is the default: the car starts in D, W drives it, and the scooter brake applies both brakes', async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto('/#/');
  await expect(page.getByTestId('vehicle-car-sedan').locator('..')).toHaveText(/^\s*Ô tô con\s*$/u);
  await expect(page.getByTestId('preset-simple')).toBeChecked();

  await startRun(page, 'car-sedan');
  await expect(page.getByTestId('hud-gear')).toHaveText('D');
  // The gear lever's knob shows the same gear.
  await expect(page.getByTestId('hud-gear-lever')).toHaveText('D');
  await expect(page.getByTestId('hud-gear-lever')).toHaveAttribute('data-value', 'D');
  await page.keyboard.down(KEY.throttle);
  await expect.poll(async () => Number(await page.getByTestId('hud-speed').innerText()), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.keyboard.up(KEY.throttle);

  await startRun(page, 'scooter');
  // An automatic scooter has no gear to show.
  await expect(page.getByTestId('hud-gear')).toHaveCount(0);
  await expect(page.getByTestId('hud-gear-lever')).toHaveCount(0);
  await page.keyboard.down(KEY.brake);
  await expect.poll(() => value(page, 'hud-brake-front')).toBeGreaterThan(0);
  await expect.poll(() => value(page, 'hud-brake-rear')).toBeGreaterThan(0);
  await page.keyboard.up(KEY.brake);
  expect(problems).toEqual([]);
});

test('desktop: every control of the vehicle has exactly one visible key badge, other actions none, and a mouse click on a button keeps a held key', async ({ page }) => {
  const problems = watchProblems(page);
  for (const [vehicleId, legalClass] of /** @type {const} */ ([
    ['scooter', 'motorbike'],
    ['car-sedan', 'car'],
  ])) {
    await startRun(page, vehicleId);
    const shown = new Set(layoutActions(controlLayout(legalClass, 'simple')));
    for (const binding of KEY_BINDINGS) {
      const badges = page.locator(`[data-badge="${binding.action}"]:visible`);
      await expect(badges, `${vehicleId} ${binding.action}`).toHaveCount(shown.has(binding.action) ? 1 : 0);
      if (shown.has(binding.action)) await expect(badges).toHaveText(badgeFor(binding.action));
    }
  }

  // Hold the throttle key, then press the horn with the mouse: the button never takes focus, so
  // nothing blurs and the throttle stays held.
  await page.keyboard.down(KEY.throttle);
  await expect.poll(() => value(page, 'hud-throttle')).toBe(1);
  const horn = await centre(page.locator('[data-action="horn"]'));
  await page.mouse.move(horn.x, horn.y);
  await page.mouse.down();
  await expect(page.getByTestId('hud-horn')).toHaveAttribute('data-on', 'true');
  await page.mouse.up();
  await expect(page.getByTestId('hud-horn')).toHaveAttribute('data-on', 'false');
  await page.waitForTimeout(300);
  expect(await value(page, 'hud-throttle')).toBe(1);
  await page.keyboard.up(KEY.throttle);
  expect(problems).toEqual([]);
});

test('the camera switches by key and by button, while driving and while paused, and the choice survives a reload and a restart', async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto('/#/');
  await expect(page.getByTestId('camera-chase')).toBeChecked();
  await startRun(page, 'car-sedan');
  const camera = page.getByTestId('hud-camera');
  await expect(camera).toHaveAttribute('data-value', 'chase');
  await page.keyboard.press(KEY.camera);
  await expect(camera).toHaveAttribute('data-value', 'cockpit');
  await camera.click();
  await expect(camera).toHaveAttribute('data-value', 'chase');

  // Paused: the overlay covers the run, but the key and the button still switch the camera.
  await page.keyboard.press(KEY.pause);
  await expect(page.getByTestId('pause-overlay')).toBeVisible();
  await page.keyboard.press(KEY.camera);
  await expect(camera).toHaveAttribute('data-value', 'cockpit');
  await camera.click();
  await expect(camera).toHaveAttribute('data-value', 'chase');
  await camera.click();
  await expect(camera).toHaveAttribute('data-value', 'cockpit');
  await expect(page.getByTestId('pause-overlay')).toBeVisible();

  await page.getByTestId('pause-restart').click();
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
  await expect(camera).toHaveAttribute('data-value', 'cockpit');
  await page.reload();
  await expect(page.getByTestId('hud-camera')).toHaveAttribute('data-value', 'cockpit');
  await page.goto('/#/');
  await expect(page.getByTestId('camera-cockpit')).toBeChecked();
  await page.getByTestId('camera-chase').check();
  await startRun(page, 'scooter');
  await expect(page.getByTestId('hud-camera')).toHaveAttribute('data-value', 'chase');
  expect(problems).toEqual([]);
});

test('an unknown stored camera mode gives the chase camera', async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, 'drone'), [CAMERA_MODE_STORAGE_KEY]);
  await page.goto('/#/');
  await expect(page.getByTestId('camera-chase')).toBeChecked();
  await startRun(page, 'car-sedan');
  await expect(page.getByTestId('hud-camera')).toHaveAttribute('data-value', 'chase');
});

test('the preset chosen on the home page survives a reload and a restart', async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto('/#/');
  await page.getByTestId('preset-real').check();
  await page.reload();
  await expect(page.getByTestId('preset-real')).toBeChecked();
  await startRun(page, 'car-sedan');
  await expect(page.getByTestId('hud-gear')).toHaveText('N');
  await page.keyboard.press(KEY.pause);
  await expect(page.getByTestId('pause-preset')).toContainText('Điều khiển: Thực tế');
  await page.getByTestId('pause-restart').click();
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
  await page.keyboard.press(KEY.gearUp);
  await expect(page.getByTestId('hud-gear')).toHaveText('1');
  await page.keyboard.press(KEY.pause);
  await page.getByTestId('pause-restart').click();
  await expect(page.getByTestId('hud-gear')).toHaveText('N');
  await page.keyboard.press(KEY.pause);
  await expect(page.getByTestId('pause-preset')).toContainText('Thực tế');
  expect(problems).toEqual([]);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('tapping the throttle, the left indicator and the lights does what their keys do, and hides the badges', async ({ page }) => {
    const problems = watchProblems(page);
    await startRun(page, 'car-sedan');
    const cdp = await page.context().newCDPSession(page);

    /**
     * Holds a real touch on an element for a while.
     * @param {string} action `data-action` of the element.
     * @param {number} ms Hold time.
     * @param {() => Promise<void>} [during] Check made while the touch is down.
     */
    const touchHold = async (action, ms, during) => {
      const { x, y } = await centre(page.locator(`[data-action="${action}"]`));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(ms);
      await during?.();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const tap = async (/** @type {string} */ action) => {
      const { x, y } = await centre(page.locator(`[data-action="${action}"]`));
      await page.touchscreen.tap(x, y);
    };
    const badge = page.locator('[data-badge="throttle"]');

    // Throttle: a held touch and a held W both reach full throttle and fall back to 0.
    await touchHold('throttle', 600, async () => {
      await expect.poll(() => value(page, 'hud-throttle')).toBe(1);
    });
    await expect.poll(() => value(page, 'hud-throttle')).toBe(0);
    await expect(badge).toBeHidden();
    await page.keyboard.down(KEY.throttle);
    await expect.poll(() => value(page, 'hud-throttle')).toBe(1);
    await page.keyboard.up(KEY.throttle);
    await expect.poll(() => value(page, 'hud-throttle')).toBe(0);
    await expect(badge).toBeVisible();

    // Left indicator: a tap toggles it as Z does.
    await tap('signalLeft');
    await expect(page.getByTestId('hud-indicator-left')).toHaveAttribute('data-on', 'true');
    await expect(badge).toBeHidden();
    await page.keyboard.press(KEY.signalLeft);
    await expect(page.getByTestId('hud-indicator-left')).toHaveAttribute('data-on', 'false');
    await expect(badge).toBeVisible();
    await tap('signalLeft');
    await expect(page.getByTestId('hud-indicator-left')).toHaveAttribute('data-on', 'true');
    await page.keyboard.press(KEY.signalLeft);

    // Lights: a tap cycles off → low as L does, and L cycles on to high.
    await tap('lightsCycle');
    await expect(page.getByTestId('hud-low-beam')).toHaveAttribute('data-on', 'true');
    await page.keyboard.press(KEY.lightsCycle);
    await expect(page.getByTestId('hud-high-beam')).toHaveAttribute('data-on', 'true');
    await expect(page.getByTestId('hud-low-beam')).toHaveAttribute('data-on', 'false');
    await tap('lightsCycle');
    await expect(page.getByTestId('hud-high-beam')).toHaveAttribute('data-on', 'false');
    await page.keyboard.press(KEY.lightsCycle);
    await expect(page.getByTestId('hud-low-beam')).toHaveAttribute('data-on', 'true');
    expect(problems).toEqual([]);
  });

  test('tapping Số − and Số + on the car steps the selector down and up, as K and I do', async ({ page }) => {
    const problems = watchProblems(page);
    // Đơn giản: the car starts in D on the selector R, N, D.
    await startRun(page, 'car-sedan');
    const knob = page.getByTestId('hud-gear-lever');
    await expect(knob).toHaveText('D');
    const tap = async (/** @type {'gearUp' | 'gearDown'} */ action) => {
      const { x, y } = await centre(page.locator(`[data-action="${action}"]`));
      await page.touchscreen.tap(x, y);
    };
    await tap('gearDown');
    await expect(knob).toHaveText('N');
    await tap('gearDown');
    await expect(knob).toHaveText('R');
    await expect(page.getByTestId('hud-gear')).toHaveText('R');
    await tap('gearUp');
    await expect(knob).toHaveText('N');
    await tap('gearUp');
    await expect(knob).toHaveText('D');
    expect(problems).toEqual([]);
  });

  test('the throttle takes a touch hold after a restart, even with a finger still down from the last run', async ({ page }) => {
    const problems = watchProblems(page);
    await startRun(page, 'scooter');
    const cdp = await page.context().newCDPSession(page);
    const throttle = await centre(page.locator('[data-action="throttle"]'));
    /**
     * Sends the touch points down now (pressing new ids) or lifts the listed ones.
     * @param {'touchStart' | 'touchEnd'} type Event.
     * @param {{x: number, y: number, id: number}[]} touchPoints Points down after a start, or lifted by an end.
     * @returns {Promise<unknown>} The CDP reply.
     */
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    // The HUD stands still while paused, so the throttle is read only while the run is going.
    const throttleIs = (/** @type {number} */ want, /** @type {string} */ message) => expect.poll(() => value(page, 'hud-throttle'), { message }).toBe(want);

    // Finger 1 holds the throttle and finger 2 taps pause.
    await touch('touchStart', [{ ...throttle, id: 1 }]);
    await throttleIs(1, 'finger 1 holds the throttle');
    const pause = await centre(page.getByTestId('hud-pause'));
    await touch('touchStart', [{ ...throttle, id: 1 }, { ...pause, id: 2 }]);
    await touch('touchEnd', [{ ...pause, id: 2 }]);
    await expect(page.getByTestId('pause-overlay')).toBeVisible();
    // Chơi lại, with finger 1 still on the throttle. A tap by a second finger fires no click, so
    // the click is dispatched on the button itself.
    await page.getByTestId('pause-restart').dispatchEvent('click');
    await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
    await throttleIs(0, 'the new run starts with the throttle released');

    // A new finger on the throttle drives the new run; lifting every finger releases it.
    await touch('touchStart', [{ ...throttle, id: 1 }, { x: throttle.x, y: throttle.y - 20, id: 3 }]);
    await throttleIs(1, 'a new touch holds the throttle of the new run');
    await touch('touchEnd', [{ ...throttle, id: 1 }, { x: throttle.x, y: throttle.y - 20, id: 3 }]);
    await throttleIs(0, 'lifting every finger releases the throttle');

    // A one-finger pause and restart leaves the throttle working too.
    await page.touchscreen.tap(pause.x, pause.y);
    await expect(page.getByTestId('pause-overlay')).toBeVisible();
    const restart = await centre(page.getByTestId('pause-restart'));
    await page.touchscreen.tap(restart.x, restart.y);
    await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
    await touch('touchStart', [{ ...throttle, id: 4 }]);
    await throttleIs(1, 'a hold after a one-finger restart');
    await touch('touchEnd', [{ ...throttle, id: 4 }]);
    await throttleIs(0, 'released');
    expect(problems).toEqual([]);
  });
});

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 */

/**
 * Whether two boxes share some area.
 * @param {Box} a Box.
 * @param {Box} b Box.
 * @returns {boolean} Overlap.
 */
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Reads the boxes of the on-screen controls, the speed panel and the toast stack at its reserved
 * size (its width and its capped height).
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<{controls: ({actions: string[]} & Box)[], speed: Box, toasts: Box, viewport: {w: number, h: number}}>} Layout.
 */
function readLayout(page) {
  return page.evaluate(() => {
    /**
     * @param {Element} el Element.
     * @returns {{x: number, y: number, w: number, h: number}} Box.
     */
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const stack = /** @type {Element} */ (document.querySelector('[data-testid="toast-stack"]'));
    return {
      controls: [...document.querySelectorAll('[data-action]')].map((el) => ({
        actions: /** @type {string} */ (el.getAttribute('data-action')).split(' '),
        ...boxOf(el),
      })),
      speed: boxOf(/** @type {Element} */ (document.querySelector('[data-testid="hud-speed-panel"]'))),
      toasts: { ...boxOf(stack), h: Number.parseFloat(getComputedStyle(stack).maxHeight) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

/**
 * Box of the speed panel with a three-digit speed written into its readout, read before the next
 * render can rewrite it, and whether the readout still lies inside the panel with nothing spilling out.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<Box & {inside: boolean}>} Box and fit.
 */
function readFastSpeedPanel(page) {
  return page.evaluate(() => {
    const readout = /** @type {Element} */ (document.querySelector('[data-testid="hud-speed"]'));
    readout.textContent = '188';
    const panel = /** @type {Element} */ (document.querySelector('[data-testid="hud-speed-panel"]'));
    const r = panel.getBoundingClientRect();
    const t = readout.getBoundingClientRect();
    const inside = t.left >= r.left && t.right <= r.right && panel.scrollWidth <= panel.clientWidth;
    return { x: r.left, y: r.top, w: r.width, h: r.height, inside };
  });
}

/** Widest the car's speed panel may be on a landscape phone, so it fits left of the stalk. */
const CAR_SPEED_PANEL_MAX_W = 218;

/**
 * Viewports of the layout test. On the narrower landscape phone the HUD box is too narrow for the
 * car's groups on both sides of a centred wheel, so the row shifts left and only containment is
 * checked there.
 */
const LAYOUT_VIEWPORTS = [
  { width: 1280, height: 720, centred: true },
  { width: 1100, height: 600, centred: true },
  { width: 844, height: 390, centred: true },
  { width: 800, height: 360, centred: false },
];

for (const { centred, ...viewport } of LAYOUT_VIEWPORTS) {
  test.describe(`layout at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    for (const [vehicleId, legalClass] of /** @type {const} */ ([
      ['car-sedan', 'car'],
      ['scooter', 'motorbike'],
    ])) {
      for (const preset of /** @type {const} */ (['simple', 'real'])) {
        test(`${vehicleId} on ${preset}: the controls of the layout, at least 56 px, overlapping nothing, in cabin order around the steering`, async ({ page }) => {
          await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [CONTROL_PRESET_STORAGE_KEY, preset]);
          await startRun(page, vehicleId);
          const zones = controlLayout(legalClass, preset);
          const layout = await readLayout(page);
          expect(Number.isFinite(layout.toasts.h) && layout.toasts.h > 0).toBe(true);
          // Exactly the controls of the layout, each action once.
          const drawn = layout.controls.flatMap((c) => c.actions);
          expect([...drawn].sort()).toEqual([...layoutActions(zones)].sort());
          for (const c of layout.controls) {
            const name = c.actions.join(' ');
            expect(c.x, name).toBeGreaterThanOrEqual(0);
            expect(c.y, name).toBeGreaterThanOrEqual(0);
            expect(c.x + c.w, name).toBeLessThanOrEqual(layout.viewport.w);
            expect(c.y + c.h, name).toBeLessThanOrEqual(layout.viewport.h);
            expect(c.w, name).toBeGreaterThanOrEqual(56);
            expect(c.h, name).toBeGreaterThanOrEqual(56);
            expect(overlap(c, layout.speed), `${name} on the speed panel`).toBe(false);
            expect(overlap(c, layout.toasts), `${name} on the toast stack`).toBe(false);
          }
          for (let i = 0; i < layout.controls.length; i += 1) {
            for (let j = i + 1; j < layout.controls.length; j += 1) {
              const [a, b] = [layout.controls[i], layout.controls[j]];
              expect(overlap(a, b), `${a.actions.join(' ')} on ${b.actions.join(' ')}`).toBe(false);
            }
          }

          /**
           * @param {string} action Action.
           * @returns {Box} Box of its control.
           */
          const boxOf = (action) => {
            const c = layout.controls.find((x) => x.actions.includes(action));
            if (!c) throw new Error(`no control for ${action}`);
            return c;
          };
          const cx = (/** @type {Box} */ b) => b.x + b.w / 2;
          const right = (/** @type {Box} */ b) => b.x + b.w;
          const steering = boxOf('steerLeft');
          const stalkLeft = Math.min(...zones.stalk.flat().map((a) => cx(boxOf(a))));
          const stalkRight = Math.max(...zones.stalk.flat().map((a) => right(boxOf(a))));
          // The steering in the middle of the screen, the stalk immediately on its left.
          if (centred) expect(Math.abs(cx(steering) - layout.viewport.w / 2)).toBeLessThanOrEqual(2);
          else expect(cx(steering)).toBeLessThanOrEqual(layout.viewport.w / 2);
          // The speed panel inside the screen, and as wide with a three-digit speed as at a standstill.
          expect(layout.speed.x, 'the speed panel left edge').toBeGreaterThanOrEqual(0);
          expect(layout.speed.x + layout.speed.w, 'the speed panel right edge').toBeLessThanOrEqual(layout.viewport.w);
          const fastSpeed = await readFastSpeedPanel(page);
          expect(fastSpeed.w, 'the speed panel width at three digits').toBe(layout.speed.w);
          expect(fastSpeed.x, 'the speed panel left edge at three digits').toBe(layout.speed.x);
          expect(fastSpeed.inside, 'a three-digit speed inside the speed panel').toBe(true);
          expect(stalkLeft).toBeLessThan(cx(steering));
          expect(stalkRight).toBeLessThanOrEqual(steering.x);
          for (const lever of zones.leftLever) expect(cx(boxOf(lever))).toBeLessThan(cx(steering));
          for (const horn of zones.horn) {
            expect(cx(boxOf(horn))).toBeGreaterThan(cx(steering));
            expect(boxOf(horn).x).toBeGreaterThanOrEqual(right(steering));
          }
          if (legalClass === 'car') {
            // Left to right as in a cabin: steering, brake, throttle, then the gear lever and console.
            expect(cx(steering)).toBeLessThan(cx(boxOf('brake')));
            expect(cx(boxOf('brake'))).toBeLessThan(cx(boxOf('throttle')));
            // The pedals sit next to the wheel: the brake pedal starts just right of the horn.
            for (const horn of zones.horn) expect(boxOf('brake').x - right(boxOf(horn))).toBeLessThanOrEqual(16);
            for (const c of [...zones.gears, ...zones.console]) expect(cx(boxOf(c))).toBeGreaterThan(cx(boxOf('throttle')));
            // The gear lever: Số + over Số − in one column, the handbrake right of it.
            const [up, down] = [boxOf('gearUp'), boxOf('gearDown')];
            expect(Math.abs(cx(up) - cx(down))).toBeLessThanOrEqual(1);
            expect(up.y + up.h).toBeLessThanOrEqual(down.y);
            expect(cx(boxOf('handbrake'))).toBeGreaterThan(cx(up));
            await expect(page.getByTestId('hud-gear')).toBeVisible();
            await expect(page.getByTestId('hud-gear-lever')).toHaveText(await page.getByTestId('hud-gear').innerText());
            if (viewport.width === 844) expect(layout.speed.w, 'the car speed panel width').toBeLessThanOrEqual(CAR_SPEED_PANEL_MAX_W);
          } else {
            // The right end of the handlebar: the front brake lever over the throttle grip.
            const [brake, throttle] = [boxOf('brake'), boxOf('throttle')];
            expect(throttle.x).toBeGreaterThanOrEqual(right(steering));
            expect(throttle.x - right(steering)).toBeLessThanOrEqual(16);
            expect(Math.abs(cx(brake) - cx(throttle))).toBeLessThanOrEqual(1);
            expect(brake.y + brake.h).toBeLessThanOrEqual(throttle.y);
            // The hazard switch in the top row of the switch cluster, left of the handlebar.
            expect(cx(boxOf('hazard'))).toBeLessThan(cx(steering));
            expect(Math.abs(boxOf('hazard').y - boxOf('lightsCycle').y)).toBeLessThanOrEqual(1);
            await expect(page.getByTestId('hud-gear')).toHaveCount(0);
          }
          await expect(page.getByTestId('hud-steer')).toHaveAttribute('data-shape', legalClass === 'car' ? 'wheel' : 'handlebar');
        });
      }
    }
  });
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1100, height: 600 },
  { width: 844, height: 390 },
  { width: 800, height: 360 },
]) {
  test.describe(`the map attribution at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    for (const vehicleId of /** @type {const} */ (['car-sedan', 'scooter'])) {
      test(`stays readable under the ${vehicleId} controls on osm-pasteur`, async ({ page }) => {
        await page.addInitScript(([key]) => localStorage.setItem(key, 'real'), [CONTROL_PRESET_STORAGE_KEY]);
        await page.goto('/#/');
        await page.getByTestId(`vehicle-${vehicleId}`).check();
        await page.getByTestId('map-osm-pasteur').check();
        await page.getByTestId('start-button').click();
        // osm-pasteur with its traffic loads in about 2 s on an idle host and 9 s with the CPU
        // shared under software GL, past the default 5 s.
        await expect(page.getByTestId('hud')).toBeVisible({ timeout: 20_000 });
        const link = page.getByTestId('osm-attribution').locator('a');
        await expect(link).toBeVisible();
        const box = /** @type {Box} */ (await link.boundingBox().then((b) => (b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null)));
        expect(box).not.toBeNull();
        const layout = await readLayout(page);
        for (const c of layout.controls) expect(overlap(c, box), `${c.actions.join(' ')} on the attribution`).toBe(false);
        expect(overlap(layout.speed, box), 'the speed panel on the attribution').toBe(false);
        // Nothing drawn over the link's centre either.
        const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.href ?? null, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
        expect(onTop).toContain('openstreetmap.org');
      });
    }
  });
}

/** Title of the speeding breach toast. */
const SPEEDING_TITLE = 'Chạy quá tốc độ quy định';

/**
 * Makes the page release the throttle and pause the run as soon as a breach toast with the given
 * title is added, from a DOM observer inside the page rather than from the test process.
 * @param {import('@playwright/test').Page} page Page.
 * @param {string} title Breach title to wait for.
 * @returns {Promise<void>} Resolves once the observer is installed.
 */
function pauseOnBreach(page, title) {
  return page.evaluate(
    ([wanted, throttleKey, pauseKey]) => {
      const observer = new MutationObserver(() => {
        const titles = document.querySelectorAll('[data-testid="breach-toast"] [data-testid="breach-title"]');
        if (![...titles].some((t) => t.textContent?.trim() === wanted)) return;
        observer.disconnect();
        window.dispatchEvent(new KeyboardEvent('keyup', { code: throttleKey }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: pauseKey }));
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    },
    [title, KEY.throttle, KEY.pause],
  );
}

test.describe('toasts on a landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('a real speeding toast shows in short form, fully inside the stack and above the speed arc', async ({ page }) => {
    test.setTimeout(120_000);
    const problems = watchProblems(page);
    await startRun(page, 'car-sedan');
    // Full throttle down the straight start of tutorial 01 runs over the limit. The page itself
    // releases the throttle and pauses in the same task that adds the speeding toast, before the
    // next frame steps the sim, so the car cannot reach the crosswalk or crash however slowly the
    // test process answers, and the layout is read on a still frame.
    await pauseOnBreach(page, SPEEDING_TITLE);
    await page.keyboard.down(KEY.throttle);
    await expect(page.getByTestId('pause-overlay')).toBeVisible({ timeout: 60_000 });
    await page.keyboard.up(KEY.throttle);
    const newest = page.getByTestId('toast-stack').locator('[data-testid="breach-toast"]:visible');
    await expect(newest).toHaveCount(1);
    await expect(newest.getByTestId('breach-title')).toHaveText(SPEEDING_TITLE);
    await expect(newest.getByTestId('breach-penalty-short')).toBeVisible();
    await expect(newest.getByTestId('breach-toast-details')).toBeHidden();
    const fit = await readToastFit(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(fit.toastBottom).toBeLessThanOrEqual(fit.arcTop);
    // A tap on the penalty line opens the details. The pause overlay covers the stack and toasts
    // expire on the wall clock, so the tap is dispatched on the button itself.
    await newest.getByTestId('breach-penalty-short').dispatchEvent('click');
    await expect(newest).toHaveAttribute('data-expanded', 'true');
    await expect(newest.getByTestId('breach-toast-details')).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test('an empty or invalid stored preset gives Đơn giản', async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, 'arcade'), [CONTROL_PRESET_STORAGE_KEY]);
  await page.goto('/#/');
  await expect(page.getByTestId('preset-simple')).toBeChecked();
});
