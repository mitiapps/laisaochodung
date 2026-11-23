<script>
  import { untrack } from 'svelte';
  import Hud from '../hud/hud.svelte';
  import ResultScreen from '../result/result-screen.svelte';
  import { dismissToast, emptyToastStack, ingestBreaches, pruneToasts } from '../lib/toast-stack.js';
  import { pageHref } from '../lib/route.js';

  /**
   * @type {{
   *   game: import('../../contracts/hud.js').GameApi | null,
   *   canvas: HTMLElement | null,
   *   mapId: string | null,
   *   vehicleId: string | null,
   *   vehicles: ReadonlyArray<import('../../contracts/vehicle.js').VehicleInfo>,
   *   mapEntry: import('../../contracts/catalog.js').MapIndexEntry | null,
   * }}
   */
  let { game, canvas, mapId, vehicleId, vehicles, mapEntry } = $props();

  const vehicle = $derived(vehicles.find((v) => v.id === vehicleId) ?? null);

  let hud = $state(/** @type {import('../../contracts/hud.js').HudState | null} */ (null));
  let error = $state(/** @type {string | null} */ (null));
  let stack = $state(emptyToastStack());

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
      g.start(map, v.id).catch((/** @type {unknown} */ err) => {
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
    game?.restart();
  }

  function changeMap() {
    location.hash = pageHref('home');
  }
</script>

<div class="relative h-screen w-screen overflow-hidden bg-black text-slate-100" data-testid="play-screen">
  <div class="absolute inset-0" data-testid="canvas-mount" {@attach attachCanvas}></div>

  {#if problem || error}
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="rounded-xl bg-slate-900 p-6 text-center" data-testid="play-error">
        <p class="mb-4">{problem ?? error}</p>
        <a class="rounded-lg bg-slate-700 px-4 py-2 hover:bg-slate-600" href={pageHref('home')}>Về trang chủ</a>
      </div>
    </div>
  {:else if hud}
    {#if hud.runStatus !== 'finished' && vehicle}
      <Hud
        state={hud}
        {vehicle}
        toasts={stack.items}
        onpause={togglePause}
        ondismiss={(id) => (stack = dismissToast(stack, id))}
      />
    {/if}

    {#if hud.runStatus === 'paused'}
      <div class="absolute inset-0 flex items-center justify-center bg-black/60" data-testid="pause-overlay">
        <div class="flex flex-col gap-3 rounded-xl bg-slate-900 p-6 text-center">
          <h2 class="text-2xl font-bold">Tạm dừng</h2>
          <button type="button" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500" data-testid="pause-resume" onclick={() => game?.resume()}>
            Tiếp tục
          </button>
          <button type="button" class="rounded-lg bg-slate-700 px-4 py-2 hover:bg-slate-600" data-testid="pause-restart" onclick={restart}>
            Chơi lại
          </button>
          <button type="button" class="rounded-lg bg-rose-700 px-4 py-2 hover:bg-rose-600" data-testid="pause-quit" onclick={() => game?.quit()}>
            Kết thúc lượt chơi
          </button>
        </div>
      </div>
    {/if}

    {#if hud.runStatus === 'finished'}
      <div class="absolute inset-0 flex items-center justify-center bg-black/70 px-6 pb-8 pt-6">
        {#if hud.report}
          <ResultScreen report={hud.report} onretry={restart} onchangemap={changeMap} />
        {:else}
          <div class="rounded-xl bg-slate-900 p-6 text-center" data-testid="result-missing">
            <p class="mb-4">Lượt chơi đã kết thúc nhưng không có kết quả.</p>
            <button type="button" class="rounded-lg bg-slate-700 px-4 py-2" onclick={changeMap}>Về trang chủ</button>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="absolute inset-0 flex items-center justify-center text-slate-300">Đang tải bản đồ…</div>
  {/if}

  {#if mapEntry?.kind === 'osm'}
    <p class="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-xs text-slate-300" data-testid="osm-attribution">
      <a class="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        {mapEntry.attribution ?? '© OpenStreetMap contributors, ODbL'}
      </a>
      · bản đồ mô phỏng, biển báo có thể khác ngoài thực tế
    </p>
  {/if}
</div>
