import { describe, expect, it } from 'vitest';
import { DT } from '../../contracts/units.js';
import { idmAcceleration, idmEquilibriumGap, integrate } from './idm.js';

// The car row of the normal personality (data/traffic/params.yaml).
const CAR = { a: 1.5, b: 2, T: 1, s0: 2, delta: 4 };
const V0 = 15;

/**
 * Steps one agent for `seconds` behind an optional leader at a constant speed.
 * @param {number} seconds Duration.
 * @param {{v: number, s: number} | null} leader Leader at constant speed, or a free road.
 * @returns {{v: number, gap: number}} Final speed and gap.
 */
function drive(seconds, leader) {
  let v = 0;
  let x = 0;
  let lx = leader ? leader.s : Infinity;
  const out = [0, 0];
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const gap = leader ? lx - x : Infinity;
    const acc = idmAcceleration(v, V0, gap, leader ? v - leader.v : 0, CAR.a, CAR.b, CAR.T, CAR.s0, CAR.delta);
    integrate(v, Math.max(-8, acc), DT, out);
    x += out[0];
    v = out[1];
    if (leader) lx += leader.v * DT;
  }
  return { v, gap: leader ? lx - x : Infinity };
}

describe('idm', () => {
  it('converges to v0 on a free road', () => {
    const { v } = drive(120, null);
    expect(v).toBeGreaterThan(V0 * 0.98);
    expect(v).toBeLessThanOrEqual(V0);
  });

  it('settles at the equilibrium gap s0 + vT behind a steady leader', () => {
    for (const vl of [2, 5, 8]) {
      const { v, gap } = drive(300, { v: vl, s: 60 });
      expect(v).toBeCloseTo(vl, 2);
      const exact = idmEquilibriumGap(vl, V0, CAR.T, CAR.s0, CAR.delta);
      expect(gap).toBeCloseTo(exact, 1);
      // Well below v0 the exact equilibrium is s0 + vT within a few percent.
      expect(Math.abs(gap - (CAR.s0 + vl * CAR.T)) / gap).toBeLessThan(vl <= 5 ? 0.02 : 0.05);
    }
  });

  it('stops short of a standing obstacle by about s0 and never rolls back', () => {
    let v = 10;
    let x = 0;
    const wall = 80;
    const out = [0, 0];
    for (let i = 0; i < 60 * 60; i += 1) {
      const acc = Math.max(-8, idmAcceleration(v, V0, wall - x, v, CAR.a, CAR.b, CAR.T, CAR.s0, CAR.delta));
      integrate(v, acc, DT, out);
      expect(out[0]).toBeGreaterThanOrEqual(0);
      x += out[0];
      v = out[1];
    }
    expect(v).toBeLessThan(0.01);
    expect(wall - x).toBeGreaterThan(CAR.s0 * 0.9);
    expect(wall - x).toBeLessThan(CAR.s0 * 1.2);
  });

  it('integrates a stop inside one step exactly', () => {
    const out = [0, 0];
    integrate(0.05, -8, DT, out);
    expect(out[1]).toBe(0);
    expect(out[0]).toBeCloseTo((0.05 * 0.05) / 16, 12);
    expect(idmEquilibriumGap(V0, V0, 1, 2, 4)).toBe(Infinity);
  });
});
