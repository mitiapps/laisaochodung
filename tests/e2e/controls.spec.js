import { expect, test } from '@playwright/test';
import { KEY_BINDINGS } from '../../src/contracts/controls.js';
import { CONTROL_PRESET_STORAGE_KEY } from '../../src/ui/lib/control-preset-store.js';
import { badgeFor } from '../../src/ui/lib/key-label.js';

/**
 * Control presets and the on-screen controls on the shipped build: Đơn giản is the default, every
 * action has a working on-screen control with its key badge, touch drives the same input as the
 * keys, and the controls fit a desktop window and a landscape phone without overlapping.
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
  await expect(page.getByTestId('hud-gear')).not.toHaveText('');
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
  await page.keyboard.down(KEY.throttle);
  await expect.poll(async () => Number(await page.getByTestId('hud-speed').innerText()), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.keyboard.up(KEY.throttle);

  await startRun(page, 'scooter');
  await page.keyboard.down(KEY.brake);
  await expect.poll(() => value(page, 'hud-brake-front')).toBeGreaterThan(0);
  await expect.poll(() => value(page, 'hud-brake-rear')).toBeGreaterThan(0);
  await page.keyboard.up(KEY.brake);
  expect(problems).toEqual([]);
});

test('desktop: every action has exactly one visible key badge, and a mouse click on a button keeps a held key', async ({ page }) => {
  const problems = watchProblems(page);
  await startRun(page, 'car-sedan');
  for (const binding of KEY_BINDINGS) {
    const badges = page.locator(`[data-badge="${binding.action}"]:visible`);
    await expect(badges, binding.action).toHaveCount(1);
    await expect(badges).toHaveText(badgeFor(binding.action));
  }

  // Hold W, then press the horn with the mouse: the button never takes focus, so nothing blurs
  // and the throttle stays held.
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

  test('tapping the throttle, the left indicator and the lights does what W, Z and L do, and hides the badges', async ({ page }) => {
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
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 844, height: 390 },
]) {
  test.describe(`layout at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    for (const vehicleId of /** @type {const} */ (['car-sedan', 'scooter'])) {
      test(`every control of the ${vehicleId} fits, is at least 56 px and overlaps nothing`, async ({ page }) => {
        await startRun(page, vehicleId);
        const layout = await page.evaluate(() => {
          /**
           * @param {Element} el Element.
           * @returns {{x: number, y: number, w: number, h: number}} Box.
           */
          const boxOf = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
          };
          const stack = /** @type {Element} */ (document.querySelector('[data-testid="toast-stack"]'));
          // The toast stack is checked at its reserved size: its width and its capped height.
          const reserved = { ...boxOf(stack), h: Number.parseFloat(getComputedStyle(stack).maxHeight) };
          return {
            controls: [...document.querySelectorAll('[data-action]')].map((el) => ({ action: /** @type {string} */ (el.getAttribute('data-action')), ...boxOf(el) })),
            speed: boxOf(/** @type {Element} */ (document.querySelector('[data-testid="hud-speed-panel"]'))),
            toasts: reserved,
            viewport: { w: window.innerWidth, h: window.innerHeight },
          };
        });
        /**
         * @param {{x: number, y: number, w: number, h: number}} a Box.
         * @param {{x: number, y: number, w: number, h: number}} b Box.
         * @returns {boolean} The boxes share some area.
         */
        const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(Number.isFinite(layout.toasts.h) && layout.toasts.h > 0).toBe(true);
        const expected = KEY_BINDINGS.length - 1; // the slider holds two actions
        expect(layout.controls).toHaveLength(expected);
        for (const c of layout.controls) {
          expect(c.x, c.action).toBeGreaterThanOrEqual(0);
          expect(c.y, c.action).toBeGreaterThanOrEqual(0);
          expect(c.x + c.w, c.action).toBeLessThanOrEqual(layout.viewport.w);
          expect(c.y + c.h, c.action).toBeLessThanOrEqual(layout.viewport.h);
          expect(c.w, c.action).toBeGreaterThanOrEqual(56);
          expect(c.h, c.action).toBeGreaterThanOrEqual(56);
          expect(overlap(c, layout.speed), `${c.action} on the speed panel`).toBe(false);
          expect(overlap(c, layout.toasts), `${c.action} on the toast stack`).toBe(false);
        }
        for (let i = 0; i < layout.controls.length; i += 1) {
          for (let j = i + 1; j < layout.controls.length; j += 1) {
            expect(overlap(layout.controls[i], layout.controls[j]), `${layout.controls[i].action} on ${layout.controls[j].action}`).toBe(false);
          }
        }
      });
    }
  });
}

test.describe('toasts on a landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('a real speeding toast shows in short form, fully inside the stack and above the speed arc', async ({ page }) => {
    test.setTimeout(120_000);
    const problems = watchProblems(page);
    await startRun(page, 'car-sedan');
    // Full throttle down the straight start of tutorial 01 runs over the limit; the run is paused
    // as soon as the toast shows, so the layout is read on a still frame.
    await page.keyboard.down(KEY.throttle);
    const toast = page.getByTestId('breach-toast').filter({ hasText: 'Chạy quá tốc độ quy định' }).first();
    await expect(toast).toBeVisible({ timeout: 60_000 });
    await page.keyboard.up(KEY.throttle);
    await page.keyboard.press(KEY.pause);
    await expect(toast.getByTestId('breach-penalty-short')).toBeVisible();
    await expect(toast.getByTestId('breach-toast-details')).toBeHidden();
    const fit = await page.evaluate(() => {
      const stack = /** @type {Element} */ (document.querySelector('[data-testid="toast-stack"]'));
      const arc = /** @type {Element} */ (document.querySelector('[data-testid="hud-speed-panel"]'));
      const first = /** @type {Element} */ (stack.querySelector('[data-testid="breach-toast"]'));
      return {
        scroll: stack.scrollHeight,
        client: stack.clientHeight,
        toastBottom: first.getBoundingClientRect().bottom,
        arcTop: arc.getBoundingClientRect().top,
      };
    });
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(fit.toastBottom).toBeLessThanOrEqual(fit.arcTop);
    // A tap on the penalty line opens the details. The pause overlay covers the stack and toasts
    // expire on the wall clock, so the tap is dispatched on the button itself.
    await toast.getByTestId('breach-penalty-short').dispatchEvent('click');
    await expect(toast).toHaveAttribute('data-expanded', 'true');
    await expect(toast.getByTestId('breach-toast-details')).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test('an empty or invalid stored preset gives Đơn giản', async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, 'arcade'), [CONTROL_PRESET_STORAGE_KEY]);
  await page.goto('/#/');
  await expect(page.getByTestId('preset-simple')).toBeChecked();
});
