<script>
  import BreachDetails from './breach-details.svelte';
  import { formatClock, formatFineBand, formatScore } from '../lib/format.js';
  import { LICENCE_NOTE, endReasonLabel, licenceLabel } from '../lib/result.js';

  /**
   * @type {{
   *   report: import('../../contracts/score.js').ScoreReport,
   *   onretry: () => void,
   *   onchangemap: () => void,
   * }}
   */
  let { report, onretry, onchangemap } = $props();
  const total = $derived(formatFineBand(report.fineTotalVnd) ?? '0 ₫');
</script>

<section
  class="mx-auto flex max-h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-xl bg-slate-900/95 p-6 shadow-2xl"
  data-testid="result-screen"
>
  <header class="flex items-baseline justify-between gap-4">
    <div>
      <h2 class="text-2xl font-bold">Kết quả</h2>
      <p class="text-slate-300" data-testid="result-ended-by">{endReasonLabel(report.endedBy)}</p>
    </div>
    <p class="text-4xl font-bold" data-testid="result-score">{formatScore(report.score)}</p>
  </header>

  <dl class="grid grid-cols-2 gap-3 rounded-lg bg-slate-800 p-4 text-sm">
    <div>
      <dt class="text-slate-400">Tổng tiền phạt <span class="text-amber-300">(ước tính)</span></dt>
      <dd class="text-lg font-semibold" data-testid="result-fine-total">{total}</dd>
    </div>
    <div>
      <dt class="text-slate-400">Điểm giấy phép lái xe</dt>
      <dd class="text-lg font-semibold" data-testid="result-licence">{licenceLabel(report.licence)}</dd>
    </div>
    <p class="col-span-2 text-xs text-slate-400">
      Tổng tiền phạt cộng khung phạt của từng lỗi, chỉ để tham khảo. {LICENCE_NOTE}
    </p>
  </dl>

  <div>
    <h3 class="mb-2 font-semibold">Các lỗi vi phạm ({report.breaches.length})</h3>
    {#if report.breaches.length === 0}
      <p class="text-emerald-300" data-testid="result-clean">Không có lỗi nào. Lái rất tốt!</p>
    {:else}
      <ol class="space-y-3" data-testid="result-breaches">
        {#each report.breaches as breach (breach.episodeId)}
          <li class="rounded-lg border border-slate-700 p-3" data-testid="result-breach">
            <p class="mb-1 flex justify-between gap-2">
              <span class="font-semibold">{breach.title.vi}</span>
              <span class="text-xs tabular-nums text-slate-400">{formatClock(breach.t)}</span>
            </p>
            <BreachDetails {breach} />
          </li>
        {/each}
      </ol>
    {/if}
  </div>

  <footer class="flex justify-end gap-3">
    <button type="button" class="rounded-lg bg-slate-700 px-4 py-2 hover:bg-slate-600" data-testid="result-change-map" onclick={onchangemap}>
      Đổi bản đồ
    </button>
    <button type="button" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500" data-testid="result-retry" onclick={onretry}>
      Chơi lại
    </button>
  </footer>
</section>
