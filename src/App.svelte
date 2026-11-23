<script>
  import { onMount } from 'svelte';
  import HomePage from './ui/pages/home-page.svelte';
  import PlayPage from './ui/pages/play-page.svelte';
  import DisclaimerPage from './ui/pages/disclaimer-page.svelte';
  import ContactPage from './ui/pages/contact-page.svelte';
  import DonatePage from './ui/pages/donate-page.svelte';
  import CreditsPage from './ui/pages/credits-page.svelte';
  import NotFoundPage from './ui/pages/not-found-page.svelte';
  import { VEHICLES, loadMapIndex } from './ui/lib/catalog.js';
  import { parseHash } from './ui/lib/route.js';

  /**
   * Root component. `src/main.js` mounts it with the game API and the canvas the renderer draws on.
   * Both may be null before integration; the play screen then says the game is not ready.
   * @type {{
   *   game?: import('./contracts/hud.js').GameApi | null,
   *   canvas?: HTMLElement | null,
   *   loadMaps?: () => Promise<import('./contracts/catalog.js').MapIndexEntry[]>,
   * }}
   */
  let { game = null, canvas = null, loadMaps = () => loadMapIndex() } = $props();

  let route = $state(parseHash(location.hash));
  /** @type {import('./ui/lib/catalog.js').MapsState} */
  let maps = $state({ status: 'loading' });

  const mapEntry = $derived(
    maps.status === 'ready' ? (maps.entries.find((m) => m.id === route.mapId) ?? null) : null,
  );

  onMount(() => {
    const onHash = () => {
      route = parseHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    let active = true;
    loadMaps().then(
      (entries) => {
        if (active) maps = { status: 'ready', entries };
      },
      (/** @type {unknown} */ err) => {
        console.error('Failed to load the map index', err);
        if (active) maps = { status: 'error', message: 'Dữ liệu bản đồ chưa sẵn sàng hoặc bị lỗi.' };
      },
    );
    return () => {
      active = false;
      window.removeEventListener('hashchange', onHash);
    };
  });
</script>

{#if route.name === 'home'}
  <HomePage vehicles={VEHICLES} {maps} />
{:else if route.name === 'play'}
  {#key `${route.mapId}|${route.vehicleId}`}
    <PlayPage {game} {canvas} mapId={route.mapId} vehicleId={route.vehicleId} vehicles={VEHICLES} {mapEntry} />
  {/key}
{:else if route.name === 'disclaimer'}
  <DisclaimerPage />
{:else if route.name === 'contact'}
  <ContactPage />
{:else if route.name === 'donate'}
  <DonatePage />
{:else if route.name === 'credits'}
  <CreditsPage />
{:else}
  <NotFoundPage />
{/if}
