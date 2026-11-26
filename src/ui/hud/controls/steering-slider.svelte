<script>
  import KeyBadge from './key-badge.svelte';
  import { STEER_SLIDER_RANGE_PX, sliderSteer, steeringTurnDeg } from '../../lib/hud-view.js';

  /**
   * Floating one-axis steering control, drawn as a round wheel (car) or a handlebar (motorbike).
   * The first pointer down anchors it: the steering follows the pointer's horizontal offset from
   * that point, and lifting it hands the steering back to the ramp, which centres it. The drawing
   * turns with the steering the sim applied, from keys or this control. Its background is mostly
   * see-through, since at the bottom centre it sits over the player's own vehicle in the chase view.
   * @type {{
   *   steer: number,
   *   shape: 'wheel' | 'handlebar',
   *   showBadges: boolean,
   *   onsteer: (value: number | null) => void,
   * }}
   */
  let { steer, shape, showBadges, onsteer } = $props();

  /** @type {number | null} */
  let pointerId = $state(null);
  let originX = 0;

  const turn = $derived(steeringTurnDeg(steer, shape));

  /** @param {PointerEvent} e Event. */
  function down(e) {
    e.preventDefault();
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try {
      /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; its up or cancel still ends the drag.
    }
    pointerId = e.pointerId;
    originX = e.clientX;
    onsteer(0);
  }

  /** @param {PointerEvent} e Event. */
  function move(e) {
    if (e.pointerId !== pointerId) return;
    onsteer(sliderSteer(e.clientX - originX, STEER_SLIDER_RANGE_PX));
  }

  /** @param {PointerEvent} e Event. */
  function end(e) {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    onsteer(null);
  }

  $effect(() => () => {
    if (pointerId !== null) onsteer(null);
  });
</script>

<div
  class="relative touch-none select-none border-2 bg-white/35 shadow-md {shape === 'wheel' ? 'h-28 w-28 rounded-full' : 'h-[72px] w-[168px] rounded-full'} {pointerId !== null
    ? 'border-police-600'
    : 'border-white/70'}"
  role="slider"
  tabindex="-1"
  aria-label={shape === 'wheel' ? 'Vô lăng' : 'Tay lái'}
  aria-valuemin={-1}
  aria-valuemax={1}
  aria-valuenow={Number(steer.toFixed(2))}
  data-action="steerLeft steerRight"
  data-testid="hud-steer"
  data-shape={shape}
  data-value={steer.toFixed(2)}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  onlostpointercapture={end}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#if shape === 'wheel'}
    <svg viewBox="0 0 100 100" class="absolute inset-1 text-stone-800" style:transform="rotate({turn}deg)" aria-hidden="true">
      <circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" stroke-width="10" />
      <path d="M9 50 H34 M66 50 H91 M50 66 V91" stroke="currentColor" stroke-width="8" stroke-linecap="round" />
      <circle cx="50" cy="50" r="16" class="fill-police-500" stroke="currentColor" stroke-width="5" />
      <rect x="46" y="5" width="8" height="10" rx="2" class="fill-police-500" />
    </svg>
  {:else}
    <svg viewBox="0 0 168 72" class="absolute inset-0 text-stone-800" style:transform="rotate({turn}deg)" aria-hidden="true">
      <path d="M20 40 Q50 30 84 34 Q118 30 148 40" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" />
      <rect x="10" y="33" width="26" height="14" rx="6" class="fill-stone-700" />
      <rect x="132" y="33" width="26" height="14" rx="6" class="fill-stone-700" />
      <rect x="72" y="26" width="24" height="16" rx="5" class="fill-police-500" stroke="currentColor" stroke-width="3" />
    </svg>
  {/if}
  <KeyBadge action="steerLeft" shown={showBadges} class="-top-2 left-1" />
  <KeyBadge action="steerRight" shown={showBadges} class="-top-2 right-1" />
</div>
