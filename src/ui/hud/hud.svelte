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
  import { CAMERA_SHORT_NAMES, actionLabel, buttonView, controlLayout, newestToast, noticeItems, pedalControl, rpmFraction } from '../lib/hud-view.js';
  import { watchBadgeVisibility } from '../lib/key-label.js';

  /**
   * The HUD is a control surface: readouts plus a working on-screen control for every action of
   * the vehicle, each with its key badge, in cabin order from left to right (`controlLayout`): the
   * stalk, the left lever, the steering, the horn, the pedals and the right-hand console. On a
   * phone the steering sits in the left thumb zone under the stalk; on a desktop window (the `desk`
   * variant) it moves to the bottom centre with the stalk on its left and the horn on its right.
   * @type {{
   *   state: import('../../contracts/hud.js').HudState,
   *   vehicle: import('../../contracts/vehicle.js').VehicleInfo,
   *   toasts: import('../lib/toast-stack.js').Toast[],
   *   controls: import('../../contracts/hud.js').GameControls,
   *   cameraMode?: import('../../contracts/controls.js').CameraMode,
   *   onpause: () => void,
   *   ondismiss: (episodeId: string) => void,
   *   runKey?: number,
   * }}
   */
  let { state: hud, vehicle, toasts, controls, cameraMode = 'chase', onpause, ondismiss, runKey = 0 } = $props();

  const isCar = $derived(vehicle.legalClass === 'car');
  const paused = $derived(hud.runStatus === 'paused');
  const layout = $derived(controlLayout(vehicle.legalClass, hud.controlPreset));
  const hasLever = $derived(layout.lever.length > 0);

  /**
   * Places of the left zones, phone first and `desk:` for a desktop window. The steering is 112 px
   * (wheel) or 168 × 72 px (handlebar), buttons 56 px with 8 px gaps; the desktop row sits 40 px
   * up so the map attribution under it stays readable.
   */
  const place = $derived(
    isCar
      ? {
          steering: 'bottom-0 left-0 desk:bottom-10 desk:left-1/2 desk:-translate-x-1/2',
          stalk: 'bottom-[120px] left-0 desk:bottom-10 desk:left-auto desk:right-[calc(50%+64px)]',
          lever: '',
          horn: 'bottom-7 left-[120px] desk:bottom-[68px] desk:left-[calc(50%+64px)]',
          speed: 'desk:bottom-10 desk:left-auto desk:right-[calc(50%+192px)] desk:translate-x-0',
        }
      : {
          steering: `bottom-0 ${hasLever ? 'left-16' : 'left-0'} desk:bottom-10 desk:left-1/2 desk:-translate-x-1/2`,
          stalk: `bottom-20 left-0 desk:bottom-10 desk:left-auto ${hasLever ? 'desk:right-[calc(50%+156px)]' : 'desk:right-[calc(50%+92px)]'}`,
          lever: 'bottom-2 left-0 desk:bottom-12 desk:left-auto desk:right-[calc(50%+92px)]',
          horn: '',
          speed: 'desk:bottom-10 desk:left-[calc(50%+92px)] desk:translate-x-0',
        },
  );
  const notices = $derived(noticeItems(hud.notices));
  // Below 480 px of viewport height only the newest toast-stack item shows, with a count of the rest.
  const newest = $derived(newestToast(notices, toasts));
  const SHORT_HIDDEN = '[@media(max-height:480px)]:hidden';

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

