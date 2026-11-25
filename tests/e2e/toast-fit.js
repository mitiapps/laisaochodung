/** Layout reading shared by the toast-stack browser tests. */

/**
 * How the toast stack fits: its scroll and client heights, and the bottom of the first visible
 * toast (breach or notice) against the top of the speed arc.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<{scroll: number, client: number, toastBottom: number, arcTop: number}>} Fit.
 */
export function readToastFit(page) {
  return page.evaluate(() => {
    const stack = /** @type {Element} */ (document.querySelector('[data-testid="toast-stack"]'));
    const arc = /** @type {Element} */ (document.querySelector('[data-testid="hud-speed-panel"]'));
    const shown = [...stack.querySelectorAll('[data-testid="breach-toast"], [data-testid="notice-toast"]')].find(
      (t) => t.getClientRects().length > 0,
    );
    return {
      scroll: stack.scrollHeight,
      client: stack.clientHeight,
      toastBottom: shown ? shown.getBoundingClientRect().bottom : Number.NaN,
      arcTop: arc.getBoundingClientRect().top,
    };
  });
}
