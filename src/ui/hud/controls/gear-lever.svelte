<script>
  import ControlButton from './control-button.svelte';
  import KeyBadge from './key-badge.svelte';

  /**
   * The car's gear lever, a plus/minus lever: a dark slot with Số + at its top and Số − at its
   * bottom, two press controls of their own, and between them the knob, which shows the gear. Số +
   * on top steps up the ladder R, N, D (Đơn giản) or R, N, 1–5 (Thực tế).
   * @type {{
   *   up: import('../../lib/hud-view.js').ButtonView,
   *   down: import('../../lib/hud-view.js').ButtonView,
   *   gearText: string,
   *   showBadges: boolean,
   *   onpress: (action: import('../../../contracts/controls.js').ControlAction) => void,
   * }}
   */
  let { up, down, gearText, showBadges, onpress } = $props();
</script>

<div class="relative flex h-[136px] w-16 flex-col items-center rounded-xl bg-stone-800/80 shadow-md ring-2 ring-white/70" data-zone="gears">
  <span class="pointer-events-none absolute inset-y-4 left-1/2 w-2 -translate-x-1/2 rounded-full bg-stone-950" aria-hidden="true"></span>
  {#each [up, down] as button, i (button.action)}
    <ControlButton
      action={button.action}
      mode={button.mode}
      label={button.label}
      onpress={() => onpress(button.action)}
      class="h-14 w-16 rounded-xl border-2 border-white/70 bg-white/90 text-xs font-semibold text-stone-800"
    >
      <span>{button.text}</span>
      <KeyBadge action={button.action} shown={showBadges} class="-right-1 -top-1" />
    </ControlButton>
    {#if i === 0}
      <span
        class="pointer-events-none relative flex h-6 w-6 items-center justify-center rounded-full border-2 border-stone-950 bg-police-500 text-xs font-bold leading-none text-stone-900"
        data-testid="hud-gear-lever"
        data-value={gearText}>{gearText}</span
      >
    {/if}
  {/each}
</div>
