import { describe, expect, it } from 'vitest';
import { neutralInput } from '../contracts/controls.js';
import { createElectrics, stepElectrics } from './electrics.js';

/**
 * Runs a list of partial inputs.
 * @param {Partial<import('../contracts/controls.js').ControlInput>[]} inputs Inputs.
 * @returns {ReturnType<typeof stepElectrics>[]} Outputs per step.
 */
function run(inputs) {
  let state = createElectrics();
  return inputs.map((i) => {
    const r = stepElectrics(state, { ...neutralInput(), ...i });
    state = r.state;
    return r;
  });
}

describe('stepElectrics', () => {
  it('toggles indicators, switches sides and keeps them on without a command', () => {
    const out = run([{ signalCmd: 'left' }, {}, { signalCmd: 'right' }, { signalCmd: 'right' }, {}]);
    expect(out.map((o) => o.indicators)).toEqual(['left', 'left', 'right', 'off', 'off']);
  });

  it('toggles the hazard lights over any indicator', () => {
    const out = run([{ signalCmd: 'left' }, { signalCmd: 'hazard' }, {}, { signalCmd: 'hazard' }]);
    expect(out.map((o) => o.indicators)).toEqual(['left', 'hazard', 'hazard', 'off']);
  });

  it('cycles the headlights and flashes high only while held', () => {
    const out = run([
      { lightsCmd: 'cycle' },
      { lightsCmd: 'flash' },
      { lightsCmd: 'flash' },
      {},
      { lightsCmd: 'cycle' },
      { lightsCmd: 'cycle' },
      { lightsCmd: 'flash' },
      {},
    ]);
    expect(out.map((o) => o.lights)).toEqual(['low', 'high', 'high', 'low', 'high', 'off', 'high', 'off']);
  });

  it('sounds the horn while held', () => {
    expect(run([{ horn: true }, {}]).map((o) => o.horn)).toEqual([true, false]);
  });
});
