<script>
  import { badgeFor } from '../../lib/key-label.js';

  /**
   * Keyboard key of an action, drawn on its on-screen control. Hidden (not removed) while the last
   * input was touch.
   * @type {{
   *   action: import('../../../contracts/controls.js').ControlAction,
   *   shown: boolean,
   *   class?: string,
   * }}
   */
  let { action, shown, class: extra = '' } = $props();
</script>

<span
  class="pointer-events-none absolute rounded border border-stone-400 bg-white px-1 font-mono text-[10px] font-semibold leading-4 text-stone-800 shadow-sm {shown
    ? ''
    : 'hidden'} {extra}"
  data-badge={action}
  aria-hidden="true">{badgeFor(action)}</span
>
