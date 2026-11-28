# Maps

The game ships built map JSON (`public/maps/<id>.json`, contract in `src/contracts/map.js`) and
an index (`public/maps/index.json`, `MapIndexEntry[]`). Both are generated; the sources live in
`data/maps/<id>/`. The runtime never calls OpenStreetMap.

```sh
npm run build:maps              # build every map; exits non-zero on any error
npm run fetch:osm -- <map-id>   # manual, once per OSM map; commit the extract it writes
npx vitest run scripts/maps     # converter tests, snapshots and byte-stability check
```

## Converter

`scripts/maps/build.js` reads every `data/maps/*/source.yaml`, converts it with
`scripts/maps/lib/`, checks it with `assertMap` against the sign codes in `data/signs/signs.yaml`,
and writes JSON with sorted keys, collections sorted by id and numbers rounded to millimetres
(1e-7° under `origin`, 1e-9 for a traffic mix `share`, so shares still sum to 1), so two builds
are byte-identical.

| Module | Job |
| --- | --- |
| `project.js` | Local tangent plane around the bbox centre: `x = R·Δλ·cos φ0`, `z = −R·Δφ` |
| `graph.js` | Network model; OSM corridor (route ways plus 30 m side-road stubs); split into roads and junctions |
| `lanes.js` | Lane polygons and centrelines, lane lines, junction polygons from road ends |
| `zones.js` | Speed-limit, built-up, no-stopping, junction-buffer and lit zones |
| `elements.js` | Stop lines and their control, signals, crosswalks, restrictions, entries, signs, pavements, obstacles, actors, route |
| `source.js` | Tutorial and OSM sources to one normalised spec |

### Rules the converter applies

- Lanes are 3.5 m. On a two-way road the forward lanes lie right of the way's reference line
  (its node order) and the backward lanes left of it; a one-way road is centred on it. Lane
  centrelines run in the direction of travel.
- Junctions are nodes where three or more way ends meet. Junction nodes joined by a way shorter
  than 15 m merge into one junction. Roads are cut back from a junction by its widest half
  carriageway plus 1 m; the junction polygon is the convex hull of the road ends. A road shorter
  than its two cuts fails the build with the way id; an OSM override can set `trimM` or a
  hand-placed `polygon` for that junction.
- Zones, each with its `source` and the `laneIds` it binds:
  - `speed-limit` only from a placed P.127, along the lanes it faces, ending at the next junction,
    a DP.134 or the next P.127 facing the same traffic (QCVN 41 Điều 26.8). OSM `maxspeed` is never a zone source.
  - `no-stopping` from a placed P.130, to the next junction.
  - `built-up` from R.420. R.421 is not in the sign set, so the zone covers the whole map and
    every lane; a map without an R.420 fails the build.
  - `junction-buffer`: every junction polygon grown by 5 m, binding the lanes of its roads,
    `source: default`.
  - `lit`: the whole map when the source sets `lit: true`.
