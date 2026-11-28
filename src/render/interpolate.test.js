import { describe, expect, it } from 'vitest';
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import { canInterpolate, interpolateActor, interpolateEgo, isDiscontinuity } from './interpolate.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */

const all = /** @type {Frame[]} */ (/** @type {unknown} */ (frames));

/**
 * Copy of a frame with extra events.
 * @param {Frame} frame Frame.
 * @param {Frame['events']} events Events to set.
 * @returns {Frame} Copy.
 */
function withEvents(frame, events) {
  return { ...frame, events };
}

describe('interpolation', () => {
  it('blends ego position between consecutive fixture frames', () => {
    const [a, b] = [all[10], all[11]];
    const p = interpolateEgo(a, b, 0.5);
    expect(p.x).toBeCloseTo((a.ego.pos.x + b.ego.pos.x) / 2, 9);
    expect(p.z).toBeCloseTo(b.ego.pos.z, 9);
    expect(interpolateEgo(a, b, 0).x).toBeCloseTo(a.ego.pos.x, 9);
    expect(interpolateEgo(a, b, 1).x).toBeCloseTo(b.ego.pos.x, 9);
  });

  it('draws the newest frame without a previous frame or with a bad alpha', () => {
    const b = all[5];
    expect(interpolateEgo(null, b, 0.3).x).toBe(b.ego.pos.x);
    expect(interpolateEgo(all[4], b, Number.NaN).x).toBe(b.ego.pos.x);
  });

  it('does not interpolate across reset or fall', () => {
    const a = all[20];
    for (const type of /** @type {const} */ (['reset', 'fall'])) {
      const b = withEvents({ ...all[21], ego: { ...all[21].ego, pos: { x: 500, y: 0, z: 500 } } }, [{ type }]);
      expect(isDiscontinuity(b)).toBe(true);
      expect(canInterpolate(a, b)).toBe(false);
      const p = interpolateEgo(a, b, 0.1);
      expect(p.x).toBe(500);
      expect(p.z).toBe(500);
      const actor = b.actors[1];
      expect(interpolateActor(a, b, actor, 0.1).x).toBe(actor.pos.x);
    }
  });

  it('does not interpolate from a newer or equal tick', () => {
    expect(canInterpolate(all[30], all[30])).toBe(false);
    expect(canInterpolate(all[31], all[30])).toBe(false);
  });

  it('blends actor positions by id', () => {
    const [a, b] = [all[40], all[41]];
    const pose = b.actors[1];
    const old = a.actors[1];
    expect(interpolateActor(a, b, pose, 0.5).x).toBeCloseTo((old.pos.x + pose.pos.x) / 2, 9);
  });

  it('writes the actor pose into a given object instead of allocating one', () => {
    const [a, b] = [all[40], all[41]];
    const pose = b.actors[1];
    const out = { x: 9, y: 9, z: 9, heading: 9 };
    expect(interpolateActor(a, b, pose, 0.5, out)).toBe(out);
    expect(out).toEqual(interpolateActor(a, b, pose, 0.5));
    expect(interpolateActor(null, b, pose, 0.5, out)).toBe(out);
    expect(out).toEqual({ x: pose.pos.x, y: 0, z: pose.pos.z, heading: pose.heading });
  });
});
