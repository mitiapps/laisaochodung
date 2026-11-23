import { describe, expect, it, vi } from 'vitest';
import mapsIndex from '../../../tests/fixtures/maps-index.json';
import credits from '../../../tests/fixtures/credits.json';
import bundle from '../../../tests/fixtures/rules-bundle.json';
import { VEHICLES, loadMapIndex, parseCredits, parseMapIndex, parseVehicles, sourcesOf } from './catalog.js';

describe('catalog validation', () => {
  it('accepts the fixture map index and rejects malformed entries', () => {
    expect(parseMapIndex(mapsIndex)).toHaveLength(2);
    expect(() => parseMapIndex({})).toThrow();
    expect(() => parseMapIndex([{ id: 'x', name: { vi: 'X' }, kind: 'city', lengthM: 1 }])).toThrow(/entry 0/u);
  });

  it('accepts the fixture credits and rejects missing fields', () => {
    expect(parseCredits(credits)).toHaveLength(2);
    expect(() => parseCredits([{ file: 'a' }])).toThrow(/credit 0/u);
    // Links go straight into href: only https is accepted.
    expect(() => parseCredits([{ ...credits[0], licenceUrl: 'javascript:alert(1)' }])).toThrow(/credit 0/u);
  });

  it('loads the shipped vehicle catalog', () => {
    expect(VEHICLES.map((v) => v.id)).toEqual(['car-sedan', 'scooter']);
    expect(() => parseVehicles([])).toThrow();
  });

  it('reads legal sources from a rules bundle', () => {
    expect(sourcesOf(bundle).map((s) => s.id)).toContain('nd168-2024');
    expect(() => sourcesOf({})).toThrow();
    expect(() => sourcesOf({ sources: [{ ...bundle.sources[0], url: 'javascript:alert(1)' }] })).toThrow(/source 0/u);
  });

  it('fetches the map index and surfaces HTTP errors', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(mapsIndex)));
    expect(await loadMapIndex(ok, '/maps/index.json')).toHaveLength(2);
    const missing = vi.fn(async () => new Response('', { status: 404 }));
    await expect(loadMapIndex(missing, '/maps/index.json')).rejects.toThrow(/404/u);
  });
});
