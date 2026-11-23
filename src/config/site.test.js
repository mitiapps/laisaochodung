import { describe, expect, it } from 'vitest';
import { SITE, checkSiteConfig, isContactHref, isEmail, isHttpsUrl } from './site.js';

describe('site config', () => {
  it('ships a valid config with contacts in preference order and a donate QR', () => {
    expect(checkSiteConfig(SITE)).toEqual([]);
    expect(SITE.contacts.map((c) => c.id)).toEqual(['github', 'email', 'facebook', 'telegram']);
    expect(SITE.donateQr?.src).toBe('/donate/zalopay-vietqr.jpg');
  });

  it('accepts plain addresses and rejects malformed ones', () => {
    expect(isEmail('someone@example.com')).toBe(true);
    expect(isEmail('no-at-sign.example.com')).toBe(false);
    expect(isEmail('a b@example.com')).toBe(false);
    expect(isEmail(null)).toBe(false);
  });

  it('accepts only https links', () => {
    expect(isHttpsUrl('https://example.com/donate')).toBe(true);
    expect(isHttpsUrl('http://example.com/donate')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
  });

  it('accepts https and mailto contacts only', () => {
    expect(isContactHref('mailto:someone@example.com')).toBe(true);
    expect(isContactHref('mailto:bad')).toBe(false);
    expect(isContactHref('javascript:alert(1)')).toBe(false);
    expect(isContactHref('https://t.me/example')).toBe(true);
  });

  it('reports each malformed field', () => {
    const bad = {
      contacts: [
        { id: 'a', label: 'A', text: 'a', href: 'http://x.example' },
        { id: 'a', label: '', text: 'a', href: 'https://x.example' },
      ],
      donateQr: { src: '../secret.jpg', alt: '' },
    };
    expect(checkSiteConfig(bad)).toHaveLength(5);
  });
});
