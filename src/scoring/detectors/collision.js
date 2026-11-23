/**
 * `collision`: this step's collision and fall events, classified for the collision policy. A
 * collision whose own `egoSpeed` is below the scoring table's `contactMinEgoSpeed` is ignored,
 * so an NPC driving into a stopped player is never a breach. When several events share a step the
 * most severe wins. Severity ranks escalation inside one crash episode:
 * 4 pedestrian, 3 car accident (impulse ≥ `accidentImpulse`), 2 va chạm with the car ahead in the
 * same lane, 1 other car contact, 0 static object, kerb or fall.
 */

/** @typedef {import('../../contracts/index.js').CollisionEvent} CollisionEvent */

/**
 * @typedef {object} CollisionOutcome
 * @property {'pedestrian' | 'car-accident' | 'same-lane-ahead' | 'car-contact' | 'static' | 'fall'} kind Outcome.
 * @property {string | null} otherId Other body.
 * @property {number} impulse Impulse, 0 for a fall.
 */

/** @typedef {Record<string, never>} State */
/** @typedef {Record<string, never>} Params */

const SEVERITY = Object.freeze({ pedestrian: 4, 'car-accident': 3, 'same-lane-ahead': 2, 'car-contact': 1, static: 0, fall: 0 });

/** @returns {State} Fresh state. */
export function init() {
  return {};
}

/**
 * @param {CollisionEvent} e Event.
 * @param {number} accidentImpulse Accident impulse.
 * @returns {CollisionOutcome} Outcome.
 */
function classify(e, accidentImpulse) {
  /** @type {CollisionOutcome['kind']} */
  let kind = 'static';
  if (e.otherKind === 'pedestrian') kind = 'pedestrian';
  else if (e.otherKind === 'car') {
    if (e.impulse >= accidentImpulse) kind = 'car-accident';
    else kind = e.sameLaneAhead ? 'same-lane-ahead' : 'car-contact';
  }
  return { kind, otherId: e.otherId, impulse: e.impulse };
}

/**
 * @param {State} state State.
 * @param {import('../../contracts/index.js').Frame} frame Frame.
 * @param {import('../context.js').StepContext} ctx Context.
 * @returns {import('./common.js').DetectorResult} Result.
 */
export function detect(state, frame, ctx) {
  const { contactMinEgoSpeed, accidentImpulse } = ctx.env.bundle.scoring;
  /** @type {CollisionOutcome | null} */
  let worst = null;
  for (const e of frame.events) {
    /** @type {CollisionOutcome | null} */
    let o = null;
    if (e.type === 'fall') o = { kind: 'fall', otherId: null, impulse: 0 };
    else if (e.type === 'collision' && e.egoSpeed >= contactMinEgoSpeed) o = classify(e, accidentImpulse);
    if (o && (!worst || SEVERITY[o.kind] > SEVERITY[worst.kind])) worst = o;
  }
  if (!worst) return { detectorState: state, active: false, tierInput: {} };
  return { detectorState: state, active: true, tierInput: { collision: worst }, severity: SEVERITY[worst.kind] };
}
