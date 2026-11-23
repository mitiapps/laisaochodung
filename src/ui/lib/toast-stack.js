/**
 * Breach-toast stack as a pure reducer with injected time. HUD states may resend the same
 * breaches on every update, so each (episode, tier, clause) is shown once; an escalation of an open
 * episode, or a change of the clause it cites at the same tier, updates its toast in place and
 * restarts its timer.
 */

/** @typedef {import('../../contracts/score.js').Breach} Breach */

/** Most toasts on screen at once. */
export const MAX_TOASTS = 3;
/** How long a toast stays, in milliseconds. */
export const TOAST_MS = 6000;

/**
 * @typedef {object} Toast
 * @property {string} episodeId Episode id; the toast key.
 * @property {Breach} breach Latest (worst) breach of the episode.
 * @property {number} shownAt Time the toast was opened or last escalated, in ms.
 */

/**
 * @typedef {object} ToastStack
 * @property {Toast[]} items Visible toasts, oldest first.
 * @property {Record<string, true>} seen `episodeId#tierIndex#clauseId` keys already shown
 *   (`score-only` in place of the clause id when there is none).
 */

/**
 * An empty stack.
 * @returns {ToastStack} Stack.
 */
export function emptyToastStack() {
  return { items: [], seen: {} };
}

/**
 * Adds breaches not shown before.
 * @param {ToastStack} stack Current stack.
 * @param {Breach[]} breaches Breaches from the HUD state, newest last.
 * @param {number} now Current time in ms.
 * @returns {ToastStack} Next stack (the input is not modified).
 */
export function ingestBreaches(stack, breaches, now) {
  let items = stack.items;
  let seen = stack.seen;
  for (const breach of breaches) {
    const key = `${breach.episodeId}#${breach.tierIndex}#${breach.clause?.id ?? 'score-only'}`;
    if (seen[key]) continue;
    seen = { ...seen, [key]: true };
    const open = items.findIndex((toast) => toast.episodeId === breach.episodeId);
    const toast = { episodeId: breach.episodeId, breach, shownAt: now };
    if (open >= 0) {
      items = items.map((item, i) => (i === open ? toast : item));
    } else {
      items = [...items, toast].slice(-MAX_TOASTS);
    }
  }
  return items === stack.items && seen === stack.seen ? stack : { items, seen };
}

/**
 * Drops toasts older than `TOAST_MS`.
 * @param {ToastStack} stack Current stack.
 * @param {number} now Current time in ms.
 * @returns {ToastStack} Next stack; the same object when nothing expired.
 */
export function pruneToasts(stack, now) {
  const items = stack.items.filter((toast) => now - toast.shownAt < TOAST_MS);
  return items.length === stack.items.length ? stack : { items, seen: stack.seen };
}

/**
 * Removes one toast early (the player closed it).
 * @param {ToastStack} stack Current stack.
 * @param {string} episodeId Episode to close.
 * @returns {ToastStack} Next stack.
 */
export function dismissToast(stack, episodeId) {
  return { items: stack.items.filter((t) => t.episodeId !== episodeId), seen: stack.seen };
}
