<script>
  import PageShell from '../layout/page-shell.svelte';
  import { KEY_BINDINGS } from '../../contracts/controls.js';
  import { readControlPreset, writeControlPreset } from '../lib/control-preset-store.js';
  import { formatDistance } from '../lib/format.js';
  import { keyName } from '../lib/key-label.js';
  import { PRESET_NAMES } from '../lib/hud-view.js';
  import { pageHref, playHref } from '../lib/route.js';

  /**
   * @type {{
   *   vehicles: ReadonlyArray<import('../../contracts/vehicle.js').VehicleInfo>,
   *   maps: import('../lib/catalog.js').MapsState,
   * }}
   */
  let { vehicles, maps } = $props();

  let vehicleId = $state(/** @type {string | null} */ (null));
  let mapId = $state(/** @type {string | null} */ (null));
  let preset = $state(readControlPreset());

  /** Preset choices with what each one does. */
  const PRESETS = /** @type {const} */ ([
    { id: 'simple', hint: 'số tự động, một phanh, xi nhan tự tắt sau khi rẽ' },
    { id: 'real', hint: 'số tay, hai phanh riêng, xi nhan tắt bằng tay' },
  ]);

  /** @param {import('../../contracts/controls.js').ControlPreset} id Chosen preset. */
  function choosePreset(id) {
    preset = id;
    if (!writeControlPreset(id)) console.warn('The control preset could not be saved; it applies to this visit only');
  }

  const chosenVehicle = $derived(vehicleId ?? vehicles[0]?.id ?? null);
  const chosenMap = $derived(mapId ?? (maps.status === 'ready' ? (maps.entries[0]?.id ?? null) : null));
  const startHref = $derived(chosenVehicle && chosenMap ? playHref(chosenMap, chosenVehicle) : null);
</script>

<PageShell>
  <section class="mb-8">
    <h1 class="text-3xl font-bold">Lái sao cho đúng</h1>
    <p class="mt-2 text-stone-700">
      Lái xe từ điểm xuất phát tới đích và nhận điểm trên thang 10. Mỗi lỗi vi phạm hiện mức phạt theo
      Nghị định 168/2024/NĐ-CP kèm trích dẫn.
    </p>
    <p class="mt-2 text-sm text-stone-600" data-testid="home-disclaimer">
      Kết quả chỉ để tham khảo, không phải tư vấn pháp lý.
      <a class="text-police-700 underline hover:text-police-900" href={pageHref('disclaimer')}>Đọc thêm</a>
    </p>
  </section>

  <div class="grid gap-8 md:grid-cols-2">
    <section>
      <h2 class="mb-3 text-xl font-semibold">Chọn phương tiện</h2>
      <div class="grid gap-2" role="radiogroup" aria-label="Phương tiện">
        {#each vehicles as vehicle (vehicle.id)}
          <label
            class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 {chosenVehicle === vehicle.id
              ? 'border-police-500 bg-police-50'
              : 'border-stone-300 bg-white hover:border-police-300'}"
          >
            <input
              class="accent-police-600"
              type="radio"
              name="vehicle"
              value={vehicle.id}
              checked={chosenVehicle === vehicle.id}
              onchange={() => (vehicleId = vehicle.id)}
              data-testid="vehicle-{vehicle.id}"
            />
            <span>{vehicle.name.vi}</span>
          </label>
        {/each}
      </div>

      <h2 class="mb-3 mt-6 text-xl font-semibold">Điều khiển</h2>
      <div class="grid gap-2" role="radiogroup" aria-label="Kiểu điều khiển">
        {#each PRESETS as option (option.id)}
          <label
            class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 {preset === option.id
              ? 'border-police-500 bg-police-50'
              : 'border-stone-300 bg-white hover:border-police-300'}"
          >
            <input
              class="accent-police-600"
              type="radio"
              name="control-preset"
              value={option.id}
              checked={preset === option.id}
              onchange={() => choosePreset(option.id)}
              data-testid="preset-{option.id}"
            />
            <span>
              <span class="font-medium">{PRESET_NAMES[option.id]}</span>
              <span class="block text-sm text-stone-600">{option.hint}</span>
            </span>
          </label>
        {/each}
      </div>
    </section>

    <section>
      <h2 class="mb-3 text-xl font-semibold">Chọn bản đồ</h2>
      {#if maps.status === 'loading'}
        <p class="text-stone-600">Đang tải danh sách bản đồ…</p>
      {:else if maps.status === 'error'}
        <p class="text-kepi-600" data-testid="maps-error">Không tải được danh sách bản đồ. {maps.message}</p>
      {:else if maps.entries.length === 0}
        <p class="text-stone-600">Chưa có bản đồ nào.</p>
      {:else}
        <div class="grid gap-2" role="radiogroup" aria-label="Bản đồ">
          {#each maps.entries as entry (entry.id)}
            <label
              class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 {chosenMap === entry.id
                ? 'border-police-500 bg-police-50'
                : 'border-stone-300 bg-white hover:border-police-300'}"
            >
              <input
                class="accent-police-600"
                type="radio"
                name="map"
                value={entry.id}
                checked={chosenMap === entry.id}
                onchange={() => (mapId = entry.id)}
                data-testid="map-{entry.id}"
              />
              <span class="flex-1">{entry.name.vi}</span>
              <span class="text-xs text-stone-600">{formatDistance(entry.lengthM)}</span>
              <span class="rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                {entry.kind === 'osm' ? 'bản đồ mô phỏng' : 'bài tập'}
              </span>
            </label>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <div class="mt-8">
    {#if startHref}
      <a
        class="inline-block rounded-lg bg-police-500 text-stone-900 hover:bg-police-400 px-6 py-3 text-lg font-semibold shadow-sm"
        href={startHref}
        data-testid="start-button">Bắt đầu</a
      >
    {:else}
      <span class="inline-block cursor-not-allowed rounded-lg bg-stone-200 px-6 py-3 text-lg text-stone-600" aria-disabled="true">
        Bắt đầu
      </span>
    {/if}
  </div>

  <section class="mt-10">
    <h2 class="mb-3 text-xl font-semibold">Phím điều khiển</h2>
    <table class="w-full max-w-2xl text-sm" data-testid="key-help">
      <tbody>
        {#each KEY_BINDINGS as binding (binding.action)}
          <tr class="border-b border-stone-200">
            <td class="py-1 pr-4">
              {#each binding.keys as key (key)}
                <kbd class="mr-1 rounded border border-stone-300 bg-stone-100 text-stone-800 px-1.5 py-0.5 font-mono text-xs">{keyName(key)}</kbd>
              {/each}
            </td>
            <td class="py-1 text-stone-700">{binding.label.vi}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</PageShell>
