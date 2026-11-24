/**
 * Human factors of traffic agents (after the Human Driver Model, Treiber, Kesting and Helbing 2006):
 * how an agent perceives the agent ahead of it on its route.
 *
 * - **Reaction delay.** The true gap and leader speed go into a ring buffer each step; the agent
 *   acts on the values of its reaction time ago, extrapolated over that time by the approach rate
 *   it saw then (HDM anticipation).
 * - **Perception error.** The perceived gap carries a relative error and the approach rate an error
 *   proportional to the gap, both driven by Ornstein–Uhlenbeck processes with time constant
 *   `humanFactors.perceptionTauS` (decay `e^(−DT/τ)` precomputed once per state).
 * - **Distraction.** Agents prone to it (a personality draw) have Poisson episodes, a mean
 *   `distractionIntervalS` apart, of `distractionDurationS`; during one the perceived inputs are
 *   held at their values when it began, the agent is not stopped by the true gap to the agent
 *   ahead, and it misses a change of light (it goes on unless it had already chosen to stop).
 *   Inattention is an incident cause, never a violation flag; what the agent then does wrong
 *   (passing a red stop line, say) is flagged from the true state.
 *
 * The ego, scripted actors and static obstacles are perceived exactly; only the agent ahead on the
 * route passes through here. An ego reset clears the perception of agents near the ego.
 *
 * Draws: the setup draws below come after the base setup draws of the agent's stream (personality, desired speed, variant, route seed); the per-step
 * noise uses its own stream per agent.
 */

import { PERSONALITIES } from '../../contracts/traffic.js';
import { DT } from '../../contracts/units.js';
import { nextUint32, normalish, range, uniform } from '../random.js';

/** @typedef {import('./state.js').TrafficState} TrafficState */
/** @typedef {import('../random.js').RandomStream} RandomStream */

/** Longest reaction time an agent can draw, seconds (design; the ring buffer holds this much). */
export const MAX_REACTION_S = 2.5;
/** Shortest reaction time an agent can draw, seconds (design). */
export const MIN_REACTION_S = 0.3;
/** Steps the ring buffer holds per agent. */
export const RING_STEPS = Math.ceil(MAX_REACTION_S / DT) + 1;
/** Gap stored in the ring when there is no agent ahead, metres (stands for Infinity in arithmetic). */
const NO_LEADER_GAP = 1e6;

/** @type {RandomStream} */
const NOISE = { state: 0 };

/**
 * Setup draws of the human factors, continuing the agent's stream after its base setup draws: reaction
 * time, distraction proneness, the speeding draw and its desired-speed factor, the time-gap
 * variation, then the seeds of its decision and noise streams.
 * @param {TrafficState} st State.
 * @param {number} slot Slot, already filled by the base setup.
 * @param {RandomStream} rng The agent's stream after its base setup draws.
 * @returns {void}
 */
export function drawHumanFactors(st, slot, rng) {
  const { params } = st;
  const key = st.modelKeys[st.model[slot]];
  const cls = params.classes[params.models[key].class];
  const pers = params.personalities[PERSONALITIES[st.personality[slot]]];
  const hf = params.humanFactors;

  // Lognormal reaction time with the class mean and spread.
  const m = cls.reactionMeanS;
  const s2 = Math.log(1 + (cls.reactionSdS * cls.reactionSdS) / (m * m));
  const reaction = Math.exp(Math.log(m) - s2 / 2 + Math.sqrt(s2) * normalish(rng)) * pers.reactionFactor;
  st.reactionSteps[slot] = Math.round(Math.min(MAX_REACTION_S, Math.max(MIN_REACTION_S, reaction)) / DT);
  st.distractProne[slot] = uniform(rng) < pers.violations.distracted ? 1 : 0;
  const speeding = uniform(rng) < pers.violations.speeding;
  const speedingFactor = range(rng, pers.speedingV0Factor[0], pers.speedingV0Factor[1]);
  const gapVar = normalish(rng);
  st.decisionSeed[slot] = nextUint32(rng);
  st.noiseState[slot] = nextUint32(rng);
  st.decisions[slot] = 0;

  st.speeding[slot] = speeding ? 1 : 0;
  if (speeding) st.v0Factor[slot] = Math.max(st.v0Factor[slot], speedingFactor);
  st.timeGap[slot] *= Math.max(0.5, 1 + hf.timeGapVarCoeff * gapVar);

  st.ouGap[slot] = 0;
  st.ouRate[slot] = 0;
  st.ringPos[slot] = 0;
  st.ringFresh[slot] = 1;
  st.seenGap[slot] = Infinity;
  st.seenV[slot] = 0;
  st.heldGap[slot] = Infinity;
  st.heldV[slot] = 0;
  st.distractUntil[slot] = -Infinity;
  st.nextDistract[slot] = st.distractProne[slot] ? st.t + episodeGap(st, slot) : Infinity;
}

