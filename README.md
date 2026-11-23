# Lái sao cho đúng

A browser driving game on Vietnamese traffic law. Pick a car or a scooter, drive a map from
start to finish, and get a score out of 10. Every breach shows its real penalty under
Nghị định 168/2024/NĐ-CP, with the cited text.

Plain JavaScript with JSDoc, Svelte 5, Vite, Tailwind CSS 4, Three.js and Rapier. Static assets
on Cloudflare Workers.

## Quick start

Requires Node 24.15 or later (npm 11).

```zsh
npm ci
npm run dev        # Vite dev server
npm run lint       # ESLint, including the purity guard
npm test           # Vitest (Node)
```

| Script | Does |
| --- | --- |
| `npm run build` | Builds rules and map data, then the Vite bundle into `dist/` |
| `npm run build:rules` / `build:maps` | Compiles `data/` YAML into JSON (`src/generated/`, `public/maps/`) |
| `npm run test:e2e` | Builds, then runs the Playwright smoke test against a fresh `vite preview` on port 5179 (which must be free) |
| `npm run fetch:osm` | Refreshes the raw OpenStreetMap extracts (manual) |
| `npm run release:check` | Release gate: verified legal data, checked sign figures, site settings, credits, OSM licence |
| `npm run deploy` | Builds, runs the release gate, then `wrangler deploy` (manual) |

More: [docs/architecture.md](docs/architecture.md). Known limits:
[docs/known-issues.md](docs/known-issues.md). Contributor rules: [CLAUDE.md](CLAUDE.md).

## Licence

- Code: [Apache-2.0](LICENSE).
- OpenStreetMap-derived map data (`data/maps/osm-*`, built into `public/maps/`): © OpenStreetMap
  contributors, [ODbL 1.0](data/maps/LICENSE-ODbL.md).
- 3D models and sign drawings: listed with their licences in
  [data/credits/credits.json](data/credits/credits.json) (Kenney models are CC0 1.0; the sign
  drawings are this project's own, Apache-2.0).
