import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import hudStates from '../../../tests/fixtures/hud-states.json';
import ResultScreen from './result-screen.svelte';

/** @typedef {import('../../contracts/score.js').ScoreReport} ScoreReport */

const REPORT = /** @type {ScoreReport} */ (/** @type {unknown} */ (hudStates.finished.report));

/**
 * Server-rendered result screen.
 * @param {ScoreReport} report Report.
 * @param {import('../../contracts/hud.js').RunMode} [mode] Run mode.
 * @returns {string} Markup.
 */
function resultHtml(report, mode) {
  return render(ResultScreen, { props: { report, mode, onretry: () => {}, onchangemap: () => {} } }).body;
}

describe('result screen variants', () => {
  it('shows the score, end reason and licence line after a scored run', () => {
    const html = resultHtml(REPORT);
    for (const id of ['result-score', 'result-ended-by', 'result-licence', 'result-fine-total']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toMatch(/data-testid="result-title"[^>]*>Kết quả</u);
  });

  it('shows the breach list and fine estimate after a free run, with no score, licence or "Bỏ cuộc"', () => {
    const html = resultHtml({ ...REPORT, endedBy: 'quit', finished: false }, 'free');
    expect(html).toMatch(/data-testid="result-title"[^>]*>Kết thúc lái tự do</u);
    expect(html).toContain('data-testid="result-fine-total"');
    expect(html).toContain(REPORT.breaches.length > 0 ? 'data-testid="result-breaches"' : 'data-testid="result-clean"');
    for (const id of ['result-score', 'result-ended-by', 'result-licence']) expect(html).not.toContain(`data-testid="${id}"`);
    expect(html).not.toContain('Bỏ cuộc');
    expect(html).not.toContain('Điều 50');
  });
});
