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
  <header class="mb-1 flex [@media(max-height:480px)]:mb-0 items-start justify-between gap-2">
    <p class="text-xs font-semibold uppercase tracking-wide text-stone-600">Va chạm</p>
    <span class="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-semibold text-stone-700" data-testid="notice-badge">Không trừ điểm</span>
  </header>
  <!-- One clamped line on a short landscape view; the full text stays in the title and the result. -->
  <p class="text-sm [@media(max-height:480px)]:truncate" data-testid="notice-text" title={notice.text.vi}>{notice.text.vi}</p>
</article>
