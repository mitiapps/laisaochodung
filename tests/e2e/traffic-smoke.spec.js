import { expect, test } from '@playwright/test';

/**
 * Traffic on the shipped build: a run of `osm-pasteur` with its traffic, on a fresh random seed as
 * a player gets it, so only what holds for any seed is asserted, from the DOM. The canvas renders,
 * nothing is logged as an error or blocked by the CSP, and 30 seconds standing at the start do not
 * end or crash the run. A notice toast may appear (a rider may touch the parked car) and is allowed.
 *
 * No preset is stored: the run relies on the Đơn giản default on purpose, since it only idles.
 */

/** Seconds the ego stands at the start while traffic runs around it. */
const IDLE_S = 30;

test('osm-pasteur runs with traffic for 30 s with no console error and no CSP violation', async ({ page }) => {
  test.setTimeout(120_000);
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

  const response = await page.goto('/#/');
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  await page.getByTestId('vehicle-car-sedan').check();
  await page.getByTestId('map-osm-pasteur').check();
  await page.getByTestId('start-button').click();

  await expect(page.getByTestId('play-screen')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('hud')).toBeVisible();
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((c) => ({ w: /** @type {HTMLCanvasElement} */ (c).width, h: /** @type {HTMLCanvasElement} */ (c).height }));
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);

  await page.waitForTimeout(IDLE_S * 1000);
  await expect(page.getByTestId('play-screen')).toBeVisible();
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('result-ended-by')).toHaveCount(0);
  expect(Number(await page.getByTestId('hud-speed').innerText())).toBeGreaterThanOrEqual(0);

  expect(problems).toEqual([]);
});
