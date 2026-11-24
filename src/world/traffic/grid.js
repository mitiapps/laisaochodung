/**
 * Uniform grid over agent centres for neighbour queries (spawn clearance; lateral slots and
 * footprint contacts can reuse it). Rebuilt each step into flat arrays by counting sort, so a
 * rebuild allocates nothing and a query visits cells in a fixed order.
 */

/** Cell size, metres (design: close to the query radius). */
export const GRID_CELL_M = 8;

/**
 * @typedef {object} Grid
 * @property {number} minX World x of column 0.
 * @property {number} minZ World z of row 0.
 * @property {number} cols Columns.
 * @property {number} rows Rows.
 * @property {Int32Array} cellStart First item of each cell (length cells + 1).
 * @property {Int32Array} cellOf Cell of each slot at the last rebuild, −1 when not inserted.
 * @property {Int32Array} items Slots ordered by cell.
 * @property {number} count Items inserted.
 */

/**
 * @param {{minX: number, minZ: number, maxX: number, maxZ: number}} bounds Area to cover; points
 *   outside it clamp to the border cells.
 * @param {number} capacity Most slots.
 * @returns {Grid} Empty grid.
 */
export function createGrid(bounds, capacity) {
  const margin = GRID_CELL_M;
  const minX = bounds.minX - margin;
  const minZ = bounds.minZ - margin;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + 2 * margin) / GRID_CELL_M));
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ + 2 * margin) / GRID_CELL_M));
  return {
    minX,
    minZ,
    cols,
    rows,
    cellStart: new Int32Array(cols * rows + 1),
    cellOf: new Int32Array(capacity).fill(-1),
    items: new Int32Array(capacity),
    count: 0,
  };
}

/**
 * @param {Grid} g Grid.
 * @param {number} x X.
 * @returns {number} Column, clamped.
 */
function col(g, x) {
  return Math.min(g.cols - 1, Math.max(0, Math.floor((x - g.minX) / GRID_CELL_M)));
}

/**
 * @param {Grid} g Grid.
 * @param {number} z Z.
 * @returns {number} Row, clamped.
 */
function row(g, z) {
  return Math.min(g.rows - 1, Math.max(0, Math.floor((z - g.minZ) / GRID_CELL_M)));
}

/**
 * Rebuilds the grid from slot positions.
 * @param {Grid} g Grid.
 * @param {Int32Array} slots Slots to insert.
 * @param {number} n How many of `slots`.
 * @param {Float64Array} xs X by slot.
 * @param {Float64Array} zs Z by slot.
 * @returns {void}
 */
export function rebuildGrid(g, slots, n, xs, zs) {
  const { cellStart, cellOf, items } = g;
  cellStart.fill(0);
  cellOf.fill(-1);
  for (let i = 0; i < n; i += 1) {
    const slot = slots[i];
    const c = row(g, zs[slot]) * g.cols + col(g, xs[slot]);
    cellOf[slot] = c;
    cellStart[c + 1] += 1;
  }
  for (let c = 0; c < g.cols * g.rows; c += 1) cellStart[c + 1] += cellStart[c];
  // Fill with a running cursor per cell; `cellStart[c]` is restored afterwards.
  for (let i = 0; i < n; i += 1) {
    const slot = slots[i];
    const c = cellOf[slot];
    items[cellStart[c]] = slot;
    cellStart[c] += 1;
  }
  for (let c = g.cols * g.rows; c > 0; c -= 1) cellStart[c] = cellStart[c - 1];
  cellStart[0] = 0;
  g.count = n;
}

/**
 * Calls `visit(slot)` for every inserted slot whose cell touches the square of half-size `radius`
 * around `(x, z)`, in cell order then insertion order. Stops early when `visit` returns true.
 * @param {Grid} g Grid.
 * @param {number} x Centre x.
 * @param {number} z Centre z.
 * @param {number} radius Half-size of the query square.
 * @param {(slot: number) => boolean | void} visit Visitor.
 * @returns {boolean} True when a visitor stopped the query.
 */
export function queryGrid(g, x, z, radius, visit) {
  const c0 = col(g, x - radius);
  const c1 = col(g, x + radius);
  const r0 = row(g, z - radius);
  const r1 = row(g, z + radius);
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const cell = r * g.cols + c;
      for (let i = g.cellStart[cell]; i < g.cellStart[cell + 1]; i += 1) {
        if (visit(g.items[i]) === true) return true;
      }
    }
  }
  return false;
}
