<script>
  import { untrack } from 'svelte';
  import Hud from '../hud/hud.svelte';
  import ResultScreen from '../result/result-screen.svelte';
  import { readControlPreset } from '../lib/control-preset-store.js';
  import { PRESET_NAMES } from '../lib/hud-view.js';
  import { dismissToast, emptyToastStack, ingestBreaches, pruneToasts } from '../lib/toast-stack.js';
  import { pageHref } from '../lib/route.js';

  /**
   * @type {{
   *   game: import('../../contracts/hud.js').GameApi | null,
   *   canvas: HTMLElement | null,
   *   camera?: import('../../game/camera-control.js').CameraControl | null,
   *   mapId: string | null,
   *   vehicleId: string | null,
   *   vehicles: ReadonlyArray<import('../../contracts/vehicle.js').VehicleInfo>,
   *   mapEntry: import('../../contracts/catalog.js').MapIndexEntry | null,
   * }}
   */
  let { game, canvas, camera = null, mapId, vehicleId, vehicles, mapEntry } = $props();

  /** @type {import('../../contracts/controls.js').CameraMode} */
  let cameraMode = $state('chase');
  $effect(() =>
    camera?.subscribe((mode) => {
      cameraMode = mode;
    }),
  );

  const vehicle = $derived(vehicles.find((v) => v.id === vehicleId) ?? null);

  let hud = $state(/** @type {import('../../contracts/hud.js').HudState | null} */ (null));
  let error = $state(/** @type {string | null} */ (null));
  let stack = $state(emptyToastStack());
  /** Counts restarts; the HUD rebuilds its on-screen controls when it changes. */
  let runKey = $state(0);

  const problem = $derived(
    !game
      ? 'Trò chơi chưa sẵn sàng.'
      : !mapId
        ? 'Chưa chọn bản đồ.'
        : !vehicle
          ? 'Phương tiện không hợp lệ.'
          : null,
  );

  $effect(() => {
    const g = game;
    const map = mapId;
    const v = vehicle;
    if (!g || !map || !v) return;
    return untrack(() => {
      let active = true;
      hud = null;
      error = null;
      stack = emptyToastStack();
      const off = g.subscribe((state) => {
        if (!active) return;
        if (state.runStatus === 'ready' && hud?.runStatus !== 'ready') stack = emptyToastStack();
        hud = state;
        stack = ingestBreaches(stack, state.toasts, performance.now());
      });
      g.start(map, v.id, { controlPreset: readControlPreset() }).catch((/** @type {unknown} */ err) => {
        console.error('Failed to start the run', err);
        if (active) error = 'Không khởi động được lượt chơi. Hãy thử lại hoặc chọn bản đồ khác.';
      });
      const timer = setInterval(() => {
        stack = pruneToasts(stack, performance.now());
      }, 250);
      return () => {
        active = false;
        clearInterval(timer);
        off();
        if (hud?.runStatus === 'finished') return;
        try {
          g.quit();
        } catch (err) {
          console.error('Failed to end the run on leaving the play screen', err);
        }
      };
    });
  });

  /**
   * Keeps the game canvas in the play screen; removing it on leave does not destroy it.
   * @param {HTMLElement} node Container.
   * @returns {(() => void) | undefined} Cleanup.
   */
  function attachCanvas(node) {
    const el = canvas;
    if (!el) return undefined;
    node.appendChild(el);
    return () => el.remove();
  }

  function togglePause() {
    if (!game || !hud) return;
    if (hud.runStatus === 'running') game.pause();
    else if (hud.runStatus === 'paused') game.resume();
  }

  function restart() {
    stack = emptyToastStack();
    runKey += 1;
    game?.restart();
  }

  function changeMap() {
    location.hash = pageHref('home');
  }
</script>

<div class="relative h-screen w-screen overflow-hidden bg-stone-100 text-stone-900" data-testid="play-screen">
  <div class="absolute inset-0" data-testid="canvas-mount" {@attach attachCanvas}></div>

  {#if problem || error}
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="rounded-xl border border-stone-200 bg-white p-6 text-center shadow-xl" data-testid="play-error">
        <p class="mb-4">{problem ?? error}</p>
        <a class="rounded-lg border border-stone-300 bg-white text-stone-900 hover:bg-stone-100 px-4 py-2" href={pageHref('home')}>Về trang chủ</a>
      </div>
    </div>
  {:else if hud}
    {#if hud.runStatus !== 'finished' && vehicle}
      <Hud
        state={hud}
        {vehicle}
        toasts={stack.items}
        controls={/** @type {import('../../contracts/hud.js').GameApi} */ (game).controls}
        {cameraMode}
        {runKey}
        onpause={togglePause}
        ondismiss={(id) => (stack = dismissToast(stack, id))}
      />
    {/if}

    {#if hud.runStatus === 'paused'}
      <div class="absolute inset-0 flex items-center justify-center bg-stone-900/40" data-testid="pause-overlay">
        <div class="flex flex-col gap-3 rounded-xl border-t-4 border-police-500 bg-white p-6 shadow-xl text-center">
          <h2 class="text-2xl font-bold">Tạm dừng</h2>
          <p class="text-sm text-stone-700" data-testid="pause-preset">
            Điều khiển: {PRESET_NAMES[hud.controlPreset]}
            <span class="block text-xs text-stone-500">đổi ở trang chủ, áp dụng ở lượt sau</span>
          </p>
          <button type="button" class="rounded-lg bg-police-500 text-stone-900 hover:bg-police-400 px-4 py-2 font-semibold" data-testid="pause-resume" onclick={() => game?.resume()}>
            Tiếp tục
          </button>
          <button type="button" class="rounded-lg border border-stone-300 bg-white text-stone-900 hover:bg-stone-100 px-4 py-2" data-testid="pause-restart" onclick={restart}>
            Chơi lại
          </button>
          <button type="button" class="rounded-lg bg-kepi-500 px-4 py-2 text-white hover:bg-kepi-600" data-testid="pause-quit" onclick={() => game?.quit()}>
            Kết thúc lượt chơi
          </button>
        </div>
      </div>
    {/if}

    {#if hud.runStatus === 'finished'}
      <div class="absolute inset-0 flex items-center justify-center bg-stone-900/50 px-6 pb-8 pt-6">
        {#if hud.report}
          <ResultScreen report={hud.report} onretry={restart} onchangemap={changeMap} />
        {:else}
          <div class="rounded-xl border border-stone-200 bg-white p-6 text-center shadow-xl" data-testid="result-missing">
            <p class="mb-4">Lượt chơi đã kết thúc nhưng không có kết quả.</p>
            <button type="button" class="rounded-lg border border-stone-300 bg-white text-stone-900 hover:bg-stone-100 px-4 py-2" onclick={changeMap}>Về trang chủ</button>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="absolute inset-0 flex items-center justify-center"><span class="rounded-lg bg-white/90 px-4 py-2 text-stone-800 shadow">Đang tải bản đồ…</span></div>
  {/if}

  {#if mapEntry?.kind === 'osm'}
    <p
      class="pointer-events-none absolute bottom-[max(0.25rem,env(safe-area-inset-bottom))] left-1/2 w-max max-w-80 -translate-x-1/2 rounded bg-white/90 px-2 py-0.5 text-center text-[11px] leading-tight text-stone-700 shadow-sm"
      data-testid="osm-attribution"
    >
      <a class="pointer-events-auto underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        {mapEntry.attribution ?? '© OpenStreetMap contributors, ODbL'}
      </a>
      · bản đồ mô phỏng, biển báo có thể khác ngoài thực tế
    </p>
  {/if}
</div>
