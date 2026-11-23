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
and writes JSON with sorted keys, collections sorted by id and numbers rounded to millimetres, so
two builds are byte-identical.

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
  - `speed-limit` only from a placed P.127, along the lanes it faces, ending at the next junction
    or a DP.134 (QCVN 41 Điều 26.8). OSM `maxspeed` is never a zone source.
  - `no-stopping` from a placed P.130, to the next junction.
  - `built-up` from R.420. R.421 is not in the sign set, so the zone covers the whole map and
    every lane; a map without an R.420 fails the build.
  - `junction-buffer`: every junction polygon grown by 5 m, binding the lanes of its roads,
    `source: default`.
  - `lit`: the whole map when the source sets `lit: true`.
- A stop line gets one control: `signal` at a signalised junction, else `stop-sign` when an R.122
  faces the approach, else `give-way` when a W.208 does, else no line. It sits 1 m before the
  junction, or 1 m before a crosswalk within 15 m of the junction on that approach, and that
  crosswalk takes the approach's signal.
- Signals: one head per approach. Approaches on one axis share a phase; the crossing axis is
  offset by green + yellow. The default cycle (green 27 s, yellow 3 s, red 30 s) is a game value.
- P.123a bans the left turn and P.124a the U-turn at the junction the sign faces (the P.123a text
  says it does not ban U-turns). P.101 and P.102 become entries banned to all classes, across the
  carriageway at the sign, in the direction of the traffic the sign faces.
- Signs stand 1 m beyond the right edge of the carriageway of the traffic they face.
- Pavements run along both road edges (3 m by default). Building rows sit behind them and fail
  the build if they overlap a lane or a junction.
- The route start may not lie in a no-stopping or junction-buffer zone. The finish counts only
  after every checkpoint; checkpoints sit at the centre of the travel direction's lanes.

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
  and range), `junctions` (`signals`), `actors` (path along lane stretches or across a crosswalk;
  trigger at a time or over a stretch of road), `route` (start lane, checkpoints, finish),
  `environment`, `timeLimitS`, `lit`.
- `layout: <id>` reuses another tutorial's source; keys set here replace the layout's.

Actor `model` keys used: `pedestrian` and `npc-sedan`.

## OSM sources

- `source.yaml`: `kind: osm`, `name`, `bbox`, and `route` (`ways` in driving order, `start`,
  `checkpoints`, `finish`). Travel directions come from the node order of the extract; a route
  that drives a one-way way backwards fails the build.
- `raw.overpass.json`: written once by `npm run fetch:osm -- <id>` and committed. Never fetched in
  CI or on build.
- `overrides.yaml`: `environment`, `timeLimitS`, and lists that each carry a `reason`: `ways`
  (lane counts, lines, pavements), `junctions` (`signals`, `trimM`, `polygon` as `[lat, lon]`),
  `signs`, `crosswalks`, `actors`, `obstacles`. Positions are `{way, s}` or
  `{way, node, offsetM}` (offset along the travel direction) on route ways.

From the extract the converter takes highway class, `oneway`, `lanes`, `lanes:forward`,
`lanes:backward`, `sidewalk=no`, `highway=traffic_signals` nodes (each signals the nearest
junction within 30 m) and marked `highway=crossing` nodes on route ways (`crossing` of `marked`,
`zebra`, `uncontrolled` or `traffic_signals`, or `crossing:markings` other than `no`). A crossing
inside a junction cut moves to the junction edge. Missing lane tags fall back to class defaults.
Two-way roads with two or more lanes each way get a solid centre line, others a dashed one. Side
roads of class `service` (driveways, parking aisles) are not stubbed. Every OSM map carries the
attribution `© OpenStreetMap contributors, ODbL`; the data licence is in
[`data/maps/LICENSE-ODbL.md`](../data/maps/LICENSE-ODbL.md).

## Shipped maps

| Id | Teaches |
| --- | --- |
| `tutorial-01-co-ban` | R.420; one lane each way (centre line dashed, then solid) widening to two (dashed, then solid lane lines); P.127 40 zone ended by DP.134; crosswalk with a triggered pedestrian; road works in the kerb lane; P.130 stretch before a side junction; finish |
| `tutorial-02-nga-tu` | R.420; signalled crossroads with P.123a and P.124a on the approach; W.208 give-way entry onto an I.401 priority road; P.101 closed side road; one-way street (I.407a) with P.102 at its far end; R.122 STOP junction |
| `tutorial-03-ban-dem` | The tutorial-01 layout at 22:30 in rain (grip 0.7, a game value), lit; NPC car ahead, NPC car in the kerb lane, oncoming NPC cars |
| `osm-pasteur` | About 0.4 km of Pasteur and Lê Duẩn, Quận 1, TP.HCM, from OpenStreetMap |

### `osm-pasteur` corridor choice (decision D1)

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
default road therefore satisfies the D1 constraint without a fallback:

- Route ways 329878186, 747231131, 678315474 (Pasteur, `oneway=yes`, 3 lanes) from just past Lý
  Tự Trọng, through Nguyễn Du and Hàn Thuyên, then a right turn onto way 803279638 (Lê Duẩn,
  two-way, 6 lanes), driven north-east against its node order, finishing before the
  secondary_link junction near Công trường Công xã Paris.
- Signalled junction: Pasteur × Lê Duẩn (traffic_signals nodes on the Pasteur and Lê Duẩn
  approaches).
- Marked crossing: node 14118646229 (`crossing=traffic_signals`, `crossing:markings=yes`) on the
  Pasteur approach, plus others along the route.
- One-way street: Pasteur. Turn between two mapped ways: Pasteur → Lê Duẩn.

None of the extract's 17 traffic_signals nodes lies within 30 m of Pasteur × Nguyễn Du (nearest
146 m) or Pasteur × Hàn Thuyên, so those junctions have no stop lines in the game. Way 678315474 is tagged `sidewalk=no`, so it has no
pavement. The extract has no traffic signs, so the only placed sign is the R.420 at the start
(see `overrides.yaml`); no speed-limit zone exists and the TT 38 defaults apply.
