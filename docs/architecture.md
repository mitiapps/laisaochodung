# Architecture

## Data flow

```
ControlInput ─► sim.step (physics + src/world, fixed DT) ─► Frame ─┬─► scorer.step ─► Breach[], ScoreContext, runEnded ─► HudState ─► Svelte HUD
frame-builder (src/world, no physics) ─► Frame ──────────────────┘    (tests only)
map JSON ─────► sim, renderer, scorer, frame-builder (read-only)    └─► renderer.render(prev, curr, alpha)
rules JSON (rules + clauses + collisionPolicy) ─► scorer
```

- **Fixed step.** Physics and the world simulation advance at `DT = 1/60` s and emit one
  plain-JSON `Frame` per step (`src/contracts/telemetry.js`): ego state, actor poses, traffic-light
  states, route navigation, clock and events.
- **Shared world logic.** `src/world/` holds light cycles (`signalState`), scripted actors with
  hold-when-blocked (`stepActors`), route progress (`stepRoute`) and the clock. The sim and the
  kinematic frame builder (`src/testing/frame-builder.js`) both call it, so live frames and test
  frames follow the same rules.
- **Pure scorer.** The scorer is a reducer `step(state, frame) -> {state, breaches, context,
  runEnded}` with no engine or UI import. The game folds it per step; tests fold it over recorded
  or built frames with `scoreRun`, with identical results.
- **Legal data.** Penalties live once in a clause table keyed by `D6.3.a`-style ids; rules point at
  clauses. `src/generated/rules.json` is one `RulesBundle` (`src/contracts/rule.js`) and the only
  rule input the game loads. Collision clauses are chosen through `collisionPolicy`.
- **Read-only consumers.** The renderer and the HUD read frames and scorer output only.

## Conventions

Defined in `src/contracts/units.js` and the typedef comments:

- Metres, seconds, radians; m/s in frames, km/h only for display, rule parameters and zone values.
- Axes: +X east, +Y up, +Z south. Heading θ: forward = (cos θ, 0, −sin θ); 0 east, π/2 north.
  Right-hand traffic.
- Polygons are rings of `[x, z]` listed once (closing edge implied). Lane centrelines run in the
  direction of travel. Footprints list corners front-left, front-right, rear-right, rear-left.
- Light cycles run green → yellow → red; `offset` is the cycle position at `t = 0`.
- `reset` and `fall` events are discontinuities: no episode, previous position or line-crossing
  test spans them. The one exception is the crash episode, which a `fall` (not a `reset`) leaves
  open so that a contact followed by a fall is one episode; a crash on the fall's own step may
  still take its cause from before the fall.

## Modules

| Directory | Role | Pure |
| --- | --- | --- |
| `src/contracts/` | JSDoc typedefs, constants, `assertFrame`, `assertMap` | yes |
| `src/geometry/` | Ground-plane geometry: polygons, segments, polylines, footprints | yes |
| `src/world/` | Light cycles, actors, route progress, clock | yes |
| `src/testing/` | Kinematic frame builder for tests | yes |
| `src/rules/`, `src/scoring/`, `src/map-query/` | Rule validation, scorer, map lookups | yes |
| `src/physics/`, `src/sim/` | Rapier vehicle and the headless sim | no |
| `src/render/` | Three.js renderer | no |
| `src/ui/`, `src/App.svelte` | Svelte screens and HUD | no |
| `src/game/`, `src/main.js` | Integration: loop, input, `GameApi` | no |
| `scripts/` | Build-time data pipelines (Node) | no |

The purity rules are enforced by ESLint; see [CLAUDE.md](../CLAUDE.md).

## Deployment

`wrangler.jsonc` deploys `dist/` as static assets with no Worker script, routes or custom domain.
Routing is hash-only (`#/...`), so there is no single-page fallback: a missing asset is a real 404.
`public/_headers` sets the Content-Security-Policy and other security headers; `vite preview`
applies the same file, so the Playwright smoke test runs under the policy. The build also emits
`third-party-licenses.md` (Vite `build.license`), linked from the credits page.

`npm run deploy` first runs `predeploy`: `npm run build`, then `npm run release:check`
(`scripts/release-check.js`). The gate fails on unverified legal data, unchecked sign figures,
unset contact or donate settings (`src/config/site.js`), uncredited files in `public/models/` or
`public/signs/`, an OSM map without attribution, or a missing `data/maps/LICENSE-ODbL.md`. It is
not part of CI; `npx wrangler deploy --dry-run` skips it.
