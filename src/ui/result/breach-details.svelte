<script>
  import BadgeList from './badge-list.svelte';
  import {
    formatCitation,
    formatDeduction,
    formatFineBand,
    formatLicencePoints,
    formatSuspension,
  } from '../lib/format.js';

  /**
   * `scored` is false in a free run, which has no score: the game-score deduction line goes.
   * @type {{breach: import('../../contracts/score.js').Breach, compact?: boolean, scored?: boolean}}
   */
  let { breach, compact = false, scored = true } = $props();

  const clause = $derived(breach.clause);
  const fine = $derived(clause ? formatFineBand(clause.fineVnd) : null);
  const suspension = $derived(clause ? formatSuspension(clause.suspensionMonths) : null);
  const citation = $derived(clause ? formatCitation(clause.citation, breach.source?.number ?? null) : null);
  const citationUrl = $derived(breach.source?.url ?? clause?.citation.url ?? null);

  /**
   * Official number of an amending source, or null when the breach does not name it.
   * @param {string} sourceId Source id of the amendment.
   * @returns {string | null} Number, e.g. `238/2026/NĐ-CP`.
   */
  function amendmentNumber(sourceId) {
    return (breach.amendmentSources ?? []).find((s) => s.sourceId === sourceId)?.number ?? null;
  }
</script>

<div class={compact ? 'space-y-0.5 text-xs' : 'space-y-1 text-sm'}>
  {#if scored}
    <p class="font-medium text-kepi-600" data-testid="breach-deduction">{formatDeduction(breach.deduction)}</p>
  {/if}
  {#if breach.scoreOnly || !clause}
    {#if !(compact && breach.note)}
      <p class="text-stone-700" data-testid="breach-score-only">
        {scored ? 'Chỉ trừ điểm trò chơi, không có mức phạt theo luật.' : 'Không có mức phạt theo luật.'}
      </p>
    {/if}
  {:else}
    {#if fine}
      <p data-testid="breach-fine">Phạt tiền: <span class="font-semibold">{fine}</span></p>
      {#if breach.fineAbsorbedBy}
        <p class="text-xs text-police-700" data-testid="breach-fine-absorbed">Đã tính trong mức phạt gây tai nạn</p>
      {/if}
    {/if}
    <p data-testid="breach-points">{formatLicencePoints(clause.licencePoints)}</p>
    {#if suspension}
      <p data-testid="breach-suspension">{suspension}</p>
    {/if}
    <p data-testid="breach-citation">
      {#if citationUrl}
        <a class="text-police-700 underline hover:text-police-900" href={citationUrl} target="_blank" rel="noopener noreferrer">{citation}</a>
      {:else}
        {citation}
      {/if}
    </p>
    <details class="text-stone-700">
      <summary class="cursor-pointer text-xs text-stone-600">Trích dẫn văn bản</summary>
      <blockquote class="mt-1 border-l-2 border-police-300 pl-2 italic">“{clause.citation.quote}”</blockquote>
      <a class="text-xs text-police-700 underline hover:text-police-900" href={clause.citation.url} target="_blank" rel="noopener noreferrer">
        Nơi trích dẫn
      </a>
      {#each clause.amendments ?? [] as amendment, i (i)}
        <div class="mt-2" data-testid="breach-amendment">
          <p class="text-xs text-stone-600">Sửa đổi, bổ sung ({formatCitation(amendment, amendmentNumber(amendment.sourceId))}):</p>
          <blockquote class="border-l-2 border-police-300 pl-2 italic">“{amendment.quote}”</blockquote>
          <a class="text-xs text-police-700 underline hover:text-police-900" href={amendment.url} target="_blank" rel="noopener noreferrer">
            Xem văn bản sửa đổi
          </a>
        </div>
      {/each}
    </details>
  {/if}
  {#if breach.note && (!compact || breach.scoreOnly || !clause)}
    <p class="text-stone-700" data-testid="breach-note">{breach.note.vi}</p>
  {/if}
  <BadgeList {breach} />
</div>
