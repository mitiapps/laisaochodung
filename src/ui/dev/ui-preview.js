/**
 * Dev-only preview: mounts `App.svelte` with a stub `GameApi` that replays the recorded HUD states
 * in `tests/fixtures/hud-states.json` and the fixture map index. Loaded by `dev/ui-preview.html`
 * under `npm run dev`; never part of the production build.
 */

import { mount } from 'svelte';
import '../../app.css';
import App from '../../App.svelte';
import hudStates from '../../../tests/fixtures/hud-states.json';
import mapsIndex from '../../../tests/fixtures/maps-index.json';
import { createStubGame } from '../lib/stub-game.js';
import { parseMapIndex } from '../lib/catalog.js';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app mount point in dev/ui-preview.html');

const game = createStubGame(
  /** @type {import('../lib/stub-game.js').StubStates} */ (/** @type {unknown} */ (hudStates)),
);
const canvas = document.createElement('canvas');
canvas.className = 'h-full w-full bg-gradient-to-b from-sky-900 to-slate-700';

export default mount(App, {
  target,
  props: { game, canvas, loadMaps: async () => parseMapIndex(mapsIndex) },
});
