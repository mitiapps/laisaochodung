<script>
  import BreachToast from './breach-toast.svelte';
  import NavArrow from './nav-arrow.svelte';
  import NoticeToast from './notice-toast.svelte';
  import SpeedLimitSign from './speed-limit-sign.svelte';
  import ControlButton from './controls/control-button.svelte';
  import GearLever from './controls/gear-lever.svelte';
  import KeyBadge from './controls/key-badge.svelte';
  import Pedal from './controls/pedal.svelte';
  import RoundButton from './controls/round-button.svelte';
  import SteeringSlider from './controls/steering-slider.svelte';
  import { formatGear, formatScore, formatSpeed, formatTally } from '../lib/format.js';
  import {
    CAMERA_SHORT_NAMES,
    VOICE_TOGGLE_LABELS,
    actionLabel,
    buttonView,
    controlLayout,
    newestToast,
    noticeItems,
    pedalControl,
    rpmFraction,
    showsReverseChip,
  } from '../lib/hud-view.js';
  import { watchBadgeVisibility } from '../lib/key-label.js';

  /**
   * The HUD is a control surface: readouts plus a working on-screen control for every action of
   * the vehicle, each with its key badge, in cabin order from left to right (`controlLayout`): the
   * stalk or switch cluster, the left lever, the steering, the horn, the pedals or the right grip,
   * the gear lever and the right-hand console. One layout serves every screen: the steering sits at
   * the bottom centre with the stalk on its left, unless the screen is too narrow for the groups on
   * one side, in which case the row shifts towards the other side until both fit. A free run shows
   * its breach tally in the score box instead of a score; with no `nav` there is no nav arrow.
   * @type {{
   *   state: import('../../contracts/hud.js').HudState,
   *   vehicle: import('../../contracts/vehicle.js').VehicleInfo,
   *   toasts: import('../lib/toast-stack.js').Toast[],
   *   controls: import('../../contracts/hud.js').GameControls,
   *   cameraMode?: import('../../contracts/controls.js').CameraMode,
   *   voiceMuted?: boolean | null,
   *   ontogglevoice?: () => void,
   *   onpause: () => void,
   *   ondismiss: (episodeId: string) => void,
   *   runKey?: number,
   * }}
   */
  let { state: hud, vehicle, toasts, controls, cameraMode = 'chase', voiceMuted = null, ontogglevoice = () => {}, onpause, ondismiss, runKey = 0 } = $props();

  const free = $derived(hud.mode === 'free');
  const isCar = $derived(vehicle.legalClass === 'car');
  const paused = $derived(hud.runStatus === 'paused');
  const layout = $derived(controlLayout(vehicle.legalClass, hud.controlPreset));

  /**
   * The row of controls hangs off one anchor, `--hud-cx`: the horizontal centre of the steering,
   * the middle of the HUD box when the box is wide enough, else as near to it as both sides allow.
   * The left and right groups start 8 px from the steering's edge (a 112 px wheel, a 168 px
   * handlebar). The speed panel has a fixed width, so a faster readout never grows it: the car's
   * sits left of the stalk, the motorbike's right of the grip column. The clamp bounds are the
   * widest extent of each side from the anchor: car, 64 + 120 + 8 + 148 px on the left and 64 + 344
   * px on the right; motorbike, 92 + 264 px on the left and 92 + 72 + 8 + 56 + 8 + 148 px on the
   * right (the grip column, then the push-back button).
   * Every group's bottom edge is 40 px above the padded bottom, so the map attribution under it
   * stays readable.
   */
  const place = $derived(
    isCar
      ? {
          cx: 'clamp(340px, 50%, calc(100% - 408px))',
          left: 'right-[calc(100%-var(--hud-cx)+64px)]',
          right: 'left-[calc(var(--hud-cx)+64px)]',
          speed: 'right-[calc(100%-var(--hud-cx)+192px)]',
        }
      : {
          cx: 'clamp(356px, 50%, calc(100% - 384px))',
          left: 'right-[calc(100%-var(--hud-cx)+92px)]',
          right: 'left-[calc(var(--hud-cx)+92px)]',
          speed: 'left-[calc(var(--hud-cx)+236px)]',
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
    <div class="relative h-full w-full" style:--hud-cx={place.cx}>
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
            {#if voiceMuted !== null}
              <!-- Only on maps with spoken lines; null hides it. -->
              <button
                type="button"
                class="h-14 min-w-14 rounded-xl border-2 border-white/70 bg-white/95 px-2 text-xs font-semibold text-stone-800 shadow-md"
                data-testid="hud-voice"
                data-value={voiceMuted ? 'muted' : 'on'}
                aria-pressed={!voiceMuted}
                onclick={ontogglevoice}
              >
                {VOICE_TOGGLE_LABELS[voiceMuted ? 'muted' : 'on'].vi}
              </button>
            {/if}
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

          <!-- Left of the steering: the stalk, or a motorbike's switch cluster (lights and hazard
               above the indicators and horn), then the motorbike's left hand lever: the rear brake
               on Thực tế, the one brake on Đơn giản. -->
          <div class="absolute bottom-10 flex items-start gap-2 {place.left}" data-zone="left">
            <div class="flex flex-col gap-2" data-zone="stalk">
              {#each layout.stalk as row, i (i)}
                <div class="flex gap-2">
                  {#each row as action (action)}
                    <RoundButton button={buttonView(action, hud)} lights={hud.lights} {showBadges} onhold={holdOf(action)} onpress={pressOf(action)} />
                  {/each}
                </div>
              {/each}
            </div>
            {#each layout.leftLever as action (action)}
              <Pedal control={pedalControl(/** @type {'brake' | 'brakeRear'} */ (action), hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(action)} />
            {/each}
          </div>

          <div class="absolute bottom-10 left-(--hud-cx) -translate-x-1/2" data-zone="steering">
            <SteeringSlider steer={hud.controls.steer} shape={layout.steering} {showBadges} onsteer={(v) => controls.steer(v)} />
          </div>

          <!-- Right of the steering: the car's horn, pedals, gear lever and console (hazard over the
               handbrake), or the motorbike's throttle grip, under the front brake lever on Thực tế,
               then its push-back button. -->
          <div class="absolute bottom-10 flex items-end gap-2 {place.right}" data-zone="right">
            {#each layout.horn as action (action)}
              <div class="mb-7" data-zone="horn">
                <RoundButton button={buttonView(action, hud)} lights={hud.lights} {showBadges} onhold={holdOf(action)} onpress={pressOf(action)} />
              </div>
            {/each}
            {#each layout.pedals as action (action)}
              <Pedal control={pedalControl(/** @type {'brake' | 'throttle'} */ (action), hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(action)} />
            {/each}
            {#if layout.rightGrip.length > 0}
              <div class="flex flex-col gap-2" data-zone="right-grip">
                {#each layout.rightGrip as action (action)}
                  <Pedal control={pedalControl(/** @type {'brake' | 'throttle'} */ (action), hud.controls, isCar, hud.controlPreset)} {showBadges} onhold={holdOf(action)} />
                {/each}
              </div>
            {/if}
            {#if layout.gears.length === 2}
              <GearLever up={buttonView(layout.gears[0], hud)} down={buttonView(layout.gears[1], hud)} gearText={formatGear(hud.gear)} {showBadges} onpress={(a) => controls.press(a)} />
            {/if}
            {#if layout.console.length > 0}
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
          {#if free}
            <p class="text-xs text-stone-600">Lái tự do</p>
            <p class="text-2xl font-bold" data-testid="hud-tally">{formatTally(hud.breachCount)}</p>
          {:else}
            <p class="text-xs text-stone-600">Điểm</p>
            <p class="text-2xl font-bold" data-testid="hud-score">{formatScore(hud.score)}</p>
          {/if}
        </div>
        {#if hud.nav}
          <div class="rounded-lg border border-white/60 bg-white/90 px-2 py-1 shadow-md backdrop-blur">
            <NavArrow nav={hud.nav} headingRad={hud.headingRad} />
          </div>
        {/if}
      </div>

      <!-- The speed panel: the limit sign and a readout three digits wide on top, then the car's
           gear and the skid lamp, then the car's rpm bar. Every column has a fixed width. -->
      <div
        class="absolute bottom-10 flex w-[148px] flex-col gap-2 rounded-lg border border-white/60 bg-white/90 p-2 shadow-md backdrop-blur {place.speed}"
        data-testid="hud-speed-panel"
      >
        <div class="flex items-end gap-2">
          <div class="w-16 shrink-0">
            <SpeedLimitSign limitKmh={hud.speedLimitKmh} verified={hud.speedLimitVerified} />
          </div>
          <div class="text-center">
            <p class="min-w-[3ch] text-4xl font-bold tabular-nums leading-none" data-testid="hud-speed">{formatSpeed(hud.speedKmh)}</p>
            <p class="text-xs text-stone-600">km/h</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          {#if isCar}
            <p class="flex items-baseline gap-1">
              <span class="text-xs text-stone-600">Số</span>
              <span class="text-2xl font-bold leading-none" data-testid="hud-gear">{formatGear(hud.gear)}</span>
            </p>
          {:else if showsReverseChip(vehicle.legalClass, hud.gear)}
            <p class="whitespace-nowrap rounded bg-police-500 px-1 py-0.5 text-[10px] font-bold text-stone-900" data-testid="hud-reverse">LÙI</p>
          {/if}
          <p
            class="ml-auto whitespace-nowrap rounded px-0.5 py-0.5 text-[10px] tracking-tight {hud.skid ? 'bg-kepi-500 font-medium text-white' : 'text-stone-500'}"
            data-testid="hud-skid"
            data-on={hud.skid}
          >
            Trượt bánh
          </p>
        </div>
        {#if isCar}
          <div data-testid="hud-rpm">
            <div class="h-2 overflow-hidden rounded bg-stone-200">
              <div class="h-full bg-police-700" style:width="{rpmFraction(hud.rpm) * 100}%"></div>
            </div>
            <p class="whitespace-nowrap text-[10px] tabular-nums text-stone-700">Vòng tua {Math.round(hud.rpm)} v/ph</p>
          </div>
        {/if}
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
