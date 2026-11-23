<script>
  import BreachToast from './breach-toast.svelte';
  import NavArrow from './nav-arrow.svelte';
  import SpeedLimitSign from './speed-limit-sign.svelte';
  import { formatGear, formatScore, formatSpeed } from '../lib/format.js';
  import { indicatorLamps, pedalBars, rpmFraction, steerPosition } from '../lib/hud-view.js';

  /**
   * @type {{
   *   state: import('../../contracts/hud.js').HudState,
   *   vehicle: import('../../contracts/vehicle.js').VehicleInfo,
   *   toasts: import('../lib/toast-stack.js').Toast[],
   *   onpause: () => void,
   *   ondismiss: (episodeId: string) => void,
   * }}
   */
  let { state, vehicle, toasts, onpause, ondismiss } = $props();

  const lamps = $derived(indicatorLamps(state.indicators));
  const isCar = $derived(vehicle.legalClass === 'car');
  const paused = $derived(state.runStatus === 'paused');
  const pedals = $derived(pedalBars(state.controls, isCar));
</script>

<div class="pointer-events-none absolute inset-0 flex flex-col justify-between p-4 text-slate-100" data-testid="hud">
  <div class="flex items-start justify-between gap-4">
    <div class="rounded-lg bg-slate-900/70 px-3 py-2">
      <p class="text-xs text-slate-400">Điểm</p>
      <p class="text-2xl font-bold" data-testid="hud-score">{formatScore(state.score)}</p>
    </div>
    <div class="rounded-lg bg-slate-900/70 px-3 py-2">
      <NavArrow nav={state.nav} headingRad={state.headingRad} />
    </div>
    <button
      type="button"
      class="pointer-events-auto rounded-lg bg-slate-900/80 px-4 py-2 font-semibold hover:bg-slate-700"
      data-testid="hud-pause"
      onclick={onpause}
    >
      {paused ? 'Tiếp tục' : 'Tạm dừng'}
    </button>
  </div>

  <div class="flex items-end justify-between gap-4">
    <div class="flex items-end gap-3 rounded-lg bg-slate-900/70 p-3">
      <SpeedLimitSign limitKmh={state.speedLimitKmh} verified={state.speedLimitVerified} />
      <div>
        <p class="text-5xl font-bold tabular-nums leading-none" data-testid="hud-speed">{formatSpeed(state.speedKmh)}</p>
        <p class="text-xs text-slate-400">km/h</p>
      </div>
      <div class="ml-2 text-center">
        <p class="text-xs text-slate-400">Số</p>
        <p class="text-3xl font-bold" data-testid="hud-gear">{formatGear(state.gear)}</p>
      </div>
      {#if isCar}
        <div class="ml-2 w-32" data-testid="hud-rpm">
          <p class="text-xs text-slate-400">Vòng tua</p>
          <div class="h-2 overflow-hidden rounded bg-slate-700">
            <div class="h-full bg-sky-400" style="width: {rpmFraction(state.rpm) * 100}%"></div>
          </div>
          <p class="text-xs tabular-nums text-slate-300">{Math.round(state.rpm)} v/ph</p>
        </div>
      {/if}
      <div class="ml-2 flex items-end gap-2" data-testid="hud-controls">
        {#each pedals as bar (bar.id)}
          <div class="flex flex-col items-center" data-testid="hud-{bar.id}" data-value={bar.fraction.toFixed(2)}>
            <div class="flex h-12 w-3 flex-col justify-end overflow-hidden rounded bg-slate-700" aria-hidden="true">
              <div class={bar.id === 'throttle' ? 'bg-emerald-400' : 'bg-red-400'} style="height: {bar.fraction * 100}%"></div>
            </div>
            <p class="mt-1 text-[10px] text-slate-400">{bar.label}</p>
          </div>
        {/each}
        <div class="flex flex-col items-center" data-testid="hud-steer" data-value={state.controls.steer.toFixed(2)}>
          <div class="relative h-3 w-20 rounded bg-slate-700" aria-hidden="true">
            <div class="absolute inset-y-0 left-1/2 w-px bg-slate-500"></div>
            <div class="absolute inset-y-0 w-1.5 -translate-x-1/2 rounded bg-sky-400" style="left: {steerPosition(state.controls.steer) * 100}%"></div>
          </div>
          <p class="mt-1 text-[10px] text-slate-400">Tay lái</p>
        </div>
        {#if isCar}
          <p
            class={state.controls.handbrake ? 'text-xs font-semibold text-red-400' : 'text-xs text-slate-600'}
            data-testid="hud-handbrake"
            data-on={state.controls.handbrake}
          >
            Phanh tay
          </p>
        {/if}
      </div>
    </div>

    <ul class="flex items-center gap-3 rounded-lg bg-slate-900/70 px-3 py-2 text-sm">
      <li
        class={lamps.left ? 'animate-blink text-emerald-400' : 'text-slate-600'}
        data-testid="hud-indicator-left"
        data-on={lamps.left}
        aria-label="Xi nhan trái"
      >
        <svg viewBox="0 0 20 20" class="h-6 w-6" aria-hidden="true"><path d="M2 10 L12 2 V7 H18 V13 H12 V18 Z" fill="currentColor" /></svg>
      </li>
      <li
        class={lamps.hazard ? 'animate-blink text-red-500' : 'text-slate-600'}
        data-testid="hud-hazard"
        data-on={lamps.hazard}
        aria-label="Đèn cảnh báo nguy hiểm"
      >
        <svg viewBox="0 0 20 20" class="h-6 w-6" aria-hidden="true"><path d="M10 2 L19 18 H1 Z M10 7 L5 15.5 H15 Z" fill="currentColor" fill-rule="evenodd" /></svg>
      </li>
      <li
        class={lamps.right ? 'animate-blink text-emerald-400' : 'text-slate-600'}
        data-testid="hud-indicator-right"
        data-on={lamps.right}
        aria-label="Xi nhan phải"
      >
        <svg viewBox="0 0 20 20" class="h-6 w-6" aria-hidden="true"><path d="M18 10 L8 2 V7 H2 V13 H8 V18 Z" fill="currentColor" /></svg>
      </li>
      <li class={state.lights === 'low' ? 'text-emerald-400' : 'text-slate-600'} data-testid="hud-low-beam" data-on={state.lights === 'low'}>
        Đèn cốt
      </li>
      <li class={state.lights === 'high' ? 'text-sky-400' : 'text-slate-600'} data-testid="hud-high-beam" data-on={state.lights === 'high'}>
        Đèn pha
      </li>
      <li class={state.horn ? 'text-amber-300' : 'text-slate-600'} data-testid="hud-horn" data-on={state.horn}>Còi</li>
      <li class={state.skid ? 'font-semibold text-orange-400' : 'text-slate-600'} data-testid="hud-skid" data-on={state.skid}>
        Trượt bánh
      </li>
    </ul>
  </div>

  {#if toasts.length > 0}
    <div class="absolute bottom-28 right-4 top-20 flex flex-col gap-2 overflow-hidden" data-testid="toast-stack">
      {#each toasts as toast (toast.episodeId)}
        <BreachToast breach={toast.breach} ondismiss={() => ondismiss(toast.episodeId)} />
      {/each}
    </div>
  {/if}
</div>
