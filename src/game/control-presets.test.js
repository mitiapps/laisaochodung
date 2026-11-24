import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { vehicleTuning } from '../physics/vehicles/index.js';
import { DEFAULT_CONTROL_PRESET, normalizeControlPreset, resolveControlPreset } from './control-presets.js';

/** @typedef {import('../contracts/index.js').RulesBundle} RulesBundle */

const BUNDLE = /** @type {RulesBundle} */ (JSON.parse(readFileSync(new URL('../generated/rules.json', import.meta.url), 'utf8')));
const CAR = vehicleTuning('car-sedan');
const SCOOTER = vehicleTuning('scooter');

/**
 * The bundle with the turn-signal rule's params replaced.
 * @param {Record<string, unknown> | null} params New params, or null to drop the rule.
 * @returns {RulesBundle} Bundle.
 */
function withTurnSignal(params) {
  const rules = BUNDLE.rules.flatMap((r) => (r.id !== 'turn-signal' ? [r] : params ? [{ ...r, detection: { ...r.detection, params } }] : []));
  return { ...BUNDLE, rules };
}

describe('resolveControlPreset', () => {
  it('simple: auto gearbox, auto-cancel from the bundle, the scooter combined brake from its tuning', () => {
    const rule = /** @type {import('../contracts/index.js').Rule} */ (BUNDLE.rules.find((r) => r.id === 'turn-signal'));
    const cancel = { turnMinDeg: rule.detection.params.turnMinDeg, clearM: rule.detection.params.signalFromM };
    expect(resolveControlPreset('simple', BUNDLE, CAR)).toEqual({
      preset: 'simple',
      simAssists: { autoGearbox: true, signalAutoCancel: cancel },
      inputOptions: { combinedRearPerGrip: 0 },
    });
    expect(resolveControlPreset('simple', BUNDLE, SCOOTER)).toEqual({
      preset: 'simple',
      simAssists: { autoGearbox: true, signalAutoCancel: cancel },
      inputOptions: { combinedRearPerGrip: SCOOTER.brakes.combinedRearPerGrip },
    });
    expect(SCOOTER.brakes.combinedRearPerGrip).toBeGreaterThan(0);
  });

  it('reads the thresholds from the bundle, never a copy', () => {
    const r = resolveControlPreset('simple', withTurnSignal({ mode: 'signal', signalFromM: 42, turnMinDeg: 50, uturnMinDeg: 135 }), CAR);
    expect(r.simAssists.signalAutoCancel).toEqual({ turnMinDeg: 50, clearM: 42 });
    expect(() => resolveControlPreset('simple', withTurnSignal(null), CAR)).toThrow(/turn-signal/);
    expect(() => resolveControlPreset('simple', withTurnSignal({ mode: 'signal' }), CAR)).toThrow(/turnMinDeg/);
  });

  it('real: no assists and separate brakes on both vehicles, whatever the bundle holds', () => {
    for (const tuning of [CAR, SCOOTER]) {
      expect(resolveControlPreset('real', withTurnSignal(null), tuning)).toEqual({
        preset: 'real',
        simAssists: { autoGearbox: false, signalAutoCancel: null },
        inputOptions: { combinedRearPerGrip: 0 },
      });
    }
  });

  it('falls back to simple for a missing or unknown preset', () => {
    expect(DEFAULT_CONTROL_PRESET).toBe('simple');
    for (const p of [undefined, null, 'arcade', 1]) {
      expect(normalizeControlPreset(p)).toBe('simple');
      expect(resolveControlPreset(p, BUNDLE, SCOOTER).preset).toBe('simple');
    }
    expect(normalizeControlPreset('real')).toBe('real');
  });
});
