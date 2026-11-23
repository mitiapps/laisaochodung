import { describe, expect, it } from 'vitest';
import hudStates from '../../../tests/fixtures/hud-states.json';
import { badgesFor } from './badges.js';

/** @type {import('../../contracts/score.js').Breach[]} */
const toasts = /** @type {import('../../contracts/score.js').Breach[]} */ (
  /** @type {unknown} */ (hudStates.withToasts.toasts)
);

/**
 * @param {string} episodeId Episode.
 * @param {number} [tierIndex] Tier, for an episode with escalations.
 * @returns {string[]} Badge ids of the fixture breach.
 */
const ids = (episodeId, tierIndex) => {
  const breach = toasts.find((b) => b.episodeId === episodeId && (tierIndex === undefined || b.tierIndex === tierIndex));
  if (!breach) throw new Error(`fixture has no ${episodeId}`);
  return badgesFor(breach).map((b) => b.id);
};

describe('badge selection from a breach', () => {
  it('marks the unverified clause and the design threshold only where they apply', () => {
    expect(ids('speeding-0', 0)).toEqual(['unverified', 'design']);
    expect(ids('speeding-0', 1)).toEqual(['unverified', 'design']);
  });

  it('marks a verified clause detected against unverified data', () => {
    const breach = toasts.find((b) => b.episodeId === 'speeding-0' && b.tierIndex === 1);
    expect(breach?.clause?.verified).toBe(true);
    expect(breach?.basisVerified).toBe(false);
  });

  it('marks the inferred clause', () => {
    expect(ids('crosswalk-yield-0')).toEqual(['inferred']);
  });

  it('shows no badge on a score-only breach without design parameters', () => {
    expect(ids('crash-0')).toEqual([]);
  });

  it('each badge appears exactly for its condition across every fixture breach', () => {
    const all = [...toasts, ...(hudStates.finished.report?.breaches ?? [])];
    for (const b of /** @type {import('../../contracts/score.js').Breach[]} */ (/** @type {unknown} */ (all))) {
      const got = badgesFor(b).map((x) => x.id);
      expect(got.includes('unverified')).toBe((b.clause !== null && !b.clause.verified) || b.basisVerified === false);
      expect(got.includes('inferred')).toBe(b.inferred);
      expect(got.includes('design')).toBe(b.designParams.length > 0);
    }
  });
});
