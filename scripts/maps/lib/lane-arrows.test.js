import { describe, expect, it } from 'vitest';
import { CONNECTOR_TURNS } from '../../../src/contracts/map.js';
import { projectOntoPolyline } from '../../../src/geometry/index.js';
import { addLaneGraphAndTraffic } from '../build.js';
import { compileMap } from './elements.js';
import { LANE_ARROW_BEFORE_STOP_M, buildLaneArrows } from './lane-arrows.js';
import { tutorialSpec } from './source.js';

/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */

/**
 * A crossroads: w1 (two lanes each way) and w2 east–west, `cross` north–south with a short north arm.
 * @returns {{map: GameMap, notes: string[]}} Map with its lane graph and arrows, and the build notes.
 */
function crossroads() {
  const src = {
    kind: 'tutorial',
    name: { vi: 'Thử' },
    environment: { startClockMin: 600, weather: 'clear', surfaceGrip: 1 },
    timeLimitS: 100,
    nodes: { a: [0, 0], j: [200, 0], b: [400, 0], n: [200, -24], s: [200, 100] },
    ways: [
      { id: 'w1', nodes: ['a', 'j'], lanes: { forward: 2, backward: 2 } },
      { id: 'w2', nodes: ['j', 'b'], lanes: { forward: 2, backward: 2 } },
      { id: 'cross', nodes: ['n', 'j', 's'], lanes: { forward: 2, backward: 2 } },
    ],
    junctions: [{ node: 'j', signals: true }],
    signs: [{ id: 's-r420', code: 'R.420', at: { way: 'w1', s: 2 } }],
    route: { start: { way: 'w1', s: 20 }, finish: { way: 'w2', s: 100, lane: 0 } },
  };
  const notes = /** @type {string[]} */ ([]);
  const map = compileMap(tutorialSpec('t', src, () => ({})), notes);
  notes.push(...addLaneGraphAndTraffic(map, undefined, 't'));
  return { map, notes };
}

describe('lane arrows', () => {
  it('paints one arrow per approach lane with the turns its connectors permit', () => {
    const { map } = crossroads();
    const arrows = map.laneArrows ?? [];
    expect(arrows.map((a) => a.id).sort()).toEqual(['la-cross-2-b0', 'la-cross-2-b1', 'la-w1-f0', 'la-w1-f1', 'la-w2-b0', 'la-w2-b1']);
    for (const a of arrows) {
      const turns = new Set((map.connectors ?? []).filter((c) => c.fromLaneId === a.laneId).map((c) => c.turn));
      expect(a.turns).toEqual(CONNECTOR_TURNS.filter((t) => turns.has(t)));
    }
    expect(arrows.find((a) => a.id === 'la-w1-f0')?.turns).toEqual(['straight', 'right']);
    expect(arrows.find((a) => a.id === 'la-w1-f1')?.turns).toEqual(['straight', 'left']);
  });

  it('puts the tip 15 m before the stop line, on the lane centreline, along the lane', () => {
    const { map } = crossroads();
    const arrow = (map.laneArrows ?? []).find((a) => a.id === 'la-w1-f1');
    const line = map.stopLines.find((l) => l.id === 'sl-w1-f');
    const lane = map.roads.flatMap((r) => r.lanes).find((l) => l.id === 'w1-f1');
    if (!arrow || !line || !lane) throw new Error('missing arrow, stop line or lane');
    const at = projectOntoPolyline([arrow.pos.x, arrow.pos.z], lane.centerline);
    expect(at.distance).toBeCloseTo(0);
    expect(line.segment[0][0] - arrow.pos.x).toBeCloseTo(LANE_ARROW_BEFORE_STOP_M);
    expect(arrow.heading).toBeCloseTo(at.heading);
  });

  it('skips lanes under 25 m and approaches of one lane, and logs the short lanes', () => {
    const { notes } = crossroads();
    expect(notes.filter((n) => n.startsWith('no lane arrow'))).toEqual([
      'no lane arrow on cross-1-f0: the lane is 16.0 m, under 25 m',
      'no lane arrow on cross-1-f1: the lane is 16.0 m, under 25 m',
    ]);
    const { map } = crossroads();
    const single = buildLaneArrows({ ...map, stopLines: map.stopLines.map((l) => ({ ...l, laneIds: l.laneIds.slice(0, 1) })) });
    expect(single).toEqual({ arrows: [], notes: [] });
  });
});
