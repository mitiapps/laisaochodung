/**
 * Small shape checkers shared by `assertFrame` and `assertMap`. Each pushes a readable problem
 * (`path: message`) into `problems` and returns whether the value passed.
 */

/**
 * Untrusted JSON under validation. `any` is deliberate: the walkers read fields before their
 * shape is proven, and every read is guarded by a `Checker` call or optional chaining.
 */
// eslint-disable-next-line jsdoc/reject-any-type
/** @typedef {any} UntrustedJson */

/** Error thrown by the contract asserts; `problems` lists every failed check. */
export class ContractError extends Error {
  /**
   * @param {string} what What was checked, e.g. `Frame`.
   * @param {string[]} problems Problems found.
   */
  constructor(what, problems) {
    const shown = problems.slice(0, 10).join('; ');
    const more = problems.length > 10 ? ` (+${problems.length - 10} more)` : '';
    super(`Invalid ${what}: ${shown}${more}`);
    this.name = 'ContractError';
    this.problems = problems;
  }
}

/**
 * @param {unknown} v Value.
 * @returns {v is Record<string, unknown>} Plain object (not null, not an array).
 */
export function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} v Value.
 * @returns {v is number} Finite number.
 */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Collects problems for one value.
 */
export class Checker {
  constructor() {
    /** @type {string[]} */
    this.problems = [];
  }

  /**
   * @param {string} path Field path.
   * @param {string} message Problem.
   * @returns {false} Always false.
   */
  fail(path, message) {
    this.problems.push(`${path}: ${message}`);
    return false;
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {v is Record<string, unknown>} Object.
   */
  object(v, path) {
    return isObject(v) || this.fail(path, 'expected an object');
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {v is unknown[]} Array.
   */
  array(v, path) {
    return Array.isArray(v) || this.fail(path, 'expected an array');
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @param {{min?: number, max?: number, integer?: boolean}} [range] Bounds, inclusive.
   * @returns {v is number} Number in range.
   */
  number(v, path, range = {}) {
    if (!isFiniteNumber(v)) return this.fail(path, 'expected a finite number');
    if (range.integer && !Number.isInteger(v)) return this.fail(path, 'expected an integer');
    if (range.min !== undefined && v < range.min) return this.fail(path, `below ${range.min}`);
    if (range.max !== undefined && v > range.max) return this.fail(path, `above ${range.max}`);
    return true;
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {v is string} Non-empty string.
   */
  string(v, path) {
    return (typeof v === 'string' && v.length > 0) || this.fail(path, 'expected a non-empty string');
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {v is boolean} Boolean.
   */
  boolean(v, path) {
    return typeof v === 'boolean' || this.fail(path, 'expected a boolean');
  }

  /**
   * @param {unknown} v Value.
   * @param {readonly unknown[]} allowed Allowed values.
   * @param {string} path Field path.
   * @returns {boolean} One of `allowed`.
   */
  oneOf(v, allowed, path) {
    return allowed.includes(v) || this.fail(path, `expected one of ${allowed.map(String).join('|')}`);
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} `{vi, en?}` text.
   */
  text(v, path) {
    if (!this.object(v, path)) return false;
    let ok = this.string(v.vi, `${path}.vi`);
    if (v.en !== undefined && typeof v.en !== 'string') ok = this.fail(`${path}.en`, 'expected a string');
    return ok;
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} `[x, z]` of finite numbers.
   */
  vec2(v, path) {
    if (!Array.isArray(v) || v.length !== 2) return this.fail(path, 'expected [x, z]');
    return this.number(v[0], `${path}[0]`) && this.number(v[1], `${path}[1]`);
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} `{x, z}` of finite numbers.
   */
  pos2(v, path) {
    if (!this.object(v, path)) return false;
    return this.number(v.x, `${path}.x`) && this.number(v.z, `${path}.z`);
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} `{x, y, z}` of finite numbers.
   */
  pos3(v, path) {
    if (!this.object(v, path)) return false;
    return this.number(v.x, `${path}.x`) && this.number(v.y, `${path}.y`) && this.number(v.z, `${path}.z`);
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @param {number} minPoints Minimum point count.
   * @returns {boolean} Array of `[x, z]`.
   */
  points(v, path, minPoints) {
    if (!this.array(v, path)) return false;
    if (v.length < minPoints) return this.fail(path, `expected at least ${minPoints} points`);
    return v.every((p, i) => this.vec2(p, `${path}[${i}]`));
  }

  /**
   * Ring with the closing edge implied: at least 3 points, last point not equal to the first.
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} Valid polygon.
   */
  polygon(v, path) {
    if (!this.points(v, path, 3)) return false;
    const pts = /** @type {[number, number][]} */ (v);
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return this.fail(path, 'must not repeat the first point at the end');
    return true;
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} Polyline of at least 2 points.
   */
  polyline(v, path) {
    return this.points(v, path, 2);
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {boolean} Segment of two points.
   */
  segment(v, path) {
    if (!Array.isArray(v) || v.length !== 2) return this.fail(path, 'expected a segment [[x, z], [x, z]]');
    return this.vec2(v[0], `${path}[0]`) && this.vec2(v[1], `${path}[1]`);
  }

  /**
   * @param {unknown} v Value.
   * @param {string} path Field path.
   * @returns {v is string[]} Array of non-empty strings.
   */
  stringArray(v, path) {
    if (!this.array(v, path)) return false;
    return v.every((s, i) => this.string(s, `${path}[${i}]`));
  }
}
