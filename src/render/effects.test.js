import { describe, expect, it } from 'vitest';
import { MAX_SKID_SEGMENTS, createSkidMarks } from './effects.js';

/** Floats one segment writes (two triangles of three vertices). */
const SEG = 18;

/**
 * Skid marks and their position attribute.
 * @returns {{marks: ReturnType<typeof createSkidMarks>, attr: import('three').BufferAttribute}} Marks.
 */
function marks() {
  const m = createSkidMarks(0.2);
  const attr = /** @type {import('three').BufferAttribute} */ (m.mesh.geometry.getAttribute('position'));
  return { marks: m, attr };
}

/**
 * What the WebGL renderer does after it uploads an attribute.
 * @param {import('three').BufferAttribute} attr Attribute.
 */
function upload(attr) {
  attr.clearUpdateRanges();
  attr.onUploadCallback();
}

/**
 * Adds `n` one-metre segments along x.
 * @param {ReturnType<typeof createSkidMarks>} m Marks.
 * @param {number} n Count.
 */
function addSegments(m, n) {
  for (let i = 0; i < n; i += 1) m.add([i, 0], [i + 1, 0]);
}

describe('skid mark uploads', () => {
  it('uploads only the slots written since the last upload', () => {
    const { marks: m, attr } = marks();
    addSegments(m, 3);
    expect(attr.updateRanges).toEqual([{ start: 0, count: 3 * SEG }]);
    upload(attr);
    addSegments(m, 1);
    expect(attr.updateRanges).toEqual([{ start: 3 * SEG, count: SEG }]);
    const { start, count } = attr.updateRanges[0];
    expect(Array.from(attr.array.subarray(start, start + count)).some((x) => x !== 0)).toBe(true);
  });

  it('splits the range where the ring wraps', () => {
    const { marks: m, attr } = marks();
    addSegments(m, MAX_SKID_SEGMENTS - 1);
    upload(attr);
    addSegments(m, 2);
    expect(attr.updateRanges).toEqual([
      { start: (MAX_SKID_SEGMENTS - 1) * SEG, count: SEG },
      { start: 0, count: SEG },
    ]);
  });

  it('falls back to one full upload instead of piling up ranges while nothing is drawn', () => {
    const { marks: m, attr } = marks();
    addSegments(m, MAX_SKID_SEGMENTS * 6);
    // An empty list with needsUpdate set makes three.js upload the whole buffer.
    expect(attr.updateRanges).toEqual([]);
    expect(attr.version).toBeGreaterThan(0);
    upload(attr);
    addSegments(m, 1);
    expect(attr.updateRanges).toHaveLength(1);
  });
});
