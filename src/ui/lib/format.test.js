import { describe, expect, it } from 'vitest';
import {
  documentType,
  formatCitation,
  formatClock,
  formatDate,
  formatDecimal,
  formatDeduction,
  formatDistance,
  formatFineBand,
  formatLicencePoints,
  formatScore,
  formatSpeed,
  formatSuspension,
  formatVnd,
  keyLabel,
  sourceLabel,
} from './format.js';

describe('money', () => {
  it('groups VND with dots and the đồng sign', () => {
    expect(formatVnd(0)).toBe('0 ₫');
    expect(formatVnd(800000)).toBe('800.000 ₫');
    expect(formatVnd(20000000)).toBe('20.000.000 ₫');
  });

  it('formats a band with an en dash', () => {
    expect(formatFineBand({ min: 4000000, max: 6000000 })).toBe('4.000.000–6.000.000 ₫');
    expect(formatFineBand({ min: 500000, max: 500000 })).toBe('500.000 ₫');
    expect(formatFineBand(null)).toBeNull();
  });
});

describe('citations in Vietnamese order', () => {
  it('orders điểm, khoản, Điều, document', () => {
    expect(formatCitation({ article: 'Điều 6', clause: '5', point: 'đ' }, '168/2024/NĐ-CP')).toBe(
      'Điểm đ khoản 5 Điều 6 Nghị định 168/2024/NĐ-CP',
    );
  });

  it('starts with khoản or Điều when the finer parts are missing', () => {
    expect(formatCitation({ article: 'Điều 19', clause: '2' })).toBe('Khoản 2 Điều 19');
    expect(formatCitation({ article: 'Điều 50' }, '168/2024/NĐ-CP')).toBe('Điều 50 Nghị định 168/2024/NĐ-CP');
  });

  it('names the document type from the official number', () => {
    expect(documentType('238/2026/NĐ-CP')).toBe('Nghị định');
    expect(documentType('38/2024/TT-BGTVT')).toBe('Thông tư');
    expect(documentType('36/2024/QH15')).toBe('Luật');
    expect(documentType('QCVN 41:2024/BGTVT')).toBeNull();
    expect(sourceLabel('QCVN 41:2024/BGTVT')).toBe('QCVN 41:2024/BGTVT');
    expect(sourceLabel('36/2024/QH15')).toBe('Luật 36/2024/QH15');
  });
});

describe('clock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5.9)).toBe('0:05');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('reads invalid input as zero', () => {
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('numbers and labels', () => {
  it('uses a decimal comma', () => {
    expect(formatDecimal(7.25)).toBe('7,25');
    expect(formatDecimal(10)).toBe('10');
    expect(formatDecimal(0.5)).toBe('0,5');
    expect(formatScore(6.75)).toBe('6,75/10');
    expect(formatDeduction(0.25)).toBe('−0,25 điểm');
  });

  it('formats speed, distance, points, suspension and dates', () => {
    expect(formatSpeed(41.6)).toBe('42');
    expect(formatSpeed(-12)).toBe('12');
    expect(formatDistance(38.5)).toBe('39 m');
    expect(formatDistance(1234)).toBe('1,2 km');
    expect(formatLicencePoints(2)).toBe('Trừ 2 điểm giấy phép lái xe');
    expect(formatLicencePoints(0)).toBe('Không trừ điểm giấy phép lái xe');
    expect(formatSuspension({ min: 1, max: 3 })).toBe('Tước giấy phép lái xe 1–3 tháng');
    expect(formatSuspension({ min: 2, max: 2 })).toBe('Tước giấy phép lái xe 2 tháng');
    expect(formatSuspension(null)).toBeNull();
    expect(formatDate('2026-08-15')).toBe('15/08/2026');
    expect(formatDate(null)).toBeNull();
  });

  it('labels key codes', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('Space')).toBe('Phím cách');
  });
});
