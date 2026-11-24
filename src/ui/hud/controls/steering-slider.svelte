<script>
  import KeyBadge from './key-badge.svelte';
  import { STEER_SLIDER_RANGE_PX, sliderSteer, steerPosition } from '../../lib/hud-view.js';

  /**
   * Floating one-axis steering slider. The first pointer down anchors it: the steering follows the
   * pointer's horizontal offset from that point, and lifting it hands the steering back to the
   * ramp, which centres it. The knob shows the steering the sim applied, from keys or the slider.
   * @type {{
   *   steer: number,
   *   showBadges: boolean,
   *   onsteer: (value: number | null) => void,
   * }}
   */
  let { steer, showBadges, onsteer } = $props();

  /** @type {number | null} */
  let pointerId = $state(null);
  let originX = 0;

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
  class="relative h-[72px] w-56 touch-none select-none rounded-full border-2 bg-white/85 shadow-md {pointerId !== null ? 'border-police-600' : 'border-white/70'}"
  role="slider"
  tabindex="-1"
  aria-label="Tay lái"
  aria-valuemin={-1}
  aria-valuemax={1}
  aria-valuenow={Number(steer.toFixed(2))}
  data-action="steerLeft steerRight"
  data-testid="hud-steer"
  data-value={steer.toFixed(2)}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  onlostpointercapture={end}
  oncontextmenu={(e) => e.preventDefault()}
>
  <svg viewBox="0 0 20 20" class="absolute left-3 top-1/2 h-6 w-6 -translate-y-1/2 text-stone-500" aria-hidden="true"><path d="M13 3 L5 10 L13 17" fill="none" stroke="currentColor" stroke-width="2.5" /></svg>
  <svg viewBox="0 0 20 20" class="absolute right-3 top-1/2 h-6 w-6 -translate-y-1/2 text-stone-500" aria-hidden="true"><path d="M7 3 L15 10 L7 17" fill="none" stroke="currentColor" stroke-width="2.5" /></svg>
  <div class="absolute inset-y-0 left-1/2 my-3 w-px bg-stone-300" aria-hidden="true"></div>
  <div class="absolute inset-x-10 inset-y-0" aria-hidden="true">
    <div class="absolute top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full bg-police-500 shadow" style:left="{steerPosition(steer) * 100}%"></div>
  </div>
  <KeyBadge action="steerLeft" shown={showBadges} class="-top-2 left-2" />
  <KeyBadge action="steerRight" shown={showBadges} class="-top-2 right-2" />
</div>
