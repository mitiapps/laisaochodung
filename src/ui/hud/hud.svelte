<script>
  import BreachToast from './breach-toast.svelte';
  import NavArrow from './nav-arrow.svelte';
  import NoticeToast from './notice-toast.svelte';
  import SpeedLimitSign from './speed-limit-sign.svelte';
  import ControlButton from './controls/control-button.svelte';
  import KeyBadge from './controls/key-badge.svelte';
  import Pedal from './controls/pedal.svelte';
  import RoundButton from './controls/round-button.svelte';
  import SteeringSlider from './controls/steering-slider.svelte';
  import { formatGear, formatScore, formatSpeed } from '../lib/format.js';
  import { actionLabel, arcButtons, noticeItems, pedalControls, rpmFraction } from '../lib/hud-view.js';
  import { watchBadgeVisibility } from '../lib/key-label.js';

  /**
   * The HUD is a control surface: readouts plus a working on-screen control for every action, each
   * with its key badge, laid out where touch controls sit on a phone in landscape.
   * @type {{
   *   state: import('../../contracts/hud.js').HudState,
   *   vehicle: import('../../contracts/vehicle.js').VehicleInfo,
   *   toasts: import('../lib/toast-stack.js').Toast[],
   *   controls: import('../../contracts/hud.js').GameControls,
   *   onpause: () => void,
   *   ondismiss: (episodeId: string) => void,
   * }}
   */
  let { state: hud, vehicle, toasts, controls, onpause, ondismiss } = $props();

  const isCar = $derived(vehicle.legalClass === 'car');
  const paused = $derived(hud.runStatus === 'paused');
  const rows = $derived(arcButtons(hud));
  const pedals = $derived(pedalControls(hud.controls, isCar, hud.controlPreset));
  const notices = $derived(noticeItems(hud.notices));

  let showBadges = $state(true);
  $effect(() =>
    watchBadgeVisibility(window, (shown) => {
      showBadges = shown;
    }),
  );

  /**
   * Hold handler of an action.
   * @param {import('../../contracts/controls.js').ControlAction} action Action.
   * @returns {(on: boolean) => void} Handler.
   */
  const holdOf = (action) => (on) => controls.hold(action, on);

  /**
   * Press handler of an action.
   * @param {import('../../contracts/controls.js').ControlAction} action Action.
   * @returns {() => void} Handler.
   */
  const pressOf = (action) => () => controls.press(action);
</script>

<div class="pointer-events-none absolute inset-0 text-stone-900" data-testid="hud">
  <div
    class="absolute inset-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))]"
  >
    <div class="relative h-full w-full">
      <!-- The control layer: the only part of the HUD that takes pointers. -->
      <div
        class="pointer-events-auto absolute inset-0 touch-none select-none"
        data-testid="hud-controls"
        role="presentation"
        onpointerdown={(e) => e.preventDefault()}
        oncontextmenu={(e) => e.preventDefault()}
      >
        <div class="absolute right-0 top-0">
          <ControlButton
            action="pause"
            mode="press"
            label={actionLabel('pause')}
            onpress={onpause}
            testid="hud-pause"
            class="h-14 min-w-14 rounded-xl border border-police-600 bg-police-500 px-3 text-sm font-semibold text-stone-900 shadow-md"
          >
            {paused ? 'Tiếp tục' : 'Tạm dừng'}
            <KeyBadge action="pause" shown={showBadges} class="-bottom-2 right-1" />
          </ControlButton>
        </div>

        <div class="absolute bottom-0 left-0">
          <SteeringSlider steer={hud.controls.steer} {showBadges} onsteer={(v) => controls.steer(v)} />
        </div>

        <div class="absolute bottom-0 right-0 flex flex-col items-end gap-2">
          {#each rows as row, i (i)}
            <div class="flex gap-2">
              {#each row as button (button.action)}
                <RoundButton {button} lights={hud.lights} {showBadges} onhold={holdOf(button.action)} onpress={pressOf(button.action)} />
              {/each}
            </div>
          {/each}
          <div class="flex items-end gap-2">
            {#each pedals as control (control.action)}
              <Pedal {control} {showBadges} onhold={holdOf(control.action)} />
            {/each}
          </div>
        </div>
      </div>

      <!-- Readouts: no actions. -->
      <div class="absolute left-0 top-0 flex items-start gap-2">
        <div class="rounded-lg border border-white/60 bg-white/90 px-3 py-1.5 shadow-md backdrop-blur">
          <p class="text-xs text-stone-600">Điểm</p>
          <p class="text-2xl font-bold" data-testid="hud-score">{formatScore(hud.score)}</p>
        </div>
        <div class="rounded-lg border border-white/60 bg-white/90 px-2 py-1 shadow-md backdrop-blur">
          <NavArrow nav={hud.nav} headingRad={hud.headingRad} />
        </div>
      </div>

      <div
        class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-end gap-2 rounded-lg border border-white/60 bg-white/90 p-2 shadow-md backdrop-blur"
        data-testid="hud-speed-panel"
      >
        <SpeedLimitSign limitKmh={hud.speedLimitKmh} verified={hud.speedLimitVerified} />
        <div class="text-center">
          <p class="text-4xl font-bold tabular-nums leading-none" data-testid="hud-speed">{formatSpeed(hud.speedKmh)}</p>
          <p class="text-xs text-stone-600">km/h</p>
        </div>
        <div class="text-center">
          <p class="text-xs text-stone-600">Số</p>
          <p class="text-3xl font-bold leading-none" data-testid="hud-gear">{formatGear(hud.gear)}</p>
        </div>
        <div class="flex flex-col items-start gap-1">
          {#if isCar}
            <div class="w-20" data-testid="hud-rpm">
              <p class="text-[10px] text-stone-600">Vòng tua</p>
              <div class="h-2 overflow-hidden rounded bg-stone-200">
                <div class="h-full bg-police-700" style:width="{rpmFraction(hud.rpm) * 100}%"></div>
              </div>
              <p class="text-[10px] tabular-nums text-stone-700">{Math.round(hud.rpm)} v/ph</p>
            </div>
          {/if}
          <p
            class={hud.skid ? 'rounded bg-kepi-500 px-1.5 py-0.5 text-[10px] font-semibold text-white' : 'rounded px-1.5 py-0.5 text-[10px] text-stone-500'}
            data-testid="hud-skid"
            data-on={hud.skid}
          >
            Trượt bánh
          </p>
        </div>
      </div>

      <!-- Toasts: top centre, height capped clear of the arc, the pedals and the pause button; the
           newest first, so the cap never hides it. -->
      <div
        class="absolute left-1/2 top-0 flex max-h-[calc(100dvh-16rem)] w-72 max-w-[calc(100%-26rem)] min-w-60 -translate-x-1/2 flex-col gap-2 overflow-y-auto overflow-x-hidden"
        data-testid="toast-stack"
      >
        {#if notices.length > 0}
          <div class="flex flex-col gap-2" data-testid="notice-stack">
            {#each [...notices].reverse() as item (item.key)}
              <NoticeToast notice={item.notice} />
            {/each}
          </div>
        {/if}
        {#each [...toasts].reverse() as toast (toast.episodeId)}
          <BreachToast breach={toast.breach} ondismiss={() => ondismiss(toast.episodeId)} />
        {/each}
      </div>
    </div>
  </div>
</div>
