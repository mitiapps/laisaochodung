/**
 * Site settings the maintainer fills in. Both stay `null` until the owner supplies them; the
 * contact and donate pages then say "chưa thiết lập". The release check blocks a deploy, not the
 * build, while either is `null`.
 */

/**
 * @typedef {object} SiteConfig
 * @property {string | null} contactEmail Address for problem reports, or null when not set up.
 * @property {string | null} donateUrl HTTPS donation link, or null when not set up.
 */

/** @type {Readonly<SiteConfig>} */
export const SITE = Object.freeze({
  contactEmail: null,
  donateUrl: null,
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
 * Checks a site config; a malformed value is an error, not a silent fallback.
 * @param {SiteConfig} config Config to check.
 * @returns {string[]} Problems found, empty when the config is valid.
 */
export function checkSiteConfig(config) {
  /** @type {string[]} */
  const problems = [];
  if (config.contactEmail !== null && !isEmail(config.contactEmail)) {
    problems.push('contactEmail must be null or an email address');
  }
  if (config.donateUrl !== null && !isHttpsUrl(config.donateUrl)) {
    problems.push('donateUrl must be null or an https URL');
  }
  return problems;
}

/**
 * `mailto:` link for the contact address.
 * @param {string | null} email Address or null.
 * @returns {string | null} Link, or null when the address is missing or invalid.
 */
export function mailtoHref(email) {
  return isEmail(email) ? `mailto:${email}` : null;
}
