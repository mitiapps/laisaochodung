import { describe, expect, it } from 'vitest';
import hudStates from '../../../tests/fixtures/hud-states.json';
import { MAX_TOASTS, TOAST_MS, dismissToast, emptyToastStack, ingestBreaches, pruneToasts } from './toast-stack.js';

/** @typedef {import('../../contracts/score.js').Breach} Breach */
/** @type {Breach[]} */
const fixture = /** @type {Breach[]} */ (/** @type {unknown} */ (hudStates.withToasts.toasts));

/**
 * @param {Partial<Breach>} over Overrides.
 * @returns {Breach} Breach.
 */
const breach = (over) => ({ ...fixture[0], ...over });

describe('toast stack', () => {
  it('keeps at most three toasts, dropping the oldest', () => {
    const stack = ingestBreaches(emptyToastStack(), fixture, 0);
    expect(stack.items).toHaveLength(MAX_TOASTS);
    expect(stack.items.map((t) => t.episodeId)).toEqual(fixture.slice(-MAX_TOASTS).map((b) => b.episodeId));
  });

  it('ignores breaches it has already shown, so resent states do not restart timers', () => {
    const a = ingestBreaches(emptyToastStack(), [fixture[2]], 0);
    const b = ingestBreaches(a, [fixture[2]], 5000);
    expect(b).toBe(a);
    expect(pruneToasts(b, TOAST_MS).items).toHaveLength(0);
  });

  it('does not revive an expired toast when the same breach is resent', () => {
    const a = pruneToasts(ingestBreaches(emptyToastStack(), [fixture[2]], 0), TOAST_MS);
    expect(ingestBreaches(a, [fixture[2]], TOAST_MS + 1).items).toHaveLength(0);
  });

  it('updates an open episode in place on escalation and restarts its timer', () => {
    const first = breach({ episodeId: 'e-1', tierIndex: 0, kind: 'new' });
    const other = breach({ episodeId: 'e-2', tierIndex: 0, kind: 'new' });
    const worse = breach({ episodeId: 'e-1', tierIndex: 1, kind: 'escalated', deduction: 1 });
    let stack = ingestBreaches(emptyToastStack(), [first, other], 0);
    stack = ingestBreaches(stack, [first, other, worse], 4000);
    expect(stack.items.map((t) => t.episodeId)).toEqual(['e-1', 'e-2']);
    expect(stack.items[0].breach.tierIndex).toBe(1);
    expect(stack.items[0].shownAt).toBe(4000);
    expect(pruneToasts(stack, 6500).items.map((t) => t.episodeId)).toEqual(['e-1']);
  });

  it('shows the clause an episode moves to at the same tier', () => {
    // A light crash tier first scored only, then citing the va chạm clause with its fine.
    const scoreOnly = breach({ episodeId: 'crash-0', tierIndex: 0, kind: 'new', clause: null, scoreOnly: true });
    const cited = breach({ episodeId: 'crash-0', tierIndex: 0, kind: 'escalated', clause: { ...fixture[0].clause, id: 'D6.4.l' } });
    let stack = ingestBreaches(emptyToastStack(), [scoreOnly], 0);
    stack = ingestBreaches(stack, [scoreOnly, cited], 1000);
    expect(stack.items).toHaveLength(1);
    expect(stack.items[0].breach.clause?.id).toBe('D6.4.l');
    expect(stack.items[0].shownAt).toBe(1000);
  });

  it('expires each toast after six seconds', () => {
    const stack = ingestBreaches(emptyToastStack(), [fixture[0]], 1000);
    expect(pruneToasts(stack, 1000 + TOAST_MS - 1)).toBe(stack);
    expect(pruneToasts(stack, 1000 + TOAST_MS).items).toEqual([]);
  });

  it('dismisses one toast', () => {
    const stack = ingestBreaches(emptyToastStack(), fixture.slice(1, 3), 0);
    expect(dismissToast(stack, 'speeding-0').items.map((t) => t.episodeId)).toEqual(['crosswalk-yield-0']);
  });
});
