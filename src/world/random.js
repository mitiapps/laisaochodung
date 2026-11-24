/**
 * Seeded integer PRNG for deterministic world logic. No `Math.random`: every draw comes from a
 * stream whose whole state is one unsigned 32-bit integer, so a stream serialises as plain JSON
 * and a replay with the same seed draws the same numbers.
 *
 * - `splitmix32` mixes one integer (seeding and hashing).
 * - `mulberry32` is the generator: the draw from state `s` is `mulberry32(s)`, and the next state
 *   is `s + MULBERRY_INCREMENT` (mod 2³²).
 * - `streamFor(runSeed, mapId, index)` gives each agent its own stream, so an agent's draws do not
 *   depend on how many other agents exist or in which order they draw.
 *
 * The draw helpers advance a `RandomStream` in place and allocate nothing.
 */

/**
 * One random stream. `state` is an unsigned 32-bit integer.
 * @typedef {{state: number}} RandomStream
 */

/** Weyl increment of mulberry32 between two states. */
export const MULBERRY_INCREMENT = 0x6d2b79f5;

/** 2³², to map a 32-bit output to [0, 1). */
const TWO_POW_32 = 4294967296;
/** √3: four summed uniforms have variance 1/3. */
const SQRT3 = Math.sqrt(3);
/** FNV-1a 32-bit offset basis and prime. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Throws unless `v` is an integer that fits an unsigned or signed 32-bit word.
 * @param {unknown} v Value.
 * @param {string} what Name for the message.
 * @returns {number} The value as an unsigned 32-bit integer.
 */
function toUint32(v, what) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -0x80000000 || v > 0xffffffff) {
    throw new RangeError(`${what} must be a 32-bit integer, got ${String(v)}`);
  }
  return v >>> 0;
}

/**
 * splitmix32 output for one input: a well-mixed unsigned 32-bit integer.
 * @param {number} seed 32-bit integer.
 * @returns {number} Unsigned 32-bit integer.
 */
export function splitmix32(seed) {
  let z = (toUint32(seed, 'seed') + 0x9e3779b9) | 0;
  z ^= z >>> 16;
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  z ^= z >>> 15;
  return z >>> 0;
}

/**
 * mulberry32 output of the draw made from `state`; the stream then moves to
 * `(state + MULBERRY_INCREMENT) >>> 0`.
 * @param {number} state Unsigned 32-bit state.
 * @returns {number} Unsigned 32-bit output.
 */
export function mulberry32(state) {
  let t = (state + MULBERRY_INCREMENT) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/**
 * Order-sensitive hash of 32-bit integers.
 * @param {...number} ints Integers.
 * @returns {number} Unsigned 32-bit hash.
 */
export function hash32(...ints) {
  let h = splitmix32(ints.length);
  ints.forEach((v, i) => {
    h = splitmix32((h ^ toUint32(v, `hash32 argument ${i}`)) >>> 0);
  });
  return h;
}

/**
 * FNV-1a hash of a string's UTF-16 code units, for ids such as map ids.
 * @param {string} text Text.
 * @returns {number} Unsigned 32-bit hash.
 */
export function hashString(text) {
  if (typeof text !== 'string') throw new TypeError('hashString needs a string');
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * A stream seeded from one integer.
 * @param {number} seed 32-bit integer.
 * @returns {RandomStream} Stream.
 */
export function createStream(seed) {
  return { state: splitmix32(seed) };
}

/**
 * The stream of one agent (or of the spawner, with an index the caller reserves for it).
 * @param {number} runSeed Run seed, a 32-bit integer.
 * @param {string} mapId Map id.
 * @param {number} index Spawn index from 0.
 * @returns {RandomStream} Stream.
 */
export function streamFor(runSeed, mapId, index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`index must be an integer from 0, got ${String(index)}`);
  return { state: hash32(runSeed, hashString(mapId), index) };
}

/**
 * Next raw output; advances the stream.
 * @param {RandomStream} rng Stream.
 * @returns {number} Unsigned 32-bit integer.
 */
export function nextUint32(rng) {
  const out = mulberry32(rng.state);
  rng.state = (rng.state + MULBERRY_INCREMENT) >>> 0;
  return out;
}

/**
 * Uniform draw in [0, 1).
 * @param {RandomStream} rng Stream.
 * @returns {number} Value.
 */
export function uniform(rng) {
  return nextUint32(rng) / TWO_POW_32;
}

/**
 * Uniform draw in [min, max).
 * @param {RandomStream} rng Stream.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound, at least `min`.
 * @returns {number} Value.
 */
export function range(rng, min, max) {
  if (!(max >= min)) throw new RangeError(`range needs min ≤ max, got ${min}, ${max}`);
  return min + uniform(rng) * (max - min);
}

/**
 * Index drawn with probability proportional to its weight. Exactly one draw.
 * @param {RandomStream} rng Stream.
 * @param {readonly number[]} weights Non-negative weights with a positive sum.
 * @returns {number} Index into `weights`.
 */
export function pick(rng, weights) {
  let total = 0;
  for (const w of weights) {
    if (!(w >= 0) || !Number.isFinite(w)) throw new RangeError('pick needs finite non-negative weights');
    total += w;
  }
  if (!(total > 0)) throw new RangeError('pick needs a positive total weight');
  let x = uniform(rng) * total;
  let last = 0;
  for (let i = 0; i < weights.length; i += 1) {
    if (weights[i] === 0) continue;
    last = i;
    if (x < weights[i]) return i;
    x -= weights[i];
  }
  // Rounding left x at or just above the last weight.
  return last;
}

/**
 * Approximately standard-normal draw: four summed uniforms, centred and scaled to unit variance,
 * so it stays within ±2√3. Uses only arithmetic, no `log` or `cos`.
 * @param {RandomStream} rng Stream.
 * @returns {number} Value with mean 0 and variance 1.
 */
export function normalish(rng) {
  const sum = uniform(rng) + uniform(rng) + uniform(rng) + uniform(rng);
  return (sum - 2) * SQRT3;
}
