<script>
  /** @type {{limitKmh: number | null}} */
  let { limitKmh } = $props();
</script>

{#if limitKmh !== null}
  <div
    class="flex h-16 w-16 items-center justify-center rounded-full border-[6px] border-red-600 bg-white text-2xl font-bold text-black"
    title="Tốc độ tối đa cho phép"
    data-testid="hud-limit"
  >
    {limitKmh}
  </div>
{/if}
