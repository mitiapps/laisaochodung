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
    expect(href).toBe('#/play?map=fixture-osm&vehicle=car-sedan');
    expect(parseHash(href)).toEqual({ name: 'play', mapId: 'fixture-osm', vehicleId: 'car-sedan', mode: 'scored' });
    expect(parseHash('#/play')).toEqual({ name: 'play', mapId: null, vehicleId: null, mode: 'scored' });
  });

  it('reads the run mode: only mode=free is free, anything else is scored', () => {
    const free = playHref('fixture-osm', 'scooter', 'free');
    expect(free).toBe('#/play?map=fixture-osm&vehicle=scooter&mode=free');
    expect(parseHash(free)).toEqual({ name: 'play', mapId: 'fixture-osm', vehicleId: 'scooter', mode: 'free' });
    expect(playHref('m', 'v', 'scored')).toBe(playHref('m', 'v'));
    expect(parseHash('#/play?map=m&vehicle=v&mode=scored').mode).toBe('scored');
    expect(parseHash('#/play?map=m&vehicle=v&mode=FREE').mode).toBe('scored');
    expect(parseHash('#/play?map=m&vehicle=v&mode=').mode).toBe('scored');
    expect(parseHash('#/play?map=m&vehicle=v&seed=3&mode=free').mode).toBe('free');
    expect(parseHash('#/lien-he?mode=free').mode).toBe('scored');
  });

  it('builds page links', () => {
    expect(pageHref('contact')).toBe('#/lien-he');
  });
});
