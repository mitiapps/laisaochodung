import { expect, test } from '@playwright/test';
import { readToastFit } from './toast-fit.js';

/**
 * The HUD on the dev UI preview (`dev/ui-preview.html`, served by the vite dev server only), which
 * replays the recorded HUD states of `tests/fixtures/hud-states.json` through the stub game. Its
 * `withToasts` state carries three breach toasts and one notice at once, so the short-screen toast
 * stack is checked on a fixed input rather than on a driven run.
 */

test.describe('toast stack on a landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('shows only the newest of several toasts, with a count of the rest, inside the stack and above the arc', async ({ page }) => {
    /** @type {string[]} */
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

    await page.goto('/dev/ui-preview.html#/');
    await page.getByTestId('map-fixture-minimal').check();
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('hud')).toBeVisible();
    // The stub shows the state with toasts for one replay step before it finishes the run, so the
    // run is paused as soon as the toasts are there, before anything else is checked.
    await expect(page.getByTestId('breach-toast')).toHaveCount(3, { timeout: 15_000 });
    await page.getByTestId('hud-pause').click();
    await expect(page.getByTestId('notice-toast')).toHaveCount(1);

    const visible = page.getByTestId('toast-stack').locator('[data-testid="breach-toast"]:visible, [data-testid="notice-toast"]:visible');
    await expect(visible).toHaveCount(1);
    // The newest item is the latest breach of the recording, the crash.
    await expect(visible.getByTestId('breach-title')).toHaveText('Va chạm');
    await expect(visible.getByTestId('breach-penalty-short')).toBeVisible();
    await expect(page.getByTestId('toast-more')).toBeVisible();
    await expect(page.getByTestId('toast-more')).toHaveText('+3');
    const fit = await readToastFit(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(fit.toastBottom).toBeLessThanOrEqual(fit.arcTop);
    expect(problems).toEqual([]);
  });
});

test.describe('toast stack on a desktop window', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('shows every toast and no count', async ({ page }) => {
    await page.goto('/dev/ui-preview.html#/');
    await page.getByTestId('map-fixture-minimal').check();
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('breach-toast')).toHaveCount(3, { timeout: 15_000 });
    await page.getByTestId('hud-pause').click();
    await expect(page.getByTestId('toast-stack').locator('[data-testid="breach-toast"]:visible')).toHaveCount(3);
    await expect(page.getByTestId('toast-stack').locator('[data-testid="notice-toast"]:visible')).toHaveCount(1);
    await expect(page.getByTestId('toast-more')).toBeHidden();
  });
});
