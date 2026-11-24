<script>
  /**
   * One on-screen control. A `hold` control holds its action from the first pointer down until the
   * last pointer lifts or is cancelled; a `press` control fires once on a pointer up inside it. Each
   * pointer is captured, and pointer-down is prevented so the control never takes focus.
   *
   * Every pointer down on a hold control forwards `onhold(true)`, whatever the control remembers:
   * the session sends holds to the current run's input, which is new after a restart, so a finger
   * still down from the last run must not swallow the next touch.
   * @type {{
   *   action: import('../../../contracts/controls.js').ControlAction,
   *   mode: 'hold' | 'press',
   *   label: string,
   *   onhold?: (on: boolean) => void,
   *   onpress?: () => void,
   *   class?: string,
   *   testid?: string | null,
   *   dataOn?: boolean | null,
   *   dataValue?: string | null,
   *   children: import('svelte').Snippet,
   * }}
   */
  let { action, mode, label, onhold, onpress, class: extra = '', testid = null, dataOn = null, dataValue = null, children } = $props();

  /** @type {number[]} Ids of the pointers down on this control. */
  let pointers = [];
  let pressed = $state(false);

  /** @param {boolean} on Held. */
  function setHeld(on) {
    pressed = on;
    if (mode === 'hold') onhold?.(on);
  }

  /** @param {PointerEvent} e Event. */
  function down(e) {
    e.preventDefault();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = /** @type {HTMLElement} */ (e.currentTarget);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; the control still sees its up or cancel.
    }
    if (!pointers.includes(e.pointerId)) pointers = [...pointers, e.pointerId];
    setHeld(true);
  }

  /**
   * @param {PointerEvent} e Event.
   * @param {boolean} cancelled The pointer was cancelled, not lifted.
   */
  function up(e, cancelled) {
    if (!pointers.includes(e.pointerId)) return;
    pointers = pointers.filter((id) => id !== e.pointerId);
    if (mode === 'press' && !cancelled) {
      const box = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      if (inside) onpress?.();
    }
    if (pointers.length === 0 && pressed) setHeld(false);
  }

  $effect(() => () => {
    pointers = [];
    if (pressed && mode === 'hold') onhold?.(false);
  });
</script>

<button
  type="button"
  tabindex="-1"
  class="relative flex touch-none select-none items-center justify-center {pressed ? 'brightness-90' : ''} {extra}"
  data-action={action}
  data-testid={testid}
  data-on={dataOn}
  data-value={dataValue}
  aria-label={label}
  onpointerdown={down}
  onpointerup={(e) => up(e, false)}
  onpointercancel={(e) => up(e, true)}
  onlostpointercapture={(e) => up(e, true)}
  oncontextmenu={(e) => e.preventDefault()}
>
  {@render children()}
</button>
