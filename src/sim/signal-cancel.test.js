import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DT } from '../contracts/units.js';
import { pointAtDistance, polylineLength } from '../geometry/index.js';
import { locate } from '../map-query/index.js';
import { cancelIndicators, createElectrics } from './electrics.js';
import { SIGNAL_CANCEL_DELAY_S, createSignalCancel, stepSignalCancel } from './signal-cancel.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../contracts/index.js').Indicators} Indicators */

/** @type {GameMap} */
const MAP = JSON.parse(readFileSync(new URL('../../tests/fixtures/map-junction.json', import.meta.url), 'utf8'));
const CFG = { turnMinDeg: 45, clearM: 30 };
const SPEED_MPS = 5;
const DELAY_STEPS = Math.round(SIGNAL_CANCEL_DELAY_S / DT);

/**
 * Points of an arc.
 * @param {(phi: number) => Vec2} at Point at an angle.
 * @param {number} to Last angle (from 0).
 * @returns {Vec2[]} Points.
 */
function arc(at, to) {
  /** @type {Vec2[]} */
  const out = [];
  for (let k = 0; k <= 40; k += 1) out.push(at((to * k) / 40));
  return out;
}

// Junction j1 is the square |x|, |z| ≤ 7. Heading 0 is east (+x); north is −z.
/** @type {Vec2[]} */
const LEFT_TURN = [[-40, 1.75], ...arc((p) => [-7 + 8.75 * Math.sin(p), -7 + 8.75 * Math.cos(p)], Math.PI / 2), [1.75, -60]];
/** @type {Vec2[]} */
const RIGHT_TURN = [[-40, 1.75], ...arc((p) => [-7 + 5.25 * Math.sin(p), 7 - 5.25 * Math.cos(p)], Math.PI / 2), [-1.75, 60]];
/** @type {Vec2[]} */
const U_TURN = [[-40, 1.75], ...arc((p) => [1.75 * Math.sin(p), 1.75 * Math.cos(p)], Math.PI), [-60, -1.75]];
/** @type {Vec2[]} */
const STRAIGHT = [[-40, 1.75], [60, 1.75]];
/** @type {Vec2[]} */
const LANE_CHANGE = [[-150, 1.75], [-120, 1.75], [-100, 5.25], [-60, 5.25]];

/**
 * Pre-step poses of a drive along a path at constant speed, one per step.
 * @param {Vec2[]} line Path.
 * @returns {Array<{pos: {x: number, z: number}, heading: number}>} Poses.
 */
function posesAlong(line) {
  const total = polylineLength(line);
  const out = [];
  for (let s = 0; s <= total; s += SPEED_MPS * DT) {
    const { point, heading } = pointAtDistance(line, s);
    out.push({ pos: { x: point[0], z: point[1] }, heading });
  }
  return out;
}

/**
 * Runs the tracker over a drive, applying each cancel to the indicator.
 * @param {GameMap} map Map.
 * @param {Vec2[]} line Path.
 * @param {(k: number, indicators: Indicators) => Indicators} indicatorAt Indicator the driver holds
 *   at step `k`, given the state after the last cancel.
 * @param {{resetAt?: number}} [options] Clear the tracker at this step, as a sim reset does.
 * @returns {{cancels: number[], exit: number | null}} Steps that cancelled, and the first step
 *   whose pose is outside j1 after being inside.
 */
function drive(map, line, indicatorAt, options = {}) {
  const poses = posesAlong(line);
  let state = createSignalCancel();
  /** @type {Indicators} */
  let indicators = 'off';
  /** @type {number[]} */
  const cancels = [];
  let wasInside = false;
  /** @type {number | null} */
  let exit = null;
  poses.forEach((pose, k) => {
    if (k === options.resetAt) state = createSignalCancel();
    indicators = indicatorAt(k, indicators);
    const inside = locate(map, [pose.pos.x, pose.pos.z], pose.heading).junctionId === 'j1';
    if (wasInside && !inside && exit === null) exit = k;
    wasInside = wasInside || inside;
    const r = stepSignalCancel(state, map, pose, indicators, CFG, DT);
    state = r.state;
    if (r.cancel) {
      cancels.push(k);
      indicators = 'off';
    }
  });
  return { cancels, exit };
}

/**
 * Driver who switches one side on at the start and never touches it again.
 * @param {Indicators} side Side.
 * @returns {(k: number, current: Indicators) => Indicators} Indicator policy.
 */
