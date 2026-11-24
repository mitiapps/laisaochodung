<script>
  /**
   * @type {{
   *   notice: import('../../contracts/score.js').Notice,
   * }}
   */
  let { notice } = $props();
</script>

<article
  class="w-80 max-w-full shrink-0 rounded-lg border border-stone-200 border-l-4 border-l-stone-400 bg-white p-2 text-stone-900 shadow-lg"
  data-testid="notice-toast"
  data-tick={notice.tick}
  role="status"
>
  <header class="mb-1 flex items-start justify-between gap-2">
    <p class="text-xs font-semibold uppercase tracking-wide text-stone-600">Va chạm</p>
    <span class="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-semibold text-stone-700" data-testid="notice-badge">Không trừ điểm</span>
  </header>
  <p class="text-sm" data-testid="notice-text">{notice.text.vi}</p>
</article>