/**
 * Exponential wait to the next distraction episode, from the agent's noise stream.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {number} Seconds.
 */
function episodeGap(st, slot) {
  NOISE.state = st.noiseState[slot];
  const u = uniform(NOISE);
  st.noiseState[slot] = NOISE.state;
  const mean = st.params.personalities[PERSONALITIES[st.personality[slot]]].distractionIntervalS;
  return -Math.log(1 - u) * mean;
}

/**
 * Whether the agent is in a distraction episode at `t`.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} t Time.
 * @returns {boolean} Distracted.
 */
export function distracted(st, slot, t) {
  return t < st.distractUntil[slot];
}

/**
 * Clears the perception of an agent: the ring refills with the truth at its next step and any
 * distraction episode ends (after an ego reset).
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @returns {void}
 */
export function resetPerception(st, slot) {
  st.ringFresh[slot] = 1;
  st.ouGap[slot] = 0;
  st.ouRate[slot] = 0;
  if (st.distractUntil[slot] > st.t) st.distractUntil[slot] = st.t;
}

/**
 * Perceives the agent ahead for one step: records the truth, advances the error processes and the
 * distraction clock, and writes the perceived `[gap, leader speed]` into `out` (gap Infinity when
 * no agent is perceived ahead). Call once per agent per step, in spawn order.
 * @param {TrafficState} st State.
 * @param {number} slot Slot.
 * @param {number} gap True bumper gap to the agent ahead, Infinity without one.
 * @param {number} vLead True speed of that agent.
 * @param {number} t Time of the step.
 * @param {Float64Array} out Output pair.
 * @returns {void}
 */
export function perceiveLeader(st, slot, gap, vLead, t, out) {
  const ring = st.ring;
  const base = slot * RING_STEPS * 2;
  const g = gap === Infinity ? NO_LEADER_GAP : gap;
  if (st.ringFresh[slot]) {
    for (let i = 0; i < RING_STEPS; i += 1) {
      ring[base + 2 * i] = g;
      ring[base + 2 * i + 1] = vLead;
    }
    st.ringFresh[slot] = 0;
  }
  const pos = st.ringPos[slot];
  ring[base + 2 * pos] = g;
  ring[base + 2 * pos + 1] = vLead;
  st.ringPos[slot] = (pos + 1) % RING_STEPS;

  // Error processes.
  NOISE.state = st.noiseState[slot];
  const decay = st.ouDecay;
  const kick = Math.sqrt(1 - decay * decay);
  st.ouGap[slot] = decay * st.ouGap[slot] + kick * normalish(NOISE);
  st.ouRate[slot] = decay * st.ouRate[slot] + kick * normalish(NOISE);
  st.noiseState[slot] = NOISE.state;

  // Distraction clock.
  if (t >= st.nextDistract[slot]) {
    NOISE.state = st.noiseState[slot];
    const [lo, hi] = st.params.humanFactors.distractionDurationS;
    st.distractUntil[slot] = t + range(NOISE, lo, hi);
    st.noiseState[slot] = NOISE.state;
    st.nextDistract[slot] = st.distractUntil[slot] + episodeGap(st, slot);
    st.heldGap[slot] = st.seenGap[slot];
    st.heldV[slot] = st.seenV[slot];
  }
  if (t < st.distractUntil[slot]) {
    out[0] = st.heldGap[slot];
    out[1] = st.heldV[slot];
    return;
  }

  const back = st.reactionSteps[slot];
  const j = (pos - back + RING_STEPS * 2) % RING_STEPS;
  const dg = ring[base + 2 * j];
  const dv = ring[base + 2 * j + 1];
  if (dg >= NO_LEADER_GAP || g >= NO_LEADER_GAP) {
    out[0] = g >= NO_LEADER_GAP ? Infinity : g;
    out[1] = vLead;
  } else {
    const pers = st.params.personalities[PERSONALITIES[st.personality[slot]]];
    const v = st.v[slot];
    const approach = v - dv + pers.approachErr * dg * st.ouRate[slot];
    // Anticipation: the gap of a reaction time ago, closed by the approach rate seen then.
    const anticipated = dg - approach * back * DT;
    out[0] = Math.max(0, anticipated * Math.exp(pers.distanceErr * st.ouGap[slot]));
    out[1] = Math.max(0, v - approach);
  }
  st.seenGap[slot] = out[0];
  st.seenV[slot] = out[1];
}
