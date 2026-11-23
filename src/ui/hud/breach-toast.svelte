<script>
  import BreachDetails from '../result/breach-details.svelte';

  /**
   * @type {{
   *   breach: import('../../contracts/score.js').Breach,
   *   ondismiss: () => void,
   * }}
   */
  let { breach, ondismiss } = $props();
</script>

<article
  class="pointer-events-auto w-80 max-w-full shrink-0 rounded-lg border border-rose-500/60 bg-slate-900/95 p-2 shadow-lg"
  data-testid="breach-toast"
  data-episode={breach.episodeId}
  role="status"
>
  <header class="mb-1 flex items-start justify-between gap-2">
    <div>
      <p class="text-xs uppercase tracking-wide text-rose-400">
        {breach.kind === 'escalated' ? 'Vi phạm nặng hơn' : 'Vi phạm'}
      </p>
      <h3 class="text-sm font-semibold" data-testid="breach-title">{breach.title.vi}</h3>
    </div>
    <button
      type="button"
      class="rounded px-2 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
      aria-label="Đóng thông báo"
      onclick={ondismiss}>×</button
    >
  </header>
  <BreachDetails {breach} compact />
</article>
