/**
 * Vietnamese display formatting for the HUD, toasts and result screen. Plain functions with no
 * locale dependency, so output is identical in every browser and in Node tests.
 */

/** @typedef {import('../../contracts/rule.js').Citation} Citation */
/** @typedef {import('../../contracts/rule.js').Range} Range */

/**
 * Groups the digits of a non-negative integer with dots, Vietnamese style.
 * @param {number} value Integer amount.
 * @returns {string} E.g. `4.000.000`.
 */
function groupDigits(value) {
  return String(Math.round(Math.abs(value))).replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
}

/**
 * Formats a decimal number with a comma and at most `digits` decimals, trailing zeros dropped.
 * @param {number} value Number.
 * @param {number} [digits] Maximum decimals.
 * @returns {string} E.g. `7,25`, `10`.
 */
export function formatDecimal(value, digits = 2) {
  if (!Number.isFinite(value)) return '0';
  const raw = value.toFixed(digits);
  const fixed = raw.includes('.') ? raw.replace(/\.?0+$/u, '') : raw;
  const [int, frac] = fixed.split('.');
  const sign = int.startsWith('-') ? '−' : '';
  const grouped = groupDigits(Number(int.replace('-', '')));
  return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

/**
 * Formats an amount of đồng.
 * @param {number} vnd Amount in VND.
 * @returns {string} E.g. `4.000.000 ₫`.
 */
export function formatVnd(vnd) {
  return `${groupDigits(vnd)} ₫`;
}

/**
 * Formats a fine band. Equal ends collapse to one amount.
 * @param {Range | null} band Fine band in VND, or null when there is no fine.
 * @returns {string | null} E.g. `4.000.000–6.000.000 ₫`, or null without a band.
 */
export function formatFineBand(band) {
  if (!band) return null;
  if (band.min === band.max) return formatVnd(band.min);
  return `${groupDigits(band.min)}–${groupDigits(band.max)} ₫`;
}

/**
 * Formats a licence suspension.
 * @param {Range | null} months Suspension in months, or null.
 * @returns {string | null} E.g. `Tước giấy phép lái xe 1–3 tháng`, or null without one.
 */
export function formatSuspension(months) {
  if (!months) return null;
  const span = months.min === months.max ? `${months.min}` : `${months.min}–${months.max}`;
  return `Tước giấy phép lái xe ${span} tháng`;
}

/**
 * Formats licence points deducted by one clause.
 * @param {number} points Points.
 * @returns {string} Vietnamese label.
 */
export function formatLicencePoints(points) {
  return points > 0 ? `Trừ ${points} điểm giấy phép lái xe` : 'Không trừ điểm giấy phép lái xe';
}

/**
 * Formats a game-score deduction.
 * @param {number} deduction Deduction out of 10.
 * @returns {string} E.g. `−0,5 điểm`.
 */
export function formatDeduction(deduction) {
  return `−${formatDecimal(Math.abs(deduction))} điểm`;
}

/**
 * Formats a score out of 10.
 * @param {number} score Score.
 * @returns {string} E.g. `7,25/10`.
 */
export function formatScore(score) {
  return `${formatDecimal(score)}/10`;
}

/**
 * Formats the breach tally a free run shows in the score box instead of a score.
 * @param {number} count Distinct breach episodes so far; anything not finite or below 0 reads as 0.
 * @returns {string} E.g. `3 lỗi`.
 */
export function formatTally(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${n} lỗi`;
}

/**
 * Formats elapsed time as `m:ss`, or `h:mm:ss` from one hour.
 * @param {number} seconds Elapsed seconds; negative or non-finite values read as 0.
 * @returns {string} Clock string.
 */
export function formatClock(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Formats a distance for the navigation readout.
 * @param {number} metres Distance in metres.
 * @returns {string} `38 m` below one kilometre, `1,2 km` from it.
 */
export function formatDistance(metres) {
  const m = Number.isFinite(metres) && metres > 0 ? metres : 0;
  const rounded = Math.round(m);
  if (rounded < 1000) return `${rounded} m`;
  return `${formatDecimal(m / 1000, 1)} km`;
}

/**
 * Document type of an official number, from its suffix.
 * @param {string} number Official number, e.g. `168/2024/NĐ-CP`.
 * @returns {string | null} `Nghị định`, `Thông tư`, `Luật`, or null when the number names itself
 *   (QCVN) or is unknown.
 */
export function documentType(number) {
  if (/\/NĐ-CP$/u.test(number)) return 'Nghị định';
  if (/\/TT-[A-ZĐ]+$/u.test(number)) return 'Thông tư';
  if (/\/QH\d+$/u.test(number)) return 'Luật';
  return null;
}

/**
 * Name of a legal source as cited in running text.
 * @param {string} number Official number.
 * @returns {string} E.g. `Nghị định 168/2024/NĐ-CP`, `QCVN 41:2024/BGTVT`.
 */
export function sourceLabel(number) {
  const type = documentType(number);
  return type ? `${type} ${number}` : number;
}

/**
 * Formats a citation in Vietnamese order: điểm, khoản, Điều, document.
 * @param {Pick<Citation, 'article' | 'clause' | 'point'>} citation Citation.
 * @param {string | null} [number] Official number of the source; omitted when unknown.
 * @returns {string} E.g. `Điểm đ khoản 5 Điều 6 Nghị định 168/2024/NĐ-CP`.
 */
export function formatCitation(citation, number = null) {
  /** @type {string[]} */
  const parts = [];
  if (citation.point) parts.push(`điểm ${citation.point}`);
  if (citation.clause) parts.push(`khoản ${citation.clause}`);
  parts.push(citation.article);
  if (number) parts.push(sourceLabel(number));
  const text = parts.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Formats a speed for the HUD.
 * @param {number} kmh Speed in km/h.
 * @returns {string} Whole km/h.
 */
export function formatSpeed(kmh) {
  return String(Number.isFinite(kmh) ? Math.round(Math.abs(kmh)) : 0);
}

/**
 * Formats a selected gear.
 * @param {import('../../contracts/telemetry.js').Gear} gear Gear.
 * @returns {string} `N`, `R`, `D` or the gear number.
 */
export function formatGear(gear) {
  return String(gear);
}

/**
 * Formats a `YYYY-MM-DD` date as `DD/MM/YYYY`.
 * @param {string | null} iso ISO date or null.
 * @returns {string | null} Vietnamese date, or null when missing or malformed.
 */
export function formatDate(iso) {
  const match = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}
