/**
 * Painted lane-direction arrows (QCVN 41:2024 marking 9.3) from a built map's stop lines and lane
 * graph: one arrow per lane on every approach with a stop line and two or more lanes in the
 * direction, showing the movements the lane graph permits from that lane.
 */

import { CONNECTOR_TURNS } from '../../../src/contracts/map.js';
import { pointAtDistance, polylineLength, projectOntoPolyline } from '../../../src/geometry/index.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {import('../../../src/contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../../src/contracts/map.js').LaneArrow} LaneArrow */

/**
 * Distance from the stop line back to the arrow tip (m, `paramBasis: design`; the 15 m spacing is
 * in the 2026 draft only).
 */
export const LANE_ARROW_BEFORE_STOP_M = 15;
/**
 * Arrow length (m), read from Hình G.73 of the QCVN 41:2019 annex. Unverified for 2024: the 2026
 * draft has the same drawing and the 2024 drafting dossier does not list Phụ lục G as changed, but
 * the 2024 text itself was not read.
 */
export const LANE_ARROW_LENGTH_M = 3;
/** Lanes shorter than this get no arrow (m, design). */
export const LANE_ARROW_MIN_LANE_M = 25;

/**
 * Lane arrows of a map whose connectors are built.
 * @param {GameMap} map Map with `connectors`.
 * @returns {{arrows: LaneArrow[], notes: string[]}} Arrows, and the notes worth logging.
 */
export function buildLaneArrows(map) {
  /** @type {Map<string, Set<string>>} lane id → turns leaving it */
  const turnsOf = new Map();
  for (const c of map.connectors ?? []) {
    if (!turnsOf.has(c.fromLaneId)) turnsOf.set(c.fromLaneId, new Set());
    /** @type {Set<string>} */ (turnsOf.get(c.fromLaneId)).add(c.turn);
  }
  const lanes = new Map(map.roads.flatMap((r) => r.lanes.map((l) => [l.id, l])));
  /** @type {LaneArrow[]} */
  const arrows = [];
  /** @type {string[]} */
  const notes = [];
  for (const line of map.stopLines) {
    if (line.laneIds.length < 2) continue;
    const [a, b] = line.segment;
    const middle = /** @type {Vec2} */ ([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    for (const laneId of line.laneIds) {
      const lane = lanes.get(laneId);
      if (!lane) throw new Error(`stop line ${line.id} names unknown lane ${laneId}`);
      const len = polylineLength(lane.centerline);
      if (len < LANE_ARROW_MIN_LANE_M) {
        notes.push(`no lane arrow on ${laneId}: the lane is ${len.toFixed(1)} m, under ${LANE_ARROW_MIN_LANE_M} m`);
        continue;
      }
      const turns = CONNECTOR_TURNS.filter((t) => turnsOf.get(laneId)?.has(t));
      if (turns.length === 0) {
        notes.push(`no lane arrow on ${laneId}: no movement leaves the lane`);
        continue;
      }
      const tipS = projectOntoPolyline(middle, lane.centerline).s - LANE_ARROW_BEFORE_STOP_M;
      if (tipS < LANE_ARROW_LENGTH_M) {
        notes.push(`no lane arrow on ${laneId}: no room before the stop line`);
        continue;
      }
      const tip = pointAtDistance(lane.centerline, tipS);
      arrows.push({ id: `la-${laneId}`, laneId, pos: { x: tip.point[0], z: tip.point[1] }, heading: tip.heading, turns });
    }
  }
  return { arrows, notes };
}
