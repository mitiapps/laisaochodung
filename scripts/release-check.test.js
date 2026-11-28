import { describe, expect, it } from 'vitest';
import { loadReleaseInput, releaseProblems } from './release-check.js';
import { clone, realBundle } from './rules/lib/test-support.js';

/** @typedef {import('./release-check.js').ReleaseInput} ReleaseInput */

/**
 * An input that passes every check: real data with every sign figure checked and the site set up.
 * @returns {Promise<ReleaseInput>} Input.
 */
async function passing() {
  const bundle = clone(await realBundle());
  for (const s of bundle.signs) s.figureChecked = '2026-11-23';
  return {
    bundle,
    site: {
      contacts: [{ id: 'email', label: 'Email', text: 'contact@example.com', href: 'mailto:contact@example.com' }],
      donateQr: { src: '/donate/qr.jpg', alt: 'QR' },
    },
    assetFiles: ['models/car-kit/sedan.glb', 'signs/P.101.svg'],
    trafficModels: { motorbike: { kind: 'motorbike' }, bus: { kind: 'car' } },
    credits: [
      { file: 'models/car-kit/sedan.glb', title: 'Sedan', author: 'Kenney', sourceUrl: 'https://kenney.nl/assets/car-kit', licence: 'CC0 1.0', licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', ownWork: false },
      { file: 'signs/P.101.svg', title: 'P.101', author: 'laisaochodung', sourceUrl: 'https://example.com', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0', ownWork: true },
    ],
    maps: [
      { id: 'osm-a', kind: 'osm', attribution: '© OpenStreetMap contributors, ODbL', mix: ['motorbike', 'bus'] },
      { id: 'tutorial-a', kind: 'tutorial', mix: [] },
    ],
    odblLicence: true,
    donateQrExists: true,
  };
}

describe('releaseProblems', () => {
  it('passes a release with verified data, site settings, credits and attribution', async () => {
    expect(releaseProblems(await passing())).toEqual([]);
  });

  it('passes without a donate QR', async () => {
    const input = await passing();
    input.site.donateQr = null;
    input.donateQrExists = false;
    expect(releaseProblems(input)).toEqual([]);
  });

  it('lists every blocker of a failing release', async () => {
    const input = await passing();
    input.bundle.clauses[0].verified = false;
    input.bundle.speedDefaults[0].verified = false;
    input.bundle.signs[0].verified = false;
    input.bundle.signs[0].figureChecked = null;
    input.site = { contacts: [], donateQr: { src: 'qr.jpg', alt: 'QR' } };
    input.donateQrExists = false;
    input.assetFiles.push('models/extra.glb');
    input.maps[0].attribution = undefined;
    input.odblLicence = false;
    input.maps[1].mix = ['rickshaw'];
    input.trafficModels.taxi = { kind: 'car' };
    const sign = input.bundle.signs[0].code;
    expect(releaseProblems(input)).toEqual([
      `unverified clauses: ${input.bundle.clauses[0].id}`,
      'unverified TT 38 speed defaults: 1',
      `unverified sign meanings: ${sign}`,
      `sign drawings not compared with the QCVN 41 figure (figureChecked: null): ${sign}`,
      'src/config/site.js: donateQr.src must be a root-relative path under public/',
      'src/config/site.js: no contact channel is set',
      'publicqr.jpg is missing',
      'public/models/extra.glb has no entry in data/credits/credits.json',
      'map osm-a: OSM map without an OpenStreetMap attribution',
      'data/maps/LICENSE-ODbL.md is missing',
      'map tutorial-a: traffic mix model rickshaw is not in data/traffic/params.yaml',
      'traffic model taxi: models/car-kit/taxi.glb has no entry in data/credits/credits.json',
    ]);
  });
});

describe('loadReleaseInput', () => {
  it('reads the repo: every shipped asset is credited and every OSM map attributed', async () => {
    const input = await loadReleaseInput();
    expect(input.assetFiles).toContain('models/car-kit/Textures/colormap.png');
    expect(input.maps.some((m) => m.kind === 'osm')).toBe(true);
    // Left for the maintainer: the sign figure comparison and the site settings.
    for (const p of releaseProblems(input)) expect(p).toMatch(/^(sign drawings not compared|src\/config\/site\.js: )/u);
  });
});