- A stop line gets one control: `signal` at a signalised junction, else `stop-sign` when an R.122
  faces the approach, else `give-way` when a W.208 does, else no line. Junction markings, signal
  heads and the light cycle are in [Junctions](#junctions).
- P.123a bans the left turn and P.124a the U-turn at the junction the sign faces (the P.123a text
  says it does not ban U-turns). P.101 and P.102 become entries banned to all classes, across the
  carriageway at the sign, in the direction of the traffic the sign faces.
- Signs stand 1 m beyond the right edge of the carriageway of the traffic they face.
- Pavements run along both road edges (3 m by default). Building rows sit behind them and fail
  the build if they overlap a lane or a junction.
- The route start may not lie in a no-stopping or junction-buffer zone. The finish counts only
  after every checkpoint. A checkpoint sits at the centre of the lane it names (`lane`, index 0
  next to the kerb, as for the start); on a direction with one lane `lane` may be left out. A
  checkpoint without `lane` on a multi-lane direction fails the build, because the nav arrow
  points at the gate centre and the middle of two lanes is the lane line. After the last
  checkpoint the arrow points at the finish band straight ahead of it (`finishTarget`), in the
  lane the route arrives in. A lane change is drawn by two checkpoints on one straight road in
  different lanes, where the lane line is dashed; the test drivers signal it.
- Where a junction is trimmed back further than the pavements reach (a large `trimM`), the gap
  between two arms' pavement ends and the junction's chamfer gets a corner pavement
  (`pv-<junction>-c<n>`), so the kerb wraps the corner.

### Junctions

Built to QCVN 41:2024 (`scripts/maps/lib/elements.js`, `lane-arrows.js`; render in
`src/render/traffic-lights.js` and `markings.js`). Marking sizes are build and render constants
tagged "2019 text = 2026 draft"; thresholds the standard does not give are `design`.

- **Cycle.** `DEFAULT_CYCLE` is green 25 s, yellow 3 s, red 32 s (period 60 s). Approaches on one
  axis share a phase; the crossing axis runs half a period (30 s) later, so each change has 2 s of
  all-red. A written cycle must keep red ≥ green + yellow + 4 s, or the build fails.
- **Heads.** The near-side head stands on the right post at the stop line, lowest lamp 2.5 m.
  Every signalised approach also gets a far-side repeater (`Signal.repeaters`), 1.5 m past the
  junction on the right of its straight-on line: a post (lowest lamp 2.5 m) for one lane, a mast
  arm (lowest lamp 5.5 m, head over the middle of the lanes, arm at most 7 m) for two or more. A
  base that lands on a lane or junction slides up to 6 m along the heading, else the repeater is
  dropped and logged. Every head carries a countdown (red digits on red, green on green, blank on
  yellow), 1.5 × on the far heads.
- **Crosswalks.** Every arm of 20 m or more at a signalised junction gets a 4 m zebra 0.5 m from
  the road end, unless a source crosswalk lies within 15 m of that end (shorter arms are logged).
  OSM crossings are taken on every corridor way, stubs included. An OSM crossing within 15 m of a
  junction end is that junction's crosswalk and is drawn at the junction edge, 0.5 m from the road
  end, where a derived zebra would go: the game junction has no corner radii, so the surveyed
  offset would leave a dead stretch before the stop line. An OSM crossing farther out stays where
  surveyed, as a mid-block crossing; an authored crosswalk always stays where it is written.
  `Crosswalk.walkSignalId` names a signal of the other axis, whose green times the pedestrian
  heads (flashing for its last 5 s).
- **Stop line.** 30 cm wide, 2.0 m before the junction's crosswalk on that approach (G2.1:
  1.5–3.0 m), which takes the approach's signal; 1 m before the road end where there is none. On
  every signalised arm of 20 m or more the line is therefore 6.5 m from the road end.
- **Solid approach.** The last `min(30 m, 40 % of the road)` before any stop line: lane lines turn
  white solid (2.2) and a two-way centre line yellow solid (1.2). Written `laneLine` and
  `centerLine` stretches win. Lane and centre lines end at the stop line, or at the crosswalk edge
  where there is none; nothing is painted through a zebra.
- **Lane arrows (9.3).** On every approach with a stop line and two or more lanes: one arrow per
  lane, its tip 15 m before the line, with the turns of the connectors leaving that lane; lanes
  under 25 m get none.
- **STOP word (9.5a) and give-way (7.2).** Per lane at every `stop-sign` line, letters 1.6 m high
  2.5 m before it; at a `give-way` line, two 20 cm dashed lines and an inverted triangle per lane.
- **Not built:** arrow lenses, right turn on red, a motorbike box, new sign codes, and stop or
  give-way lines at uncontrolled junctions (priority to the right applies).
- **Pasteur × Nguyễn Du** (`j-n411919306`) on `osm-pasteur` is signalised by override, a game
  decision not checked on the street (see `overrides.yaml`). Pasteur × Hàn Thuyên stays
  unsignalised; its tagged crossings become zebras.

Game values (lane width, crosswalk width 4 m, pavement width, light cycle, class lane defaults,
cluster and stub lengths) are constants at the top of the `lib/` modules.

