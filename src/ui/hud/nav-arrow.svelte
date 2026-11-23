<script>
  import { arrowRotationDeg } from '../lib/nav.js';
  import { formatDistance } from '../lib/format.js';

  /** @type {{nav: {distanceM: number, bearingRad: number}, headingRad?: number | null}} */
  let { nav, headingRad = null } = $props();
  const rotation = $derived(arrowRotationDeg(nav.bearingRad, headingRad));
</script>

<div class="flex flex-col items-center gap-1" data-testid="hud-nav">
  <svg
    viewBox="0 0 40 40"
    class="h-12 w-12 text-police-700 drop-shadow"
    style="transform: rotate({rotation}deg)"
    aria-label="Hướng tới điểm kiểm tra tiếp theo"
    role="img"
  >
    <path d="M20 3 L34 30 L20 23 L6 30 Z" fill="currentColor" />
  </svg>
  <span class="text-sm font-semibold" data-testid="hud-nav-distance">{formatDistance(nav.distanceM)}</span>
</div>
