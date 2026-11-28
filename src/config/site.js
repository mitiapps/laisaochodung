/**
 * Site settings the maintainer fills in. `npm run build` runs `scripts/release-check.js`
 * (`npm run release:check`) before the Vite bundle, and it fails the build while there is no
 * contact channel. The donate QR is optional: when it is set, its image must exist.
 */

/**
 * @typedef {object} ContactChannel
 * @property {string} id Stable id, used as the test id suffix.
 * @property {string} label Channel name shown to players.
 * @property {string} text Handle or address shown as the link text.
 * @property {string} href `https:` link, or `mailto:` with a plain address.
 */

/**
 * @typedef {object} DonateQr
 * @property {string} src Root-relative path of the QR image under `public/`.
 * @property {string} alt Alternative text of the image.
 */

/**
 * @typedef {object} SiteConfig
 * @property {ContactChannel[]} contacts Channels for problem reports, most preferred first.
 * @property {DonateQr | null} donateQr Bank-transfer QR, or null when not set up.
 */

/** @type {Readonly<SiteConfig>} */
export const SITE = Object.freeze({
  contacts: [
    {
      id: 'github',
      label: 'GitHub Issues',
      text: 'mitiapps/laisaochodung',
      href: 'https://github.com/mitiapps/laisaochodung/issues',
    },
    { id: 'email', label: 'Thư điện tử', text: 'tiennm99@outlook.com', href: 'mailto:tiennm99@outlook.com' },
    { id: 'facebook', label: 'Facebook', text: 'tiennm99', href: 'https://www.facebook.com/tiennm99' },
    { id: 'telegram', label: 'Telegram', text: '@tiennm5', href: 'https://t.me/tiennm5' },
  ],
  // Off while the game ships free-tier generated assets licensed for non-commercial use only
  // (data/credits/credits.json). To turn it back on, set:
  // { src: '/donate/zalopay-vietqr.jpg', alt: 'Mã QR chuyển khoản ZaloPay / VietQR, nhận tiền từ mọi ứng dụng ngân hàng' }
  donateQr: null,
});

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u;

/**
 * Whether a value is a usable contact address.
 * @param {unknown} value Candidate.
 * @returns {value is string} True for a plain `local@domain.tld` address.
 */
export function isEmail(value) {
  return typeof value === 'string' && EMAIL_PATTERN.test(value);
}

/**
 * Whether a value is an absolute HTTPS URL.
 * @param {unknown} value Candidate.
 * @returns {value is string} True for a parseable `https:` URL.
 */
export function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether a link is safe to render as a contact: `https:` or `mailto:` with a plain address.
 * @param {unknown} value Candidate.
 * @returns {value is string} True when usable.
 */
export function isContactHref(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('mailto:')) return isEmail(value.slice('mailto:'.length));
  return isHttpsUrl(value);
}

/**
 * Resolves a root-relative path under `public/` against the site's base path, so the asset loads
 * when the site is served from a sub-path such as `/<repo>/`.
 * @param {string} rootPath Root-relative path, e.g. `/donate/qr.jpg`.
 * @param {string} base Base path of the build (`import.meta.env.BASE_URL`), e.g. `/` or `/repo/`.
 * @returns {string} URL under the base, e.g. `/repo/donate/qr.jpg`.
 */
export function publicAssetUrl(rootPath, base) {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${rootPath.replace(/^\/+/u, '')}`;
}

/**
 * Checks a site config; a malformed value is an error, not a silent fallback.
 * @param {SiteConfig} config Config to check.
 * @returns {string[]} Problems found, empty when the config is valid.
 */
export function checkSiteConfig(config) {
  /** @type {string[]} */
  const problems = [];
  const ids = new Set();
  for (const c of config.contacts) {
    if (!isContactHref(c.href)) problems.push(`contact ${c.id}: href must be https: or mailto:<address>`);
    if (!c.label || !c.text) problems.push(`contact ${c.id}: label and text are required`);
    if (ids.has(c.id)) problems.push(`contact ${c.id}: duplicate id`);
    ids.add(c.id);
  }
  if (config.donateQr !== null) {
    if (!/^\/[\w./-]+$/u.test(config.donateQr.src) || config.donateQr.src.includes('..')) {
      problems.push('donateQr.src must be a root-relative path under public/');
    }
    if (!config.donateQr.alt) problems.push('donateQr.alt is required');
  }
  return problems;
}