## Tutorial sources

Hand-written, in metres (+x east, +z south): `nodes` (`id: [x, z]`) and `ways` (`id`, `nodes`,
`lanes: {forward, backward}`, `oneway`, `priority`, `centerLine`, `laneLine`, `pavement`).
Everything else is placed by way and distance, so authors write no polygons:

- `at: {way, s}`: `s` metres along the way from its first node; `dir` (`forward` or `backward`,
  relative to the node order, default `forward`) is the traffic a sign faces.
- `centerLine` and `laneLine` are a type (`dashed`, `solid`, `double-solid`, `mixed`) or stretches
  `[{toS: 150, type: dashed}, {type: solid}]`; a `mixed` line names its `crossable` side.
- `signs`, `crosswalks`, `obstacles` (`lateral` offset, positive left), `buildings` (rows by side
  and range), `junctions` (`signals`), `actors` (kind `pedestrian`, `car` or `motorbike`, optional
  `violations`, path along lane stretches or across a crosswalk; trigger at a time or over a
  stretch of road), `route` (start lane, checkpoints with their lane, finish),
  `environment`, `timeLimitS`, `lit`.
- `layout: <id>` reuses another tutorial's source; keys set here replace the layout's.

Actor `model` keys used: `pedestrian` and `npc-sedan`. A scripted actor that ends its path on a
lane stays there as a parked vehicle: it closes that lane, and traffic changes lane round it. A car
that moves against the lane it is on carries `wrong-way`. An actor of kind `motorbike` is drawn as a
ridden motorbike. An actor may also declare `violations` (names from `NPC_VIOLATIONS`), which its pose
carries while the actor is active; the build rejects any other name. Declared flags drive no
behaviour: the fault table reads them on a contact, and the actor runs no light and changes no lane.

Street dressing, on tutorial and OSM sources alike:

- `buildings`: rows `{way, side, fromS, toS, heightM?}` become shophouse rows (OSM maps import
  the extract's building footprints instead). Every pavement edge left without a building gets
  generated shophouse rows, seeded by the map id.
- `props`: fixed props `{id, kind, way, side, s, offsetM?}`, with `kind` one of the map
  contract's `PROP_KINDS` (tree, lamp, power pole, cabinet, bin, bus stop, stall,
  parked motorbikes…) and `offsetM` from the kerb to the prop centre. The build adds a seeded
  fill along every pavement; no prop overlaps a lane, junction, building, sign post, crosswalk
  landing or another prop, and each pavement keeps a 1.5 m clear walking strip.
- `stubM` (OSM sources): how far side-road stubs reach from the route corridor, 30 m by default.
  The build logs every stub kept shorter.

## Traffic

A `traffic` key in `source.yaml` turns NPC traffic on for the map (`scripts/maps/lib/traffic.js`).
It is not inherited through `layout`.

```yaml
traffic:
  densityPerKm: 30            # agents per lane-km on every road (design)
  spawnRingM: [60, 150]       # inner and outer radius of the ring spawner around the ego
  mix:                        # model shares of new agents, summing to 1
    - { model: motorbike, share: 0.75 }
    - { model: car, share: 0.12 }
  seed: 123                   # optional map seed; default a hash of the map id
  roadDensityPerKm: { cam: 0 }        # optional per-road overrides
  sourceRatePerH: { cam-b0: 0 }       # optional per-source overrides
```

The build derives the rest of the map's `traffic` block:

- **Sources and sinks:** every lane start on the map boundary is a source, emitting
  `densityPerKm × 25 km/h` agents per hour unless overridden; every lane end there is a sink.
- **`maxAgents`:** the most agents the ring spawner can hold, the largest sum of density times
  lane length within the outer ring over ego positions every 10 m along the route.
- **`timeLimitS`:** never below the authored one, and at least
  `⌈1.25 · (L / 15 km/h + Σ waits)⌉` rounded up to 10 s, with `L` the route through the lane graph
  and a full light cycle per signalled approach or 10 s per other junction crossed (all design).
