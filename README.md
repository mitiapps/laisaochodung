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
| `npm run test:e2e` | Playwright smoke tests against `vite preview` on port 5179 |
| `npm run fetch:osm` | Refreshes the raw OpenStreetMap extracts (manual) |
| `npm run deploy` | `wrangler deploy` (manual) |

`build:rules`, `build:maps`, and with them `build` and `test:e2e`, need the data pipelines in
`scripts/rules/` and `scripts/maps/`.

More: [docs/architecture.md](docs/architecture.md). Contributor rules: [CLAUDE.md](CLAUDE.md).

## Licence

Code: [Apache-2.0](LICENSE).
