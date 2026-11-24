# Assets

Every file under `public/models/` and `public/signs/` has a record in
[`data/credits/credits.json`](../data/credits/credits.json) (`Credit[]`, `src/contracts/catalog.js`).
`src/render/assets-coverage.test.js` fails when a shipped file lacks a record, a record names a
missing file, a CC BY record lacks its credit line, or the model payload reaches 5 MB.

## Models

| Files | Source | Licence | Used as |
| --- | --- | --- | --- |
| `models/car-kit/sedan.glb` | [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Player car (`car-sedan`); traffic `car` |
| `models/car-kit/taxi.glb`, `hatchback-sports.glb` | same | CC0 1.0 | Scripted cars (`npc-sedan`, `npc-hatchback`); traffic `taxi` and `car` |
| `models/car-kit/suv.glb` | same | CC0 1.0 | Traffic `car` |
| `models/car-kit/van.glb`, `truck.glb`, `delivery.glb`, `truck-flat.glb` | same | CC0 1.0 | Traffic `truck` |
| `models/car-kit/debris-bumper.glb`, `debris-door.glb`, `debris-tire.glb` | same | CC0 1.0 | Debris beside a wreck |
| `models/car-kit/Textures/colormap.png` | same | CC0 1.0 | Shared texture the Car Kit GLBs reference by relative path |
| `models/mini-characters/character-male-b.glb`, `character-female-b.glb` | [Kenney Mini Characters 2.0](https://kenney.nl/assets/mini-characters) | CC0 1.0 | Motorbike riders (`drive` clip baked), the player's rider, fallen riders (`die` clip) |
| `models/mini-characters/character-female-e.glb` | same | CC0 1.0 | Pillion passengers (`sit` clip baked); a pedestrian |
| `models/mini-characters/character-male-a.glb`, `character-female-c.glb`, `character-male-e.glb` | same | CC0 1.0 | Scripted pedestrians (`walk` and `idle` clips) |
| `models/mini-characters/Textures/colormap.png` | same | CC0 1.0 | The characters' texture, also sampled by the procedural motorbikes and bus |
| `models/city-kit/roads/light-curved.glb`, `light-square.glb`, `electricity-pole.glb`, `electricity-wires.glb`, `dumpster.glb`, `Textures/colormap.png` | [Kenney City Kit Roads 2.2](https://kenney.nl/assets/city-kit-roads) | CC0 1.0 | Street props |
| `models/city-kit/commercial/detail-awning.glb`, `detail-awning-wide.glb`, `detail-parasol-a.glb`, `detail-parasol-b.glb`, `Textures/colormap.png` | [Kenney City Kit Commercial 2.1](https://kenney.nl/assets/city-kit-commercial) | CC0 1.0 | Shop-front props |
| `models/city-kit/suburban/tree-large.glb`, `tree-small.glb`, `planter.glb`, `Textures/colormap.png` | [Kenney City Kit Suburban 2.0](https://kenney.nl/assets/city-kit-suburban) | CC0 1.0 | Trees and planters |

The licences were read on each Kenney page and in each kit's `License.txt`. Each kit ships its own
`colormap.png` under the same relative name, so each City Kit has its own folder. The Car Kit GLBs
face +Z with left at +X, and each wheel is a separate node (`wheel-front-left`,
`wheel-front-right`, `wheel-back-left`, `wheel-back-right`).

### Procedural models

No CC0 motor scooter or city bus exists in the Kenney style, so these are our own code
(Apache-2.0 with the game), built in `src/render/vehicles/`:

- `motorbike.js`: a scooter (xe tay ga) and an underbone (xe số), extruded side-profile outlines
  (body, seat, leg shield, mudguards) plus rods, 500–550 triangles each without the two separate
  wheels. Traffic motorbikes and the player's scooter use them, with a baked rider.
- `bus.js`: a 10.5 m city bus in a green and white livery.

Their UVs point at cells of the Mini Characters colour map, so a motorbike and its baked rider
share one material and one draw call.

### Riders, pedestrians and paint

- `src/render/rider-bake.js` poses a Mini Character on the CPU and bakes it into static geometry,
  with adult proportions (smaller head, longer legs, torso and arms) and a helmet. Scripted
  pedestrians stay skinned and animated, at most 8 at once.
- Variant colours touch only the paint: Car Kit bodies list their paint cells of the colour map
  (`KENNEY_BODIES` in `src/render/vehicles/index.js`), and the shader patch in
  `src/render/vehicles/look-material.js` repaints only those texels, so glass, tyres and lamps
  keep their colour.

Any vehicle whose GLB is missing or fails to load is drawn as a generated box car of its footprint
size, and the console shows the error; a rider or passenger that fails to load is left out.

### Adding a model

1. Check the licence on the source page itself; prefer CC0. Note what you checked.
2. Export GLB facing +Z with left at +X and separate wheel nodes, or set `wheelNodes: []` to get
   generated wheels.
3. Copy it under `public/models/` and add its `Credit` record. A CC BY work needs the exact
   `creditLine`.
4. Point a config at it: a vehicle in `src/render/vehicles/<vehicleId>.js` (registered in
   `src/render/vehicles/index.js`), or a Car Kit body in `KENNEY_BODIES` with its paint cells and
   a model key that uses it in `resolveLook`. The renderer scales the model per axis to the
   footprint (width on X, length on Z), stands it on the ground and turns it to +X forward.

## Signs

Own drawings, Apache-2.0, one SVG per code of `data/signs/signs.yaml`, named by the code as written
(`public/signs/P.127.svg`). Plate sizes follow QCVN 41:2024/BGTVT Điều 12, Bảng 1 (round D 700 with
a 100 red border, or a 50 blue one on DP.134 per Phụ lục M, triangle L 700 with a 50 border, octagon D 600); `src/render/sign-art.js` holds the
size and shape per code. P.127 and DP.134 get the map sign `value` painted on at runtime.

Names and codes were checked against the sign table. Each drawing was compared with its figure in
the official annex (Phụ lục B to E) and, where the annex gives one, the dimensioned drawing in
Phụ lục M (in units of z; z = 50 or 70 for urban roads). Where neither gives a dimension, the
proportions were measured on the annex figure. The date is `figureChecked` in
`data/signs/signs.yaml`.

| Code | Name | Official figure | Figure compared |
| --- | --- | --- | --- |
| P.101 | Đường cấm | Hình B.1 | 2026-11-23 |
| P.102 | Cấm đi ngược chiều | Hình B.2 | 2026-11-23 |
| P.123a | Cấm rẽ trái | Hình B.23 a) | 2026-11-23 |
| P.124a | Cấm quay đầu xe | Hình B.24 a) | 2026-11-23 |
| P.127 | Tốc độ tối đa cho phép | Hình B.27b | 2026-11-23 |
| DP.134 | Hết tốc độ tối đa cho phép | Hình B.34, Phụ lục M | 2026-11-23 |
| P.130 | Cấm dừng xe và đỗ xe | Hình B.30 | 2026-11-23 |
| R.122 | Dừng lại | Hình D.1 | 2026-11-23 |
| R.420 | Bắt đầu khu đông dân cư | Hình D.19, Phụ lục M | 2026-11-23 |
| W.208 | Giao nhau với đường ưu tiên (đường chính) | Hình C.10 | 2026-11-23 |
| I.401 | Bắt đầu đường ưu tiên | Hình E.1 | 2026-11-23 |
| I.407a | Đường một chiều | Hình E.7 a), Phụ lục M | 2026-11-23 |

R.420 uses the Phụ lục M plate, 24z x 20z at z = 50 (1.2 x 1.0 m). DP.134 paints its runtime value
black and redraws the stripe band over it (`bandOver` in `src/render/sign-art.js`), as the official
figure layers it.

Known difference from the official figures:

- **P.127, DP.134**: the runtime value uses bold Arial at 0.4 of the plate height (digits about
  200 mm tall), not the condensed sign typeface of Phụ lục K; Phụ lục M boxes the DP.134 "50" at
  5z x 4,6z (350 x 322 mm at z = 70). The SVGs carry no digits, so this does not hold back
  `figureChecked` for P.127.

### Adding a sign

A new code is added to `data/signs/signs.yaml` first (through the maintainer). Then draw
`public/signs/<code>.svg` with a `viewBox` in millimetres and explicit `width`/`height` in pixels,
add its row to `SIGN_ART`, its `Credit` record, and its row above.

## Road markings

Markings are generated from map data in `src/render/markings.js`: centre lines 1.1–1.4 (yellow,
between opposing lanes), lane lines 2.1–2.2 (white), stop line 7.1, give-way line 7.2 and zebra
7.3. The 15 cm width and the dash ratios of 1.1 (1:2) and 2.1 (1:3) follow QCVN 41 Phụ lục G; the
same width for the other lines, dash lengths, stripe widths, the stop-line width and the 7.2 pattern are drawing choices until
compared with the annex figures.

## Preview

`dev/render-preview.html` plays the fixture frames on the fixture map in `npm run dev`
(`/dev/render-preview.html`). Its query options (vehicle, night, rain, lights, indicators, skid,
shift) are listed at the top of the file; the status line shows the draw calls of the last frame.
