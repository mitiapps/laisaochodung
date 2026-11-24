<script>
  import ControlButton from './control-button.svelte';
  import KeyBadge from './key-badge.svelte';

  /**
   * A pedal or the lever beside the pedals: a hold control whose fill shows the applied value.
   * @type {{
   *   control: import('../../lib/hud-view.js').PedalControl,
   *   showBadges: boolean,
   *   onhold: (on: boolean) => void,
   * }}
   */
  let { control, showBadges, onhold } = $props();

  const isLever = $derived(control.shape === 'lever');
  const isThrottle = $derived(control.action === 'throttle');
</script>

<ControlButton
  action={control.action}
  mode="hold"
  label={control.label}
  {onhold}
  testid={control.testId}
  dataOn={control.on}
  dataValue={control.fraction.toFixed(2)}
  class="border-2 font-semibold text-stone-900 shadow-md {isLever
    ? 'h-14 w-14 rounded-full text-[11px] leading-tight'
    : isThrottle
      ? 'h-36 w-[72px] rounded-2xl text-sm'
      : 'h-32 w-16 rounded-2xl text-sm'} {control.on ? 'border-stone-900 bg-white' : 'border-white/70 bg-white/85'}"
>
  <span class="absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden="true">
    <span class="absolute inset-x-0 bottom-0 {isThrottle ? 'bg-emerald-600/70' : 'bg-kepi-500/70'}" style:height="{control.fraction * 100}%"></span>
  </span>
  <span class="relative px-1 text-center">{control.label}</span>
  <KeyBadge action={control.action} shown={showBadges} class={isLever ? '-top-5 left-1/2 -translate-x-1/2' : 'right-1 top-1'} />
</ControlButton>