{#snippet moreCount()}
  <span
    class="pointer-events-none absolute bottom-1 right-1 hidden rounded-full bg-stone-700 px-1.5 text-[10px] font-semibold text-white [@media(max-height:480px)]:block"
    data-testid="toast-more"
    aria-label={`${newest.more} thông báo khác`}>+{newest.more}</span
  >
{/snippet}

<div class="pointer-events-none absolute inset-0 text-stone-900" data-testid="hud">
  <div
    class="absolute inset-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))]"
  >
    <div class="relative h-full w-full">
      <!-- The control layer: the only part of the HUD that takes pointers. A restart (a new
           `runKey`) rebuilds it, so no control keeps pointers from the last run. -->
      {#key runKey}
        <div
          class="pointer-events-auto absolute inset-0 touch-none select-none"
          data-testid="hud-controls"
          role="presentation"
          onpointerdown={(e) => e.preventDefault()}
          oncontextmenu={(e) => e.preventDefault()}
        >
          <!-- Lifted above the pause overlay, so pause and the camera stay usable while paused. -->
          <div class="absolute right-0 top-0 z-10 flex gap-2">
            <ControlButton
              action="camera"
              mode="press"
              label={actionLabel('camera')}
              onpress={() => controls.press('camera')}
              testid="hud-camera"
              dataValue={cameraMode}
              class="h-14 min-w-14 flex-col rounded-xl border-2 border-white/70 bg-white/95 px-2 text-xs font-semibold text-stone-800 shadow-md"
            >
              <span>Góc nhìn</span>
              <span class="text-[10px] font-normal text-stone-600">{CAMERA_SHORT_NAMES[cameraMode]}</span>
              <KeyBadge action="camera" shown={showBadges} class="-bottom-2 right-1" />
            </ControlButton>
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

          <!-- Left stalk, or a motorbike's left switch cluster: lights above, indicators below. -->
          <div class="absolute flex flex-col items-start gap-2 desk:items-end {place.stalk}" data-zone="stalk">
            {#each layout.stalk as row, i (i)}
              <div class="flex gap-2">
                {#each row as action (action)}
                  <RoundButton button={buttonView(action, hud)} lights={hud.lights} {showBadges} onhold={holdOf(action)} onpress={pressOf(action)} />
                {/each}
              </div>
            {/each}
          </div>

          {#each layout.lever as action (action)}
            <div class="absolute {place.lever}" data-zone="lever">
              <Pedal control={pedalControl(/** @type {'brakeRear'} */ (action), hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(action)} />
            </div>
          {/each}

          <div class="absolute {place.steering}" data-zone="steering">
            <SteeringSlider steer={hud.controls.steer} shape={layout.steering} {showBadges} onsteer={(v) => controls.steer(v)} />
          </div>

          {#each layout.horn as action (action)}
            <div class="absolute {place.horn}" data-zone="horn">
              <RoundButton button={buttonView(action, hud)} lights={hud.lights} {showBadges} onhold={holdOf(action)} onpress={pressOf(action)} />
            </div>
          {/each}

          <!-- Right cluster: brake, throttle, then the console at the screen edge (a motorbike's
               lone hazard switch stands above the throttle instead). -->
          <div class="absolute bottom-0 right-0 flex items-end gap-2" data-zone="right">
            {#each layout.pedals as action (action)}
              {#if action === 'throttle' && layout.consoleOverThrottle}
                <div class="flex flex-col items-center gap-2" data-zone="console">
                  {#each layout.console as c (c)}
                    <RoundButton button={buttonView(c, hud)} lights={hud.lights} {showBadges} onhold={holdOf(c)} onpress={pressOf(c)} />
                  {/each}
                  <Pedal control={pedalControl('throttle', hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(action)} />
                </div>
              {:else}
                <Pedal control={pedalControl(/** @type {'brake' | 'throttle'} */ (action), hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(action)} />
              {/if}
            {/each}
            {#if !layout.consoleOverThrottle}
              <div class="flex flex-col gap-2" data-zone="console">
                {#each layout.console as c (c)}
                  {#if c === 'handbrake'}
                    <Pedal control={pedalControl('handbrake', hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(c)} />
                  {:else}
                    <RoundButton button={buttonView(c, hud)} lights={hud.lights} {showBadges} onhold={holdOf(c)} onpress={pressOf(c)} />
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/key}

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
        class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-end gap-2 rounded-lg border border-white/60 bg-white/90 p-2 shadow-md backdrop-blur {place.speed}"
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

      <!-- Toasts: top centre, height capped clear of the controls and the top-right buttons; the
           newest first, so the cap never hides it. Below 480 px of viewport height (a landscape
           phone) only the newest item shows, with a "+N" count of the hidden ones, since two toasts
           do not fit above the controls there. -->
      <div
        class="absolute left-1/2 top-0 flex max-h-[calc(100dvh-16rem)] w-72 max-w-[calc(100%-26rem)] min-w-60 -translate-x-1/2 flex-col gap-2 overflow-y-auto overflow-x-hidden"
        data-testid="toast-stack"
      >
        {#if notices.length > 0}
          <div
            class={`flex flex-col gap-2 ${newest.key?.startsWith('notice:') ? '' : SHORT_HIDDEN}`}
            data-testid="notice-stack"
          >
            {#each [...notices].reverse() as item (item.key)}
              {@const isNewest = newest.key === `notice:${item.key}`}
              <div class={`relative shrink-0 ${isNewest ? '' : SHORT_HIDDEN}`}>
                <NoticeToast notice={item.notice} />
                {#if isNewest && newest.more > 0}{@render moreCount()}{/if}
              </div>
            {/each}
          </div>
        {/if}
        {#each [...toasts].reverse() as toast (toast.episodeId)}
          {@const isNewest = newest.key === `toast:${toast.episodeId}`}
          <div class={`relative shrink-0 ${isNewest ? '' : SHORT_HIDDEN}`}>
            <BreachToast breach={toast.breach} ondismiss={() => ondismiss(toast.episodeId)} />
            {#if isNewest && newest.more > 0}{@render moreCount()}{/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>
