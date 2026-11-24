import { expect, test } from '@playwright/test';
import { CONTROL_PRESET_STORAGE_KEY } from '../../src/ui/lib/control-preset-store.js';

/**
 * Smoke path through the shipped build: the home page lists the vehicles and maps, a run of
 * tutorial 01 starts with the car, the HUD follows the keys, and the static pages render.
 * Assertions read the DOM only; pixels are never compared, since headless WebGL is software.
 */

/**
 * Speed shown on the HUD, in km/h.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<number>} Speed.
 */
async function hudSpeed(page) {
  return Number(await page.getByTestId('hud-speed').innerText());
}

// These runs drive the Thực tế preset (manual gears, separate brakes); the preset is stored before load.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [CONTROL_PRESET_STORAGE_KEY, 'real']);
});

test('the app loads, drives, and its pages render without console errors', async ({ page }) => {
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  // vite preview serves public/_headers (vite.config.js): the run must pass under that policy.
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
  await expect(page.getByTestId('vehicle-car-sedan')).toBeVisible();
  await expect(page.getByTestId('vehicle-scooter')).toBeVisible();
  await expect(page.getByTestId('map-tutorial-01-co-ban')).toBeVisible();
  await expect(page.getByTestId('map-osm-pasteur')).toBeVisible();

  await page.getByTestId('vehicle-car-sedan').check();
  await page.getByTestId('map-tutorial-01-co-ban').check();
  await page.getByTestId('start-button').click();

  await expect(page.getByTestId('play-screen')).toBeVisible();
  await expect(page.getByTestId('hud')).toBeVisible();

  // The car starts in neutral: E puts it in first gear before W can move it.
  await expect(page.getByTestId('hud-gear')).toHaveText('N');
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('hud-gear')).toHaveText('1');

  // Hold W for three seconds; the HUD speed is then polled, not read at a fixed instant.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await expect.poll(() => hudSpeed(page), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.keyboard.up('KeyW');

  // Z lights the left indicator.
  await page.keyboard.press('KeyZ');
  await expect(page.getByTestId('hud-indicator-left')).toHaveAttribute('data-on', 'true');

  // E shifts up again while rolling: the gear readout changes from first to second.
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('hud-gear')).toHaveText('2');

  await expect(page.getByTestId('hud-nav-distance')).toContainText(/m|km/);

  await page.goto('/#/gioi-thieu');
  await expect(page.getByTestId('page-disclaimer')).toBeVisible();

  await page.goto('/#/lien-he');
  await expect(page.getByTestId('page-contact')).toBeVisible();
  await expect(page.getByTestId('contact-github')).toHaveAttribute('href', 'https://github.com/mitiapps/laisaochodung/issues');
  await expect(page.getByTestId('contact-email')).toHaveAttribute('href', 'mailto:tiennm99@outlook.com');

  await page.goto('/#/ung-ho');
  await expect(page.getByTestId('page-donate')).toBeVisible();
  await expect(page.getByTestId('donate-qr')).toHaveJSProperty('complete', true);
  expect(await page.getByTestId('donate-qr').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

  await page.goto('/#/ghi-cong');
  await expect(page.getByTestId('page-credits')).toBeVisible();
  await expect(page.getByTestId('credits-osm')).toContainText('OpenStreetMap');
  await expect(page.getByTestId('credits-libraries')).toContainText('three.js');
  const licences = await page.request.get('/third-party-licenses.md');
  expect(licences.ok()).toBe(true);
  expect(await licences.text()).toContain('three');

  expect(problems).toEqual([]);
});
