<script>
  import ControlButton from './control-button.svelte';
  import KeyBadge from './key-badge.svelte';

  /**
   * A round button of the arc above the pedals. The indicator and hazard buttons draw their lamp
   * and blink while on; the lights button holds the low- and high-beam pips.
   * @type {{
   *   button: import('../../lib/hud-view.js').ArcButton,
   *   lights: import('../../../contracts/telemetry.js').Lights,
   *   showBadges: boolean,
   *   onhold: (on: boolean) => void,
   *   onpress: () => void,
   * }}
   */
  let { button, lights, showBadges, onhold, onpress } = $props();

  const lit = $derived(button.on ? (button.action === 'hazard' ? 'text-kepi-500' : 'text-police-700') : 'text-stone-500');
</script>

<ControlButton
  action={button.action}
  mode={button.mode}
  label={button.label}
  {onhold}
  {onpress}
  testid={button.testId}
  dataOn={button.testId ? button.on : null}
  class="h-14 w-14 rounded-full border-2 text-xs font-semibold shadow-md {button.on && !button.blink
    ? 'border-stone-900 bg-police-500 text-stone-900'
    : 'border-white/70 bg-white/85 text-stone-800'}"
>
  {#if button.action === 'signalLeft'}
    <svg viewBox="0 0 20 20" class="h-7 w-7 {lit} {button.on ? 'animate-blink' : ''}" aria-hidden="true"><path d="M2 10 L12 2 V7 H18 V13 H12 V18 Z" fill="currentColor" /></svg>
  {:else if button.action === 'signalRight'}
    <svg viewBox="0 0 20 20" class="h-7 w-7 {lit} {button.on ? 'animate-blink' : ''}" aria-hidden="true"><path d="M18 10 L8 2 V7 H2 V13 H8 V18 Z" fill="currentColor" /></svg>
  {:else if button.action === 'hazard'}
    <svg viewBox="0 0 20 20" class="h-7 w-7 {lit} {button.on ? 'animate-blink' : ''}" aria-hidden="true"
      ><path d="M10 2 L19 18 H1 Z M10 7 L5 15.5 H15 Z" fill="currentColor" fill-rule="evenodd" /></svg
    >
  {:else if button.action === 'lightsCycle'}
    <span class="flex flex-col items-center gap-0.5">
      <span>{button.text}</span>
      <span class="flex gap-0.5 text-[9px] leading-3">
        <span class="rounded px-0.5 {lights === 'low' ? 'bg-police-500 text-stone-900' : 'text-stone-500'}" data-testid="hud-low-beam" data-on={lights === 'low'}>cốt</span>
        <span class="rounded px-0.5 {lights === 'high' ? 'bg-police-500 text-stone-900' : 'text-stone-500'}" data-testid="hud-high-beam" data-on={lights === 'high'}>pha</span>
      </span>
    </span>
  {:else}
    <span>{button.text}</span>
  {/if}
  <KeyBadge action={button.action} shown={showBadges} class="-right-1 -top-1" />
</ControlButton>
