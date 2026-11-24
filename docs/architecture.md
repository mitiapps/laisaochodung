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
  hold-when-blocked (`stepActors`), the NPC traffic (`src/world/traffic/`), route progress
  (`stepRoute`) and the clock. `stepWorld` is the one composite step, scripted actors then
  traffic. The sim and the kinematic frame builder (`src/testing/frame-builder.js`) both call it,
  so live frames and test frames follow the same rules.
- **Pure scorer.** The scorer is a reducer `step(state, frame) -> {state, breaches, context,
  runEnded}` with no engine or UI import. The game folds it per step; tests fold it over recorded
  or built frames with `scoreRun`, with identical results.
- **Legal data.** Penalties live once in a clause table keyed by `D6.3.a`-style ids; rules point at
  clauses. `src/generated/rules.json` is one `RulesBundle` (`src/contracts/rule.js`) and the only
  rule input the game loads. Collision clauses are chosen through `collisionPolicy`.
- **Read-only consumers.** The renderer and the HUD read frames and scorer output only.

## Traffic

NPC traffic runs on maps with a `traffic` block ([maps.md](maps.md#traffic)), in every release
run with a fresh random run seed. `createSim` defaults to traffic off, so tests opt in with
`{traffic: 'map', runSeed, params}`.

- **Traffic module (`src/world/traffic/`).** Seeded agents on the map's lane graph (lanes,
  junction connectors, conflict zones, `laneJoins`), stepped at the fixed `DT`; pure and
  deterministic in the map, the parameters, the run seed and the inputs. Each step applies
  contacts, despawns and spawns; makes lateral decisions (mandatory lane changes, MOBIL lane
  changes of cars, lateral slots of motorbikes); computes IDM accelerations against the perceived
  leader, hold points, the ego, scripted actors and static obstacles, with reaction delay,
  perception error and distraction; grants junction claims, with the ego a party to gap
  acceptance; integrates every agent in ascending spawn index in two phases; and detects NPC
  contacts. Violations (red-light runs, early starts, yellow gambles, speeding, tailgating,
  unsafe lane changes, failing to yield) are drawn per driver and latched on the pose as flags for
  `crashCauseWindowS`. The header of `src/world/traffic/index.js` gives the full step order.
- **Parameters.** Driver and vehicle parameters live once in `data/traffic/params.yaml`, every
  number with a `paramBasis`; `npm run build:traffic` (`scripts/traffic/build.js`) checks and
  compiles them to `src/generated/traffic-params.json` (`TrafficParams`,
  `src/contracts/traffic.js`). Per-map values (density, sources, sinks, mix, `maxAgents`) are in
  the map.
- **Frame actor order.** `frame.actors` lists the scripted actors in map order, then the traffic
  agents in ascending spawn index (`npc-<spawnIndex>`).
- **Mirror and contacts.** Traffic motion stays in `src/world/`. The sim mirrors the agents near
  the ego into a fixed pool of `maxMirrored` kinematic Rapier bodies (`src/sim/traffic-mirror.js`).
  When an agent's swept footprint reaches the ego, its body moves at the momentum-share velocity
  `v · m_npc / (m_npc + m_ego)` instead of following the agent, so a light rider cannot launch a
  car. The touched agent becomes a wreck on the next traffic step and stops dead; a car wrecked
  by another agent slides on, and its body follows the slide until it stops. A wreck no longer
  raises `red-light` or `no-yield`: the latch carries them for `LATCH_S`, then the wreck stands
  unflagged. Wrecks clear after `wreckClearS`. With traffic running, each `collision` event carries the striker, whether the
  other party came from behind, its latched violations and its model.
- **NPC incidents.** Contacts between agents make wrecks and a `TrafficIncident`
  (`{t, agentIds, causes}`, `src/world/traffic/contacts.js`); every incident names at least one
  latched violation as its cause. The rate is tuned into `incidentBand`.
- **Fault table and notices.** The scorer judges each ego contact with a vehicle through the
  collision policy's fault table ([rules-data.md](rules-data.md#fault-table)): a contact the
  player did not cause yields a `Notice` (shown as a toast and on the result screen) instead of a
  crash breach.
- **Windowed replay.** Dev builds check every finished run by replaying the kept frames through
  `scoreRun`. On maps with traffic they keep only the frames since the previous replay
  checkpoint (every `REPLAY_CHECKPOINT_S`, 10 s) and fold them from the scorer state saved there
  (`scoreRun(…, {initialState})`), so a long run does not keep every frame. `debugInfo()` reports
  the check, the agent count, `drawCalls`, `simStepMs` and `trafficStepMs`.

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
| `src/world/` | Light cycles, scripted actors, traffic, route progress, clock | yes |
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
missing contact channels or donate QR (`src/config/site.js`), uncredited files in `public/models/` or
`public/signs/`, a traffic model key with neither a credited model file nor a procedural builder,
an OSM map without attribution, or a missing `data/maps/LICENSE-ODbL.md`. It is
not part of CI; `npx wrangler deploy --dry-run` skips it.
