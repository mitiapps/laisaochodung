import { describe, expect, it } from 'vitest';
import { pageHref, parseHash, playHref } from './route.js';

describe('hash routes', () => {
  it('maps every page', () => {
    expect(parseHash('').name).toBe('home');
    expect(parseHash('#/').name).toBe('home');
    expect(parseHash('#/gioi-thieu').name).toBe('disclaimer');
    expect(parseHash('#/lien-he').name).toBe('contact');
    expect(parseHash('#/ung-ho').name).toBe('donate');
    expect(parseHash('#/ghi-cong').name).toBe('credits');
    expect(parseHash('#/khong-co').name).toBe('not-found');
  });

  it('round-trips play selections', () => {
    const href = playHref('fixture-osm', 'car-sedan');
    expect(parseHash(href)).toEqual({ name: 'play', mapId: 'fixture-osm', vehicleId: 'car-sedan' });
    expect(parseHash('#/play')).toEqual({ name: 'play', mapId: null, vehicleId: null });
  });

  it('builds page links', () => {
    expect(pageHref('contact')).toBe('#/lien-he');
  });
});
