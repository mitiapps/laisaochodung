<script>
  import BreachDetails from '../result/breach-details.svelte';
  import { formatDeduction, formatFineBand } from '../lib/format.js';

  /**
   * @type {{
   *   breach: import('../../contracts/score.js').Breach,
   *   scored?: boolean,
   *   ondismiss: () => void,
   * }}
   */
  let { breach, scored = true, ondismiss } = $props();

  // Below 480 px of viewport height (a landscape phone) the toast shows its label, title and
  // penalty line only, so it does not cover the road; a tap on that line opens the details.
  let expanded = $state(false);
  const fine = $derived(breach.scoreOnly || !breach.clause ? null : formatFineBand(breach.clause.fineVnd));
  // A free run (`scored` false) has no score, so the line drops the game-score deduction.
  const penalty = $derived(
    [scored ? formatDeduction(breach.deduction) : null, fine].filter(Boolean).join(' · ') || 'Không có mức phạt theo luật',
  );
</script>

<article
  class="pointer-events-auto w-80 max-w-full shrink-0 rounded-lg border border-stone-200 border-l-4 border-l-kepi-500 bg-white p-2 text-stone-900 shadow-lg"
  data-testid="breach-toast"
  data-episode={breach.episodeId}
  data-expanded={expanded}
  role="status"
>
  <header class="mb-1 flex items-start justify-between gap-2">
    <div>
      <p class="text-xs uppercase tracking-wide font-semibold text-kepi-600">
        {breach.kind === 'escalated' ? 'Vi phạm nặng hơn' : 'Vi phạm'}
      </p>
      <h3 class="text-sm font-semibold" data-testid="breach-title">{breach.title.vi}</h3>
    </div>
    <button
      type="button"
      class="rounded px-2 text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      aria-label="Đóng thông báo"
      onclick={ondismiss}>×</button
    >
  </header>
  {#if !expanded}
    <button
      type="button"
      class="hidden w-full truncate text-left text-xs font-medium text-kepi-600 [@media(max-height:480px)]:block"
      data-testid="breach-penalty-short"
      aria-expanded="false"
      onclick={() => (expanded = true)}>{penalty} ▸</button
    >
  {/if}
  <div class={expanded ? '' : '[@media(max-height:480px)]:hidden'} data-testid="breach-toast-details">
    <BreachDetails {breach} {scored} compact />
  </div>
</article>
