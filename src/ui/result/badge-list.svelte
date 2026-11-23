<script>
  import { badgesFor } from '../lib/badges.js';

  /** @type {{breach: import('../../contracts/score.js').Breach}} */
  let { breach } = $props();
  const badges = $derived(badgesFor(breach));
</script>

{#if badges.length > 0}
  <ul class="flex flex-wrap gap-1">
    {#each badges as badge (badge.id)}
      <li
        class="rounded-full border border-police-300 bg-police-50 px-2 py-0.5 text-xs text-police-800"
        title={badge.hint}
        data-testid="badge-{badge.id}"
      >
        {badge.label}
      </li>
    {/each}
  </ul>
{/if}
