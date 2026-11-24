/**
 * Exact perception of the ego and of scripted actors. An agent tests its path corridor ahead
 * against their footprints, as `stepActors` does for scripted actors, instead of projecting them
 * onto a lane: that works with the ego across a lane line, inside a junction or on the wrong side.
 *
 * The corridor follows the agent's route (its edge, then the next edges), centred on its lateral
 * offset, `widthM + 2 · behaviour.corridorMarginM` wide, cut into `CORRIDOR_PIECE_M` pieces from the
 * agent's front. The first piece that touches a footprint gives the gap.
 */

import { leftVector, polygonsIntersect } from '../../geometry/index.js';
import { edgePoint } from './lane-graph.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('../../contracts/telemetry.js').Vec2} Vec2 */

/** Corridor piece length, metres (design); the gap is exact to this length. */
export const CORRIDOR_PIECE_M = 1.5;

/**
 * An obstacle perceived exactly.
 * @typedef {object} Obstacle
 * @property {Vec2[]} footprint Ground footprint.
 * @property {number} x Centre x.
 * @property {number} z Centre z.
 * @property {number} radius Half the footprint diagonal.
 * @property {number} vx Velocity x.
 * @property {number} vz Velocity z.
 */

/** @type {{x: number, z: number, heading: number}} */
const P = { x: 0, z: 0, heading: 0 };
/** @type {Vec2[]} */
const QUAD = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];

/**
 * Point `ds` ahead of the slot's centre along its route (its edge, the next edge, and a
 * connector's exit lane), clamped at the end of the known route. Writes into `P`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ds Distance ahead of the centre.
 * @returns {void}
 */
function routePoint(st, slot, ds) {
  const edges = st.graph.edges;
  let e = edges[st.edge[slot]];
  let s = st.s[slot] + ds;
  let next = st.nextEdge[slot];
  for (let hop = 0; hop < 2 && s > e.length && next >= 0; hop += 1) {
    s -= e.length;
    e = edges[next];
    next = e.kind === 'connector' ? e.toEdge : -1;
  }
  edgePoint(e, s, P);
}

/**
 * Corridor edge points of the piece end at `ds`, written into two quad corners.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} ds Distance ahead of the centre.
 * @param {number} halfW Half corridor width.
 * @param {number} iLeft Quad index of the left corner.
 * @param {number} iRight Quad index of the right corner.
 * @returns {void}
 */
function corner(st, slot, ds, halfW, iLeft, iRight) {
  routePoint(st, slot, ds);
  const [lx, lz] = leftVector(P.heading);
  const cx = P.x + lx * st.lateral[slot];
  const cz = P.z + lz * st.lateral[slot];
  QUAD[iLeft][0] = cx + lx * halfW;
  QUAD[iLeft][1] = cz + lz * halfW;
  QUAD[iRight][0] = cx - lx * halfW;
  QUAD[iRight][1] = cz - lz * halfW;
}

/**
 * Gap from the slot's front to the nearest obstacle in its corridor within `lookM`, and that
 * obstacle's speed along the agent's heading (at least 0). Writes `[gap, speed]` into `out`;
 * the gap is Infinity when the corridor is clear.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {readonly Obstacle[]} obstacles Candidates.
 * @param {number} lookM Corridor length ahead of the front.
 * @param {Float64Array} out Output pair.
 * @returns {void}
 */
export function corridorObstacle(st, slot, obstacles, lookM, out) {
  out[0] = Infinity;
  out[1] = 0;
  const half = st.lengthM[slot] / 2;
  const reach = half + lookM;
  const ax = st.x[slot];
  const az = st.z[slot];
  let any = false;
  for (const o of obstacles) {
    const dx = o.x - ax;
    const dz = o.z - az;
    const r = reach + o.radius;
    if (dx * dx + dz * dz <= r * r) {
      any = true;
      break;
    }
  }
  if (!any) return;
  const halfW = st.widthM[slot] / 2 + st.params.behaviour.corridorMarginM;
  const hx = Math.cos(st.heading[slot]);
  const hz = -Math.sin(st.heading[slot]);
  corner(st, slot, half, halfW, 0, 1);
  for (let a = 0; a < lookM - 1e-9; a += CORRIDOR_PIECE_M) {
    const b = Math.min(lookM, a + CORRIDOR_PIECE_M);
    corner(st, slot, half + b, halfW, 3, 2);
    for (const o of obstacles) {
      const dx = o.x - ax;
      const dz = o.z - az;
      const r = reach + o.radius;
      if (dx * dx + dz * dz > r * r) continue;
      if (polygonsIntersect(QUAD, o.footprint)) {
        out[0] = a;
        out[1] = Math.max(0, o.vx * hx + o.vz * hz);
        return;
      }
    }
    // The far corners become the near corners of the next piece.
    QUAD[0][0] = QUAD[3][0];
    QUAD[0][1] = QUAD[3][1];
    QUAD[1][0] = QUAD[2][0];
    QUAD[1][1] = QUAD[2][1];
  }
}
