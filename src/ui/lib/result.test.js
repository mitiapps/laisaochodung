import { describe, expect, it } from 'vitest';
import { ENDED_BY } from '../../contracts/score.js';
import { END_REASONS, endReasonLabel, licenceLabel, resultVariant } from './result.js';

describe('result view model', () => {
  it('labels every end reason in Vietnamese', () => {
    for (const reason of ENDED_BY) expect(END_REASONS[reason]).toBeTruthy();
    expect(endReasonLabel('quit')).toBe('Bỏ cuộc');
  });

  it('shows the licence from 12 to the remaining points', () => {
    expect(licenceLabel({ start: 12, deducted: 2, remaining: 10 })).toBe('12 → 10 điểm');
  });

  it('drops the score, end reason and licence line after a free run', () => {
    expect(resultVariant('scored')).toEqual({ title: 'Kết quả', showScore: true, showEndReason: true, showLicence: true });
    expect(resultVariant('free')).toEqual({ title: 'Kết thúc lái tự do', showScore: false, showEndReason: false, showLicence: false });
    expect(resultVariant(undefined)).toBe(resultVariant('scored'));
  });
});
