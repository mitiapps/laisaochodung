<script>
  /** @type {{limitKmh: number | null, verified?: boolean}} */
  let { limitKmh, verified = true } = $props();
</script>

{#if limitKmh !== null}
  <div class="flex flex-col items-center gap-0.5">
    <div
      class="flex h-16 w-16 items-center justify-center rounded-full border-[6px] border-red-600 bg-white text-2xl font-bold text-black"
      title="Tốc độ tối đa cho phép"
      data-testid="hud-limit"
    >
      {limitKmh}
    </div>
    {#if !verified}
      <span
        class="rounded bg-amber-500/20 px-1 text-[10px] text-amber-300"
        title="Tốc độ tối đa mặc định theo Thông tư 38 chưa được đối chiếu với văn bản chính thức."
        data-testid="hud-limit-unverified"
      >
        chưa kiểm chứng
      </span>
    {/if}
  </div>
{/if}
