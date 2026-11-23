import { describe, expect, it } from 'vitest';
import { arrowRotationDeg } from './nav.js';

describe('navigation arrow', () => {
  it('points ahead when the target is ahead', () => {
    expect(arrowRotationDeg(0)).toBe(0);
    expect(arrowRotationDeg(Math.PI / 2, Math.PI / 2)).toBe(0);
  });

  it('rotates counter-clockwise (negative CSS degrees) for a target on the left', () => {
    expect(arrowRotationDeg(Math.PI / 2)).toBeCloseTo(-90);
    expect(arrowRotationDeg(Math.PI, Math.PI / 2)).toBeCloseTo(-90);
  });

  it('rotates clockwise for a target on the right and wraps behind', () => {
    expect(arrowRotationDeg(-Math.PI / 2)).toBeCloseTo(90);
    expect(arrowRotationDeg(Math.PI)).toBeCloseTo(180);
    expect(arrowRotationDeg(3 * Math.PI)).toBeCloseTo(180);
  });
});
