/**
 * Data-quality badges shown with a breach.
 */

/** @typedef {import('../../contracts/score.js').Breach} Breach */

/**
 * @typedef {object} Badge
 * @property {'unverified' | 'inferred' | 'design'} id Stable id (also used as `data-testid` suffix).
 * @property {string} label Vietnamese label.
 * @property {string} hint Vietnamese explanation for the tooltip.
 */

/** @type {Readonly<Record<Badge['id'], Badge>>} */
export const BADGES = Object.freeze({
  unverified: {
    id: 'unverified',
    label: 'chưa kiểm chứng',
    hint: 'Mức phạt hoặc dữ liệu dùng để phát hiện lỗi (như tốc độ tối đa mặc định) chưa được đối chiếu với văn bản chính thức.',
  },
  inferred: {
    id: 'inferred',
    label: 'suy luận',
    hint: 'Điều khoản được áp dụng theo suy luận, văn bản không nêu trực tiếp tình huống này.',
  },
  design: {
    id: 'design',
    label: 'ngưỡng của trò chơi',
    hint: 'Ngưỡng phát hiện do trò chơi tự đặt, không có trong văn bản pháp luật.',
  },
});

/**
 * Badges for one breach: "chưa kiểm chứng" when its clause is not verified or the detection used
 * unverified legal data (`basisVerified: false`, e.g. a TT 38 default limit), "suy luận" when the
 * clause applies by inference, "ngưỡng của trò chơi" when a detection parameter has design basis.
 * @param {Breach} breach Breach.
 * @returns {Badge[]} Badges in display order.
 */
export function badgesFor(breach) {
  /** @type {Badge[]} */
  const out = [];
  if ((breach.clause && !breach.clause.verified) || breach.basisVerified === false) out.push(BADGES.unverified);
  if (breach.inferred) out.push(BADGES.inferred);
  if (breach.designParams.length > 0) out.push(BADGES.design);
  return out;
}
