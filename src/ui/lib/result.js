/**
 * Result-screen view model.
 */

/** @typedef {import('../../contracts/score.js').ScoreReport} ScoreReport */

/** @type {Readonly<Record<ScoreReport['endedBy'], string>>} */
export const END_REASONS = Object.freeze({
  finish: 'Về đích',
  crash: 'Tai nạn, lượt chơi kết thúc',
  timeout: 'Hết thời gian',
  quit: 'Bỏ cuộc',
});

/** The licence rule the result screen applies (ND 168 Điều 50 khoản 1 điểm b, c). */
export const LICENCE_NOTE =
  'Chỉ trừ một lần số điểm của hành vi bị trừ nhiều điểm nhất; nếu số điểm còn lại ít hơn thì trừ hết (điểm b, c khoản 1 Điều 50 Nghị định 168/2024/NĐ-CP).';

/**
 * Vietnamese end reason.
 * @param {ScoreReport['endedBy']} endedBy End reason.
 * @returns {string} Label.
 */
export function endReasonLabel(endedBy) {
  return Object.hasOwn(END_REASONS, endedBy) ? END_REASONS[endedBy] : 'Kết thúc';
}

/**
 * Licence line, e.g. `12 → 10 điểm`.
 * @param {ScoreReport['licence']} licence Licence summary.
 * @returns {string} Label.
 */
export function licenceLabel(licence) {
  return `${licence.start} → ${licence.remaining} điểm`;
}