const holds = (side) => (k, current) => (k === 0 ? side : current);

/**
 * The fixture with one more junction.
 * @param {Vec2[]} polygon Its polygon.
 * @returns {GameMap} Map.
 */
function withJunction(polygon) {
  const map = structuredClone(MAP);
  map.junctions.push({ ...structuredClone(map.junctions[0]), id: 'j2', polygon });
  return map;
}

describe('stepSignalCancel', () => {
  it('cancels a signalled left turn once, SIGNAL_CANCEL_DELAY_S after the exit', () => {
    const { cancels, exit } = drive(MAP, LEFT_TURN, holds('left'));
    expect(exit).not.toBeNull();
    expect(cancels).toEqual([/** @type {number} */ (exit) + DELAY_STEPS]);
    expect(DELAY_STEPS * DT).toBeLessThanOrEqual(1);
  });

  it('cancels a signalled right turn and a left U-turn', () => {
    expect(drive(MAP, RIGHT_TURN, holds('right')).cancels).toHaveLength(1);
    expect(drive(MAP, U_TURN, holds('left')).cancels).toHaveLength(1);
  });

  it('never cancels a turn away from the indicator, a straight crossing, hazard or a lane change', () => {
    expect(drive(MAP, LEFT_TURN, holds('right')).cancels).toEqual([]);
    expect(drive(MAP, RIGHT_TURN, holds('left')).cancels).toEqual([]);
    expect(drive(MAP, STRAIGHT, holds('left')).cancels).toEqual([]);
    expect(drive(MAP, LEFT_TURN, holds('hazard')).cancels).toEqual([]);
    expect(drive(MAP, LANE_CHANGE, holds('right')).cancels).toEqual([]);
  });

  it('needs the indicator on from entry to the end of the delay', () => {
    const entry = posesAlong(LEFT_TURN).findIndex((p) => locate(MAP, [p.pos.x, p.pos.z], p.heading).junctionId === 'j1');
    // Switched on only after the entry.
    expect(drive(MAP, LEFT_TURN, (k, c) => (k === entry + 5 ? 'left' : c)).cancels).toEqual([]);
    // Hazard for one step inside the junction.
    expect(drive(MAP, LEFT_TURN, (k, c) => (k === 0 ? 'left' : k === entry + 5 ? 'hazard' : k === entry + 6 ? 'left' : c)).cancels).toEqual([]);
    // A side change, then back, during the delay.
    const { exit } = drive(MAP, LEFT_TURN, holds('left'));
    const x = /** @type {number} */ (exit);
    expect(drive(MAP, LEFT_TURN, (k, c) => (k === 0 ? 'left' : k === x + 3 ? 'right' : k === x + 4 ? 'left' : c)).cancels).toEqual([]);
  });

  it('holds off while another junction lies ahead within clearM, not one behind', () => {
    // Exit at z −7 heading north (−z): j2 starts 20 m ahead.
    const ahead = withJunction([[-7, -41], [7, -41], [7, -27], [-7, -27]]);
    expect(drive(ahead, LEFT_TURN, holds('left')).cancels).toEqual([]);
    // The same distance to the south, behind the ego after the turn.
    const behind = withJunction([[-7, 14], [7, 14], [7, 24], [-7, 24]]);
    expect(drive(behind, LEFT_TURN, holds('left')).cancels).toHaveLength(1);
    // Beyond clearM ahead.
    const far = withJunction([[-7, -60], [7, -60], [7, -45], [-7, -45]]);
    expect(drive(far, LEFT_TURN, holds('left')).cancels).toHaveLength(1);
  });

  it('forgets a pass when the tracker is cleared, as on a reset', () => {
    const { exit } = drive(MAP, LEFT_TURN, holds('left'));
    expect(drive(MAP, LEFT_TURN, holds('left'), { resetAt: /** @type {number} */ (exit) + 5 }).cancels).toEqual([]);
  });
});

describe('cancelIndicators', () => {
  it('switches the indicator off and keeps the headlights', () => {
    const state = { ...createElectrics(), indicators: /** @type {const} */ ('left'), selected: /** @type {const} */ ('low') };
    expect(cancelIndicators(state)).toEqual({ indicators: 'off', selected: 'low' });
    expect(state.indicators).toBe('left');
  });
});
