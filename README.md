# Lái sao cho đúng

A browser driving game on Vietnamese traffic law. Pick a car or a scooter, drive a map from
start to finish through Ho Chi Minh City traffic (mostly motorbikes, some of them reckless), and
get a score out of 10. Every breach shows its real penalty under Nghị định 168/2024/NĐ-CP, with
the cited text; a crash someone else caused is a notice, not a deduction.

Controls follow a cabin, left to right: W/S or the arrows to drive and brake, A/D to steer, Q/E
for the indicators, Z/X for the lights, F for the horn, H for the hazard lights, I/K (or Page
Up/Down) for the car's gears, L for its handbrake, Space for the scooter's rear brake, V to switch
between the chase and the first-person camera, Esc to pause. Every key is also an on-screen
button. Two presets: Đơn giản (the default: automatic gears, one brake key for the scooter,
indicators that cancel after a turn) and Thực tế (manual gears, separate brakes); the preset never
changes the score. See [docs/controls.md](docs/controls.md).

Plain JavaScript with JSDoc, Svelte 5, Vite, Tailwind CSS 4, Three.js and Rapier. A static site,
with no backend, on Cloudflare Pages and GitHub Pages.

## Quick start

Requires Node 24.15 or later (npm 11).

```zsh
npm ci
npm run dev        # Vite dev server
npm run lint       # ESLint, including the purity guard
npm test           # Vitest (Node); TRAFFIC_LONG=1 runs the full traffic seed sweeps
```

| Script | Does |
| --- | --- |
| `npm run build` | Builds rules and map data, runs the release gate, then the Vite bundle into `dist/` |
| `npm run build:rules` / `build:traffic` / `build:maps` | Compiles `data/` YAML into JSON (`src/generated/`, `public/maps/`) |
| `npm run test:e2e` | Builds, then runs the Playwright tests (smoke, controls, full car and scooter runs of tutorial 01, traffic on `osm-pasteur`, the toast stack on the dev UI preview; about 6 min) against a fresh `vite preview` on port 5179 and, for the traffic diagnostics and the UI preview, `vite` dev on 5180 (both must be free; `E2E_PORT`, `E2E_DEV_PORT` and `E2E_SERVERS` in `playwright.config.js` move or split them) |
| `npm run fetch:osm` | Refreshes the raw OpenStreetMap extracts (manual) |
| `npm run release:check` | Release gate: verified legal data, checked sign figures, site settings, credits, traffic models, OSM licence |

More: [docs/architecture.md](docs/architecture.md). Known limits:
[docs/known-issues.md](docs/known-issues.md). Contributor rules: [CLAUDE.md](CLAUDE.md).

## Licence

- Code: [Apache-2.0](LICENSE).
- OpenStreetMap-derived map data (`data/maps/osm-*`, built into `public/maps/`): © OpenStreetMap
  contributors, [ODbL 1.0](data/maps/LICENSE-ODbL.md).
- 3D models and sign drawings: listed with their licences in
  [data/credits/credits.json](data/credits/credits.json) (Kenney models are CC0 1.0; the Tripo AI
  vehicle models are CC BY 4.0; the sign drawings are this project's own, Apache-2.0).
