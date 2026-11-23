import { describe, expect, it } from 'vitest';
import { SITE, checkSiteConfig, isEmail, isHttpsUrl, mailtoHref } from './site.js';

describe('site config', () => {
  it('ships a valid config (nulls allowed until the owner supplies values)', () => {
    expect(checkSiteConfig(SITE)).toEqual([]);
  });

  it('accepts plain addresses and rejects malformed ones', () => {
    expect(isEmail('someone@example.com')).toBe(true);
    expect(isEmail('no-at-sign.example.com')).toBe(false);
    expect(isEmail('a b@example.com')).toBe(false);
    expect(isEmail(null)).toBe(false);
  });

  it('accepts only https donation links', () => {
    expect(isHttpsUrl('https://example.com/donate')).toBe(true);
    expect(isHttpsUrl('http://example.com/donate')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
  });

  it('reports each malformed field', () => {
    expect(checkSiteConfig({ contactEmail: 'bad', donateUrl: 'http://x.example' })).toHaveLength(2);
  });

  it('builds mailto links only for valid addresses', () => {
    expect(mailtoHref('someone@example.com')).toBe('mailto:someone@example.com');
    expect(mailtoHref(null)).toBeNull();
    expect(mailtoHref('bad')).toBeNull();
  });
});
