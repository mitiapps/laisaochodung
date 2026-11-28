import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import hudStates from '../../../tests/fixtures/hud-states.json';
import BreachToast from '../hud/breach-toast.svelte';
import ResultScreen from './result-screen.svelte';

/** @typedef {import('../../contracts/score.js').Breach} Breach */
/** @typedef {import('../../contracts/score.js').ScoreReport} ScoreReport */

/** @type {Breach} */
const BASE = /** @type {Breach} */ (/** @type {unknown} */ (hudStates.withToasts.toasts[0]));

/**
 * A synthetic breach with every field the toast can show: a fine band, licence points, a
 * suspension (no shipped clause has one), an unverified clause, an inferred reading and a design
 * threshold. Test data only; it is not legal data.
 * @type {Breach}
 */
const FULL = {
  ...BASE,
  episodeId: 'synthetic-0',
  title: { vi: 'Lỗi mẫu để kiểm tra giao diện' },
  deduction: 1,
  clause: {
    ...BASE.clause,
    fineVnd: { min: 18000000, max: 20000000 },
    licencePoints: 4,
    suspensionMonths: { min: 1, max: 3 },
    verified: false,
  },
  inferred: true,
  designParams: ['entryToleranceM'],
};

/**
 * Text of server-rendered markup, tags dropped and whitespace collapsed.
 * @param {string} html Markup.
 * @returns {string} Text.
 */
function textOf(html) {
  return html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

describe('breach toast', () => {
  it('shows the fine band, licence points, suspension, linked citation and every badge', () => {
    const { body } = render(BreachToast, { props: { breach: FULL, ondismiss: () => {} } });
    const text = textOf(body);
    expect(text).toContain('Phạt tiền: 18.000.000–20.000.000 ₫');
    expect(text).toContain('Trừ 4 điểm giấy phép lái xe');
    expect(text).toContain('Tước giấy phép lái xe 1–3 tháng');
    expect(body).toMatch(/data-testid="breach-citation">(?:<!--[^>]*-->)*<a [^>]*href="https:\/\/[^"]+"/u);
    expect(text).toContain('Điểm a khoản 3 Điều 6 Nghị định 168/2024/NĐ-CP');
    for (const label of ['chưa kiểm chứng', 'suy luận', 'ngưỡng của trò chơi']) expect(text).toContain(label);
  });

  it('shows no badge, suspension or points line it does not have', () => {
    /** @type {Breach} */
    const plain = {
      ...FULL,
      clause: { ...FULL.clause, licencePoints: 0, suspensionMonths: null, verified: true },
      inferred: false,
      designParams: [],
    };
    const { body } = render(BreachToast, { props: { breach: plain, ondismiss: () => {} } });
    const text = textOf(body);
    expect(text).toContain('Không trừ điểm giấy phép lái xe');
    expect(body).not.toContain('data-testid="breach-suspension"');
    expect(body).not.toContain('data-testid="badge-');
  });
});

describe('result screen', () => {
  it('shows score out of 10, the breach list, the summed fine as an estimate and the licence after the largest deduction', () => {
    /** @type {Breach} */
    const second = { ...BASE, episodeId: 'speeding-1', clause: { ...BASE.clause, licencePoints: 2 } };
    /** @type {ScoreReport} */
    const report = {
      score: 8.5,
      breaches: [FULL, second],
      notices: [],
      licence: { start: 12, deducted: 4, remaining: 8 },
      fineTotalVnd: { min: 18800000, max: 21000000 },
      finished: true,
      endedBy: 'finish',
    };
    const { body } = render(ResultScreen, { props: { report, onretry: () => {}, onchangemap: () => {} } });
    const text = textOf(body);
    expect(text).toMatch(/8,5\s*\/\s*10/u);
    expect(text).toContain('Các lỗi vi phạm (2)');
    expect(body.match(/data-testid="result-breach"/gu)).toHaveLength(2);
    expect(text).toContain('Tổng tiền phạt (ước tính) 18.800.000–21.000.000 ₫');
    expect(text).toContain('12 → 8 điểm');
    expect(text).toContain('Về đích');
    expect(body).not.toContain('result-notices');
    expect(text).not.toContain('Thông báo');
  });

  it('lists each notice with its text after the breaches', () => {
    /** @type {import('../../contracts/score.js').Notice[]} */
    const notices = [
      { kind: 'npc-fault', tick: 300, t: 5, pos: { x: 0, z: 0 }, otherKind: 'motorbike', otherModel: null, violations: ['red-light'], text: { vi: 'Xe máy vượt đèn đỏ va vào bạn.' } },
      { kind: 'npc-fault', tick: 4500, t: 75, pos: { x: 3, z: 1 }, otherKind: 'car', otherModel: 'taxi', violations: ['tailgating'], text: { vi: 'Ô tô phía sau không giữ khoảng cách.' } },
    ];
    /** @type {ScoreReport} */
    const report = {
      score: 9,
      breaches: [{ ...BASE, episodeId: 'speeding-1' }],
      notices,
      licence: { start: 12, deducted: 0, remaining: 12 },
      fineTotalVnd: { min: 800000, max: 1000000 },
      finished: true,
      endedBy: 'finish',
    };
    const { body } = render(ResultScreen, { props: { report, onretry: () => {}, onchangemap: () => {} } });
    const text = textOf(body);
    expect(body.match(/data-testid="result-notice"/gu)).toHaveLength(2);
    const heading = text.indexOf('Thông báo (không trừ điểm)');
    expect(heading).toBeGreaterThan(text.indexOf('Các lỗi vi phạm (1)'));
    expect(heading).toBeGreaterThan(text.indexOf(BASE.title.vi));
    expect(text.indexOf('Xe máy vượt đèn đỏ va vào bạn.')).toBeGreaterThan(heading);
    expect(text.indexOf('Ô tô phía sau không giữ khoảng cách.')).toBeGreaterThan(text.indexOf('Xe máy vượt đèn đỏ va vào bạn.'));
    expect(text).toContain('1:15');
  });
  it('drops the game-score deduction from toasts and the result list in a free run', () => {
    const scoreOnly = { ...FULL, episodeId: 'synthetic-1', scoreOnly: true, clause: null };
    const scoredToast = textOf(render(BreachToast, { props: { breach: FULL, ondismiss: () => {} } }).body);
    expect(scoredToast).toContain('−1 điểm');
    for (const breach of [FULL, scoreOnly]) {
      const { body } = render(BreachToast, { props: { breach, scored: false, ondismiss: () => {} } });
      expect(body).not.toContain('data-testid="breach-deduction"');
      expect(textOf(body)).not.toContain('−1 điểm');
    }
    const freeOnly = textOf(render(BreachToast, { props: { breach: scoreOnly, scored: false, ondismiss: () => {} } }).body);
    expect(freeOnly).not.toContain('trừ điểm trò chơi');
    const report = /** @type {ScoreReport} */ ({ ...hudStates.finished.report, breaches: [FULL, scoreOnly] });
    const free = render(ResultScreen, { props: { report, mode: 'free', onretry: () => {}, onchangemap: () => {} } }).body;
    expect(free).not.toContain('data-testid="breach-deduction"');
    expect(textOf(free)).toContain('Phạt tiền');
    const scored = render(ResultScreen, { props: { report, onretry: () => {}, onchangemap: () => {} } }).body;
    expect(scored.match(/data-testid="breach-deduction"/gu)).toHaveLength(2);
  });
});
