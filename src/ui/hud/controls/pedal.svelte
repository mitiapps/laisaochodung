<script>
  import ControlButton from './control-button.svelte';
  import KeyBadge from './key-badge.svelte';

  /**
   * A hold control that shows how far it is applied: a car's tall pedal, the car's handbrake lever,
   * a motorbike's hand lever or its throttle grip. A pedal fills from the bottom; a hand lever pulls
   * towards the handlebar and fills; the grip's ribs roll and it fills from the handlebar side; the
   * handbrake's handle tilts up and turns red while applied. The motorbike's Đơn giản brake also
   * shows the rear brake it applies, as a narrow second fill.
   * @type {{
   *   control: import('../../lib/hud-view.js').PedalControl,
   *   showBadges: boolean,
   *   onhold: (on: boolean) => void,
   * }}
   */
  let { control, showBadges, onhold } = $props();

  const isThrottle = $derived(control.action === 'throttle');
  /** The rear brake is the left hand lever, so its handlebar end is on its right; the front lever's on its left. */
  const pivotRight = $derived(control.action === 'brakeRear');

  /** Size and corners of each shape. */
  const SIZE = /** @type {const} */ ({
    handbrake: 'h-[72px] w-14 rounded-xl text-[10px] leading-tight',
    lever: 'h-14 w-[72px] rounded-xl text-[11px] leading-tight',
    grip: 'h-14 w-[72px] rounded-xl text-xs',
  });
  const size = $derived(control.shape === 'pedal' ? (isThrottle ? 'h-36 w-[72px] rounded-2xl text-sm' : 'h-32 w-16 rounded-2xl text-sm') : SIZE[control.shape]);
</script>

<ControlButton
  action={control.action}
  mode="hold"
  label={control.label}
  {onhold}
  testid={control.testId}
  dataOn={control.on}
  dataValue={control.fraction.toFixed(2)}
  class="border-2 font-semibold text-stone-900 shadow-md {size} {control.shape === 'pedal' ? '' : 'flex-col justify-end pb-1'} {control.on
    ? 'border-stone-900 bg-white'
    : 'border-white/70 bg-white/85'}"
>
  {#if control.shape === 'pedal'}
    <span class="absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden="true">
      <span class="absolute inset-x-0 bottom-0 {isThrottle ? 'bg-emerald-600/70' : 'bg-kepi-500/70'}" style:height="{control.fraction * 100}%"></span>
    </span>
  {:else if control.shape === 'lever'}
    <!-- A brake lever: the pivot block at the handlebar end, the blade reaching across the grip,
         pulled towards the grip as it is applied. -->
    <span class="absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden="true">
      <span class="absolute inset-x-0 bottom-0 bg-kepi-500/40" style:height="{control.fraction * 100}%"></span>
    </span>
    <svg viewBox="0 0 72 28" class="absolute inset-x-1 top-1 h-7 text-stone-800" style:transform={pivotRight ? 'scaleX(-1)' : ''} aria-hidden="true">
      <rect x="2" y="15" width="64" height="9" rx="4.5" class="fill-stone-400" />
      <g style:transform="rotate({control.fraction * 9}deg)" style:transform-origin="8px 8px">
        <path d="M8 8 Q36 4 66 10" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
      </g>
      <rect x="2" y="3" width="12" height="11" rx="3" class="fill-stone-700" />
    </svg>
  {:else if control.shape === 'grip'}
    <!-- A ribbed twist grip at the end of the handlebar: the ribs roll and the grip fills from the
         handlebar side as it opens. -->
    <svg viewBox="0 0 72 28" class="absolute inset-x-1 top-1 h-7" aria-hidden="true">
      <defs>
        <clipPath id="throttle-grip-clip"><rect x="6" y="3" width="60" height="22" rx="8" /></clipPath>
      </defs>
      <rect x="0" y="9" width="8" height="10" rx="2" class="fill-stone-500" />
      <rect x="6" y="3" width="60" height="22" rx="8" class="fill-stone-800" />
      <g clip-path="url(#throttle-grip-clip)">
        <rect x="6" y="3" height="22" class="fill-emerald-600" width={60 * control.fraction} />
        <g class="stroke-stone-400" stroke-width="1.5" style:transform="translateY({(control.fraction * 8).toFixed(2)}px)">
          {#each [-5, -1, 3, 7, 11, 15, 19, 23, 27] as y (y)}
            <line x1="10" x2="62" y1={y} y2={y} />
          {/each}
        </g>
      </g>
    </svg>
  {:else}
    <!-- The handbrake: a lever pivoting at its foot whose handle tilts up and turns red while applied. -->
    <svg viewBox="0 0 56 44" class="absolute inset-x-1 top-1 h-11" aria-hidden="true">
      <rect x="4" y="34" width="20" height="8" rx="3" class="fill-stone-500" />
      <g style:transform="rotate({-control.fraction * 28}deg)" style:transform-origin="12px 36px">
        <path d="M12 36 L46 30" class="stroke-stone-700" stroke-width="6" stroke-linecap="round" />
        <rect x="32" y="24" width="18" height="11" rx="4" class={control.on ? 'fill-kepi-500' : 'fill-stone-800'} />
      </g>
    </svg>
  {/if}
  {#if control.rear}
    <span
      class="absolute bottom-2 left-1 top-2 w-1.5 overflow-hidden rounded-full bg-stone-300"
      aria-hidden="true"
      data-testid={control.rear.testId}
      data-value={control.rear.fraction.toFixed(2)}
    >
      <span class="absolute inset-x-0 bottom-0 bg-kepi-600" style:height="{control.rear.fraction * 100}%"></span>
    </span>
  {/if}
  <span class="relative px-1 text-center">{control.label}</span>
  <KeyBadge action={control.action} shown={showBadges} class={control.shape === 'pedal' ? 'right-1 top-1' : '-right-1 -top-1'} />
</ControlButton>
