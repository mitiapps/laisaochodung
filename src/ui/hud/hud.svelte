<script>
  import BreachToast from './breach-toast.svelte';
  import NavArrow from './nav-arrow.svelte';
  import NoticeToast from './notice-toast.svelte';
  import SpeedLimitSign from './speed-limit-sign.svelte';
  import { formatGear, formatScore, formatSpeed } from '../lib/format.js';
  import { indicatorLamps, noticeItems, pedalBars, rpmFraction, steerPosition } from '../lib/hud-view.js';

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
  const notices = $derived(noticeItems(state.notices));
</script>

<div class="pointer-events-none absolute inset-0 flex flex-col justify-between p-4 text-stone-900" data-testid="hud">
  <div class="flex items-start justify-between gap-4">
    <div class="rounded-lg border border-white/60 bg-white/90 shadow-md backdrop-blur px-3 py-2">
      <p class="text-xs text-stone-600">Điểm</p>
      <p class="text-2xl font-bold" data-testid="hud-score">{formatScore(state.score)}</p>
    </div>
    <div class="rounded-lg border border-white/60 bg-white/90 shadow-md backdrop-blur px-3 py-2">
      <NavArrow nav={state.nav} headingRad={state.headingRad} />
    </div>
    <button
      type="button"
      class="pointer-events-auto rounded-lg border border-police-600 bg-police-500 px-4 py-2 font-semibold text-stone-900 shadow-md hover:bg-police-400"
      data-testid="hud-pause"
      onclick={onpause}
    >
      {paused ? 'Tiếp tục' : 'Tạm dừng'}
    </button>
  </div>

  <div class="flex items-end justify-between gap-4">
    <div class="flex items-end gap-3 rounded-lg border border-white/60 bg-white/90 shadow-md backdrop-blur p-3">
      <SpeedLimitSign limitKmh={state.speedLimitKmh} verified={state.speedLimitVerified} />
      <div>
        <p class="text-5xl font-bold tabular-nums leading-none" data-testid="hud-speed">{formatSpeed(state.speedKmh)}</p>
        <p class="text-xs text-stone-600">km/h</p>
      </div>
      <div class="ml-2 text-center">
        <p class="text-xs text-stone-600">Số</p>
        <p class="text-3xl font-bold" data-testid="hud-gear">{formatGear(state.gear)}</p>
      </div>
      {#if isCar}
        <div class="ml-2 w-32" data-testid="hud-rpm">
          <p class="text-xs text-stone-600">Vòng tua</p>
          <div class="h-2 overflow-hidden rounded bg-stone-200">
            <div class="h-full bg-police-700" style="width: {rpmFraction(state.rpm) * 100}%"></div>
          </div>
          <p class="text-xs tabular-nums text-stone-700">{Math.round(state.rpm)} v/ph</p>
        </div>
      {/if}
      <div class="ml-2 flex items-end gap-2" data-testid="hud-controls">
        {#each pedals as bar (bar.id)}
          <div class="flex flex-col items-center" data-testid="hud-{bar.id}" data-value={bar.fraction.toFixed(2)}>
            <div class="flex h-12 w-3 flex-col justify-end overflow-hidden rounded bg-stone-200" aria-hidden="true">
              <div class={bar.id === 'throttle' ? 'bg-emerald-700' : 'bg-kepi-500'} style="height: {bar.fraction * 100}%"></div>
            </div>
            <p class="mt-1 text-[10px] text-stone-600">{bar.label}</p>
          </div>
        {/each}
        <div class="flex flex-col items-center" data-testid="hud-steer" data-value={state.controls.steer.toFixed(2)}>
          <div class="relative h-3 w-20 rounded bg-stone-200" aria-hidden="true">
            <div class="absolute inset-y-0 left-1/2 w-px bg-stone-500"></div>
            <div class="absolute inset-y-0 w-1.5 -translate-x-1/2 rounded bg-police-700" style="left: {steerPosition(state.controls.steer) * 100}%"></div>
          </div>
          <p class="mt-1 text-[10px] text-stone-600">Tay lái</p>
        </div>
        {#if isCar}
          <p
            class={state.controls.handbrake ? 'rounded bg-kepi-500 px-1.5 py-0.5 text-xs font-semibold text-white' : 'rounded px-1.5 py-0.5 text-xs text-stone-600'}
            data-testid="hud-handbrake"
            data-on={state.controls.handbrake}
          >
            Phanh tay
          </p>
        {/if}
      </div>
    </div>

    <ul class="flex items-center gap-3 rounded-lg border border-white/60 bg-white/90 shadow-md backdrop-blur px-3 py-2 text-sm">
      <li
        class={lamps.left ? 'animate-blink text-police-700' : 'text-stone-400'}
        data-testid="hud-indicator-left"
        data-on={lamps.left}
        aria-label="Xi nhan trái"
      >
        <svg viewBox="0 0 20 20" class="h-6 w-6" aria-hidden="true"><path d="M2 10 L12 2 V7 H18 V13 H12 V18 Z" fill="currentColor" /></svg>
      </li>
      <li
        class={lamps.hazard ? 'animate-blink text-kepi-500' : 'text-stone-400'}
        data-testid="hud-hazard"
        data-on={lamps.hazard}
        aria-label="Đèn cảnh báo nguy hiểm"
      >
        <svg viewBox="0 0 20 20" class="h-6 w-6" aria-hidden="true"><path d="M10 2 L19 18 H1 Z M10 7 L5 15.5 H15 Z" fill="currentColor" fill-rule="evenodd" /></svg>
      </li>
      <li
        class={lamps.right ? 'animate-blink text-police-700' : 'text-stone-400'}
        data-testid="hud-indicator-right"
        data-on={lamps.right}
        aria-label="Xi nhan phải"
      >
        <svg viewBox="0 0 20 20" class="h-6 w-6" aria-hidden="true"><path d="M18 10 L8 2 V7 H2 V13 H8 V18 Z" fill="currentColor" /></svg>
      </li>
      <li class={state.lights === 'low' ? 'rounded bg-police-500 px-1.5 py-0.5 font-semibold text-stone-900' : 'rounded px-1.5 py-0.5 text-stone-600'} data-testid="hud-low-beam" data-on={state.lights === 'low'}>
        Đèn cốt
      </li>
      <li class={state.lights === 'high' ? 'rounded bg-police-500 px-1.5 py-0.5 font-semibold text-stone-900' : 'rounded px-1.5 py-0.5 text-stone-600'} data-testid="hud-high-beam" data-on={state.lights === 'high'}>
        Đèn pha
      </li>
      <li class={state.horn ? 'rounded bg-police-500 px-1.5 py-0.5 font-semibold text-stone-900' : 'rounded px-1.5 py-0.5 text-stone-600'} data-testid="hud-horn" data-on={state.horn}>Còi</li>
      <li class={state.skid ? 'rounded bg-kepi-500 px-1.5 py-0.5 font-semibold text-white' : 'rounded px-1.5 py-0.5 text-stone-600'} data-testid="hud-skid" data-on={state.skid}>
        Trượt bánh
      </li>
    </ul>
  </div>

  {#if notices.length > 0}
    <div class="absolute left-4 top-24 flex flex-col gap-2" data-testid="notice-stack">
      {#each notices as item (item.key)}
        <NoticeToast notice={item.notice} />
      {/each}
    </div>
  {/if}

  {#if toasts.length > 0}
    <div class="absolute bottom-28 right-4 top-20 flex flex-col gap-2 overflow-hidden" data-testid="toast-stack">
      {#each toasts as toast (toast.episodeId)}
        <BreachToast breach={toast.breach} ondismiss={() => ondismiss(toast.episodeId)} />
      {/each}
    </div>
  {/if}
</div>
