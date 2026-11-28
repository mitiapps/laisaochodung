import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import hudStates from '../../../tests/fixtures/hud-states.json';
import { VEHICLES } from '../lib/catalog.js';
import Hud from './hud.svelte';

/** @typedef {import('../../contracts/hud.js').HudState} HudState */

const RUNNING = /** @type {HudState} */ (/** @type {unknown} */ (hudStates.running));
const CAR = VEHICLES.find((v) => v.legalClass === 'car');
const BIKE = VEHICLES.find((v) => v.legalClass === 'motorbike');

/** @type {import('../../contracts/hud.js').GameControls} */
const CONTROLS = { hold: () => {}, press: () => {}, steer: () => {} };

/**
 * Server-rendered HUD markup.
 * @param {HudState} state HUD state.
 * @param {import('../../contracts/vehicle.js').VehicleInfo | undefined} vehicle Vehicle.
 * @returns {string} Markup.
 */
function hudHtml(state, vehicle) {
  if (!vehicle) throw new Error('The vehicle catalog lacks a car or a motorbike');
  return render(Hud, { props: { state, vehicle, toasts: [], controls: CONTROLS, onpause: () => {}, ondismiss: () => {} } }).body;
}

describe('HUD rendering', () => {
  it('shows the score and the nav arrow in a scored run', () => {
    const html = hudHtml(RUNNING, CAR);
    expect(html).toContain('data-testid="hud-score"');
    expect(html).toContain('data-testid="hud-nav"');
    expect(html).not.toContain('data-testid="hud-tally"');
  });

  it('shows the breach tally and no nav arrow in a free run', () => {
    // `breachCount` joins `HudState` with the free mode; the session fills it.
    const html = hudHtml(/** @type {HudState} */ ({ ...RUNNING, mode: 'free', nav: null, breachCount: 3 }), CAR);
    expect(hudHtml({ ...RUNNING, mode: 'free', nav: null }, CAR)).toMatch(/data-testid="hud-tally"[^>]*>0 lỗi</u);
    expect(html).toMatch(/data-testid="hud-tally"[^>]*>3 lỗi</u);
    expect(html).not.toContain('data-testid="hud-score"');
    expect(html).not.toContain('data-testid="hud-nav"');
  });

  it('hides the nav arrow whenever the state has no nav', () => {
    expect(hudHtml({ ...RUNNING, nav: null }, CAR)).not.toContain('data-testid="hud-nav"');
  });

  it('gives the scooter a push-back button and a LÙI chip in R, and the car neither', () => {
    const bike = hudHtml({ ...RUNNING, gear: 'D' }, BIKE);
    expect(bike).toContain('data-testid="hud-push-back"');
    expect(bike).not.toContain('data-testid="hud-reverse"');
    expect(hudHtml({ ...RUNNING, gear: 'R' }, BIKE)).toMatch(/data-testid="hud-reverse"[^>]*>LÙI</u);
    const car = hudHtml({ ...RUNNING, gear: 'R' }, CAR);
    expect(car).not.toContain('data-action="pushBack"');
    expect(car).not.toContain('data-testid="hud-reverse"');
  });
});