- **Lane graph:** junction `connectors` with their `conflicts`, and `laneJoins`, plain joins where
  a lane's end meets the start of a lane of another road (within 0.1 m) with no junction, such as
  where a road widens. Traffic runs straight on through a join with no hold point and no claim. A
  lane end that is neither a sink, a connector start nor a join start is a dead end, where agents
  stop and despawn once out of view.

Driver and vehicle parameters are not per map: they live in `data/traffic/params.yaml`, compiled
by `npm run build:traffic` to `src/generated/traffic-params.json`. Every number there needs a
`paramBasis` entry (`design` or a listed source). Groups: `classes` (IDM and gap-acceptance values
per vehicle class), `models` (size, mass and variants per model key), `personalities` (driver
shares and factors), `humanFactors` (perception drift, distraction), `violations` (how rule
breaking is drawn), `motorbike` (lateral slots and filtering), `behaviour` (turn weights, lane
changes, junction deadlock breaking, rain braking), `incidentBand`, the mirror limits
(`mirrorRadiusM`, `maxMirrored`), wreck clearing and spawn and despawn distances. Every model key
of a map's `mix` must be a key of `models`, and the release gate checks that each one draws from a
credited model file or a procedural builder. The build also adds `speedDefaults`, the TT 38
default limits copied from `data/legal/speed-defaults.yaml` without their citations (no
`paramBasis`; a `speedDefaults` key in `params.yaml` fails the build). Agents drive at a share of
the lane's P.127 limit, else of the TT 38 default for their legal class, as the scorer reads it,
and the `speeding` flag uses the same limit.

## OSM sources

- `source.yaml`: `kind: osm`, `name`, `bbox`, and `route` (`ways` in driving order, `start`,
  `checkpoints`, `finish`). Travel directions come from the node order of the extract; a route
  that drives a one-way way backwards fails the build.
- `raw.overpass.json`: written once by `npm run fetch:osm -- <id>` and committed. Never fetched in
  CI or on build. An Overpass answer whose `remark` reports a runtime error (a truncated extract)
  counts as a failed attempt: the fetch retries, then fails without writing the file.
- `overrides.yaml`: `environment`, `timeLimitS`, and lists that each carry a `reason`: `ways`
  (lane counts, lines, pavements), `junctions` (`signals`, `trimM`, `polygon` as `[lat, lon]`),
  `signs`, `crosswalks`, `actors`, `obstacles`. Positions are `{way, s}` or
  `{way, node, offsetM}` (offset along the travel direction) on route ways.

From the extract the converter takes highway class, `oneway`, `lanes`, `lanes:forward`,
`lanes:backward`, `sidewalk=no`, `highway=traffic_signals` nodes (each signals the nearest
junction within 30 m) and marked `highway=crossing` nodes on every corridor way (`crossing` of `marked`,
`zebra`, `uncontrolled` or `traffic_signals`, or `crossing:markings` other than `no`). A crossing
inside a junction cut, or within 15 m of a junction end, moves to the junction edge. Missing lane tags fall back to class defaults.
Two-way roads with two or more lanes each way get a solid centre line, others a dashed one. Side
roads of class `service` (driveways, parking aisles) are not stubbed. Every OSM map carries the
attribution `© OpenStreetMap contributors, ODbL`; the data licence is in
[`data/maps/LICENSE-ODbL.md`](../data/maps/LICENSE-ODbL.md).

## Shipped maps

| Id | Teaches |
| --- | --- |
| `tutorial-01-co-ban` | R.420; one lane each way (centre line dashed, then solid) widening to two (dashed, then solid lane lines); P.127 40 zone ended by DP.134; crosswalk with a triggered pedestrian; road works in the inner lane, so the route moves to the kerb lane while the lane line is dashed; P.130 stretch before a side junction; finish |
| `tutorial-02-nga-tu` | R.420; signalled crossroads with P.123a and P.124a on the approach; W.208 give-way entry onto an I.401 priority road; P.101 closed side road; one-way street (I.407a) with P.102 at its far end; R.122 STOP junction; right turns kerb lane to kerb lane at the two one-way junctions, widened with `trimM: 8`; light traffic |
| `tutorial-03-ban-dem` | The tutorial-01 roads at 22:30 in rain (grip 0.7, a game value), lit, with its own road works (kerb lane) and route (inner lane); NPC car ahead, NPC car in the kerb lane, oncoming NPC cars; light traffic |
| `osm-pasteur` | About 0.4 km of Pasteur and Lê Duẩn, Quận 1, TP.HCM, from OpenStreetMap; full inner-city traffic |

