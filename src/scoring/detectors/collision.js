/**
 * `collision`: this step's collision and fall events, classified for the collision policy. A
 * collision whose own `egoSpeed` is below the scoring table's `contactMinEgoSpeed` is ignored,
 * so an NPC driving into a stopped player is never a breach.
 *
 * Each outcome is light or heavy; the crash rule's tiers key on `heavy`. Heavy: a pedestrian hit,
 * an NPC car hit at a closing speed of at least `accidentRelSpeed` (an accident), a static object
 * or kerb hit at that speed or above, and a fall. Light: any other contact. Closing speed is used
 * because impulse scales with the player's mass.
 *
 * When several events share a step the most severe wins. Severity ranks escalation inside one
 * crash episode: every heavy outcome outranks every light one, then by kind: pedestrian, car
 * accident, va chạm with the car ahead in the same lane, other car contact, static object, kerb or
 * fall.
 */

/** @typedef {import('../../contracts/index.js').CollisionEvent} CollisionEvent */

/**
 * @typedef {object} CollisionOutcome
 * @property {'pedestrian' | 'car-accident' | 'same-lane-ahead' | 'car-contact' | 'static' | 'fall'} kind Outcome.
 * @property {boolean} heavy Heavy outcome (danger 5 tier); light contacts use the lower tier.
 * @property {string | null} otherId Other body.
 * @property {number} relSpeed Closing speed in m/s, 0 for a fall.
 * @property {number} impulse Impulse, 0 for a fall.
 */

/** @typedef {Record<string, never>} State */
/** @typedef {Record<string, never>} Params */

/** Rank of each kind inside its weight class. */
const KIND_RANK = Object.freeze({ pedestrian: 4, 'car-accident': 3, 'same-lane-ahead': 2, 'car-contact': 1, static: 0, fall: 0 });
/** Added to the rank of a heavy outcome so it outranks every light one. */
const HEAVY_RANK = 10;

/**
 * Escalation rank of an outcome.
 * @param {CollisionOutcome} o Outcome.
 * @returns {number} Severity.
 */
export function severityOf(o) {
  return (o.heavy ? HEAVY_RANK : 0) + KIND_RANK[o.kind];
}

/** @returns {State} Fresh state. */
export function init() {
  return {};
}

/**
 * @param {CollisionEvent} e Event.
 * @param {number} accidentRelSpeed Closing speed of an accident or a heavy static hit, in m/s.
 * @returns {CollisionOutcome} Outcome.
 */
function classify(e, accidentRelSpeed) {
  const fast = e.relSpeed >= accidentRelSpeed;
  /** @type {CollisionOutcome['kind']} */
  let kind = 'static';
  let heavy = fast;
  if (e.otherKind === 'pedestrian') {
    kind = 'pedestrian';
    heavy = true;
  } else if (e.otherKind === 'car') {
    if (fast) kind = 'car-accident';
    else kind = e.sameLaneAhead ? 'same-lane-ahead' : 'car-contact';
  }
  return { kind, heavy, otherId: e.otherId, relSpeed: e.relSpeed, impulse: e.impulse };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx) {
  const { contactMinEgoSpeed, accidentRelSpeed } = ctx.env.bundle.scoring;
  /** @type {CollisionOutcome | null} */
  let worst = null;
  for (const e of frame.events) {
    /** @type {CollisionOutcome | null} */
    let o = null;
    if (e.type === 'fall') o = { kind: 'fall', heavy: true, otherId: null, relSpeed: 0, impulse: 0 };
    else if (e.type === 'collision' && e.egoSpeed >= contactMinEgoSpeed) o = classify(e, accidentRelSpeed);
    if (o && (!worst || severityOf(o) > severityOf(worst))) worst = o;
  }
  if (!worst) return { detectorState: state, active: false, tierInput: {} };
  return { detectorState: state, active: true, tierInput: { collision: worst, heavy: worst.heavy }, severity: severityOf(worst) };
}
