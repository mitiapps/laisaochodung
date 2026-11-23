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
  class="pointer-events-auto w-80 max-w-full shrink-0 rounded-lg border border-stone-200 border-l-4 border-l-kepi-500 bg-white p-2 text-stone-900 shadow-lg"
  data-testid="breach-toast"
  data-episode={breach.episodeId}
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
  <BreachDetails {breach} compact />
</article>