Traffic: `tutorial-01-co-ban` has none; `tutorial-02-nga-tu` and `tutorial-03-ban-dem` run light
traffic (10 agents per lane-km, `maxAgents` 12 and 14); `osm-pasteur` runs 30 per lane-km
(`maxAgents` 85). Every map with traffic mixes 75% motorbikes, 12% cars, 6% taxis, 5% trucks and
2% buses. On `tutorial-02-nga-tu` the closed road (P.101) has no source and no agents.

On `osm-pasteur` about half of the traffic stands at any moment, and that is the signals, not a
jam: every signal runs 25 s green, 3 s yellow and 32 s red, and the blocks between signals are
61 to 109 m long, so a red holds a queue that fills much of its block. The signal on the 11 m link
`w803279638-1` keeps its queue on `w803279638-2`, before the unsignalled junction between the two,
so that junction stays clear; that queue is traffic standing on a lane with no signal of its own.

### `osm-pasteur` corridor choice

The OSM corridor is at most 1.2 km and must hold one signalled junction, one marked crossing, one
one-way street and one turn between two mapped ways. The default road is Pasteur in its legal
(one-way) direction, turning onto Lê Duẩn.

Extract: bbox 10.7755–10.7812 N, 106.6955–106.7012 E, fetched 2026-11-23 (OSM base
`2026-11-23T04:40:13Z`). Coverage printed by the fetch:

```
ways: 112
  lanes: 42/112
  oneway: 48/112
  lit: 9/112
signal nodes (highway=traffic_signals): 17
crossing nodes (highway=crossing): 55
  (untagged): 3
  marked: 9
  traffic_signals: 8
  uncontrolled: 33
  zebra: 2
stop / give_way nodes: 0
traffic_sign nodes: 0
maxspeed hints (never a zone source; place a P.127 in overrides.yaml if a sign exists):
  50: 7 ways
  60: 13 ways
```

The extract's node order puts Pasteur's one-way direction north-west (towards Quận 3). The
default road therefore meets that constraint without a fallback:

- Route ways 329878186, 747231131, 678315474 (Pasteur, `oneway=yes`, 3 lanes) from just past Lý
  Tự Trọng, through Nguyễn Du and Hàn Thuyên, then a right turn onto way 803279638 (Lê Duẩn,
  two-way, 6 lanes), driven north-east against its node order, finishing before the
  secondary_link junction near Công trường Công xã Paris.
- Signalled junction: Pasteur × Lê Duẩn (traffic_signals nodes on the Pasteur and Lê Duẩn
  approaches).
- Marked crossing: node 14118646229 (`crossing=traffic_signals`, `crossing:markings=yes`) on the
  Pasteur approach, plus others along the route.
- One-way street: Pasteur. Turn between two mapped ways: Pasteur → Lê Duẩn.
- The route moves from the middle lane to the kerb lane mid-block on way 747231131, where the
  lane lines are dashed, and leaves the right turn in Lê Duẩn's kerb lane (Law 36 Điều 15
  khoản 2: before a turn, move to the lane nearest the turn).

None of the extract's 17 traffic_signals nodes lies within 30 m of Pasteur × Nguyễn Du (nearest
146 m) or Pasteur × Hàn Thuyên. Nguyễn Du is signalised by override (see [Junctions](#junctions));
Hàn Thuyên has no stop lines in the game. Way 678315474 is tagged `sidewalk=no`, so it has no
pavement. The extract has no traffic signs, so the only placed sign is the R.420 at the start
(see `overrides.yaml`); no speed-limit zone exists and the TT 38 defaults apply, to the player and to traffic.
