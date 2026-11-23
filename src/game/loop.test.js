import { describe, expect, it } from 'vitest';
import { DT } from '../contracts/units.js';
import { MAX_STEPS_PER_FRAME, createLoop, createStepper } from './loop.js';

describe('createStepper', () => {
  it('takes one step per DT and carries the remainder into alpha', () => {
    const s = createStepper();
    expect(s.advance(DT)).toEqual({ steps: 1, alpha: expect.closeTo(0, 6) });
    const half = s.advance(DT / 2);
    expect(half.steps).toBe(0);
    expect(half.alpha).toBeCloseTo(0.5, 6);
    expect(s.advance(DT / 2).steps).toBe(1);
    expect(s.advance(3 * DT).steps).toBe(3);
  });

  it('clamps a long frame to 0.25 s and caps the steps at 5', () => {
    const s = createStepper();
    const r = s.advance(10);
    expect(r.steps).toBe(MAX_STEPS_PER_FRAME);
    // The owed steps are dropped: the next short frame takes one step, not a backlog.
    expect(s.advance(DT).steps).toBe(1);
  });

  it('ignores negative and non-finite deltas', () => {
    const s = createStepper();
    expect(s.advance(-1).steps).toBe(0);
    expect(s.advance(Number.NaN).steps).toBe(0);
    expect(s.advance(Number.POSITIVE_INFINITY).steps).toBe(0);
  });

  it('rejects bad options', () => {
    expect(() => createStepper({ dt: 0 })).toThrow(RangeError);
    expect(() => createStepper({ maxSteps: 1.5 })).toThrow(RangeError);
  });
});

/**
 * A manual animation-frame scheduler.
 * @returns {{requestFrame: (cb: (ts: number) => void) => number, cancelFrame: (h: number) => void, tick: (ms: number) => void, now: () => number, pending: () => number}} Fake.
 */
function fakeFrames() {
  let t = 0;
  let nextId = 1;
  /** @type {Map<number, (ts: number) => void>} */
  const queue = new Map();
  return {
    requestFrame(cb) {
      const id = nextId;
      nextId += 1;
      queue.set(id, cb);
      return id;
    },
    cancelFrame(h) {
      queue.delete(h);
    },
    tick(ms) {
      t += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(t);
    },
    now: () => t,
    pending: () => queue.size,
  };
}

describe('createLoop', () => {
  it('steps by elapsed time, renders once per frame, and stops when a step says so', () => {
    const f = fakeFrames();
    let steps = 0;
    /** @type {number[]} */
    const alphas = [];
    const loop = createLoop({
      step: () => {
        steps += 1;
        return steps < 4;
      },
      render: (a) => alphas.push(a),
      requestFrame: f.requestFrame,
      cancelFrame: f.cancelFrame,
      now: f.now,
    });
    loop.start();
    f.tick(16);
    expect(steps).toBe(0); // the first frame only sets the time base
    f.tick(1000 / 60);
    expect(steps).toBe(1);
    f.tick(2000 / 60 + 1);
    expect(steps).toBe(3);
    f.tick(1000);
    expect(steps).toBe(4);
    expect(loop.isRunning()).toBe(false);
    expect(f.pending()).toBe(0);
    expect(alphas).toHaveLength(4);
  });

  it('pauses without a time jump on resume', () => {
    const f = fakeFrames();
    let steps = 0;
    const loop = createLoop({ step: () => (steps += 1) > 0, render: () => {}, requestFrame: f.requestFrame, cancelFrame: f.cancelFrame, now: f.now });
    loop.start();
    f.tick(0);
    loop.stop();
    expect(f.pending()).toBe(0);
    f.tick(5000);
    loop.start();
    f.tick(10);
    f.tick(1000 / 60);
    expect(steps).toBe(1);
    loop.stop();
  });
});
