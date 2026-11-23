import { describe, expect, it } from 'vitest';
import { Mesh, BoxGeometry, Vector3 } from 'three';
import {
  MAX_LEAN_RAD,
  blinkOn,
  bodyToWorld,
  daylight,
  facingYaw,
  headingToYaw,
  leanAngle,
  leanToRoll,
  lerpAngle,
  wheelOffsets,
} from './math.js';
import { headingVector } from '../geometry/index.js';

/**
 * World direction of local +X (or +Z) after `rotation.y = yaw`.
 * @param {number} yaw Yaw.
 * @param {[number, number, number]} local Local vector.
 * @returns {Vector3} World vector.
 */
function turned(yaw, local) {
  const m = new Mesh(new BoxGeometry());
  m.rotation.y = yaw;
  m.updateMatrixWorld();
  return new Vector3(...local).applyMatrix4(m.matrixWorld).sub(m.getWorldPosition(new Vector3()));
}

describe('heading to rotation', () => {
  it('turns a +X-forward model onto the heading convention for several headings', () => {
    for (const h of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
      const v = turned(headingToYaw(h), [1, 0, 0]);
      const [fx, fz] = headingVector(h);
      expect(v.x).toBeCloseTo(fx, 9);
      expect(v.z).toBeCloseTo(fz, 9);
    }
  });

  it('points a sign face against the travel heading, towards approaching drivers', () => {
    for (const h of [0, Math.PI / 2, -2.1]) {
      const n = turned(facingYaw(h), [0, 0, 1]);
      const [fx, fz] = headingVector(h);
      expect(n.x).toBeCloseTo(-fx, 9);
      expect(n.z).toBeCloseTo(-fz, 9);
    }
  });
});

describe('lean', () => {
  it('leans left (positive) in a left turn and right in a right turn', () => {
    expect(leanAngle(10, 0.5)).toBeGreaterThan(0);
    expect(leanAngle(10, -0.5)).toBeLessThan(0);
    expect(leanAngle(10, 0.5)).toBeCloseTo(Math.atan(5 / 9.81), 12);
  });

  it('is zero at standstill and clamped to 40°', () => {
    expect(leanAngle(0, 1)).toBe(0);
    expect(leanAngle(30, 2)).toBeCloseTo(MAX_LEAN_RAD, 12);
    expect(leanAngle(30, -2)).toBeCloseTo(-MAX_LEAN_RAD, 12);
  });

  it('rolls the top of a +X-forward body towards its left side for a left lean', () => {
    const m = new Mesh(new BoxGeometry());
    m.rotation.x = leanToRoll(0.3);
    m.updateMatrixWorld();
    const top = new Vector3(0, 1, 0).applyMatrix4(m.matrixWorld);
    // Left of heading 0 is −Z.
    expect(top.z).toBeLessThan(0);
  });
});

describe('helpers', () => {
  it('interpolates headings along the short arc', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 12);
  });

  it('orders car wheels FL, FR, RL, RR and places them in the world', () => {
    const w = wheelOffsets('car', 4.5, 1.8);
    expect(w).toHaveLength(4);
    expect(w[0][0]).toBeGreaterThan(0);
    expect(w[0][1]).toBeGreaterThan(0);
    expect(w[1][1]).toBeLessThan(0);
    expect(w[2][0]).toBeLessThan(0);
    expect(wheelOffsets('motorbike', 1.85, 0.7)).toHaveLength(2);
    // Heading 0 faces east; left is north (−Z).
    expect(bodyToWorld({ x: 10, z: 5 }, 0, [2, 1])).toEqual([12, 4]);
  });

  it('blinks at 1.5 Hz from frame time', () => {
    expect(blinkOn(0)).toBe(true);
    expect(blinkOn(0.4)).toBe(false);
    expect(blinkOn(2 / 3)).toBe(true);
  });

  it('is day at noon, night at midnight and half-lit at 06:00', () => {
    expect(daylight(720)).toBe(1);
    expect(daylight(0)).toBe(0);
    expect(daylight(360)).toBeCloseTo(0.5, 12);
    expect(daylight(1080)).toBeCloseTo(0.5, 12);
  });
});
