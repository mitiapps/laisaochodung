# Assets

Every file under `public/models/` and `public/signs/` has a record in
[`data/credits/credits.json`](../data/credits/credits.json) (`Credit[]`, `src/contracts/catalog.js`).
`src/render/assets-coverage.test.js` fails when a shipped file lacks a record, a record names a
missing file, a CC BY record lacks its credit line, or the model payload reaches 5 MB.

## Models

| Files | Source | Licence | Used as |
| --- | --- | --- | --- |
| `models/car-kit/sedan.glb` | [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Player car (`car-sedan`) |
| `models/car-kit/taxi.glb`, `hatchback-sports.glb` | same | CC0 1.0 | NPC cars (`npc-sedan`, `npc-hatchback`) |
| `models/car-kit/Textures/colormap.png` | same | CC0 1.0 | Shared texture the GLBs reference by relative path |

The licence was read on the Kenney page and in the kit's `License.txt`. The kit's GLBs face +Z with
left at +X, and each wheel is a separate node (`wheel-front-left`, `wheel-front-right`,
`wheel-back-left`, `wheel-back-right`).

The scooter is drawn from primitives. The model the plan named, "Scooter" by Julien Savoie
([poly.pizza/m/5FDNl4MP9H3](https://poly.pizza/m/5FDNl4MP9H3), CC BY 3.0), is a kick scooter, so it
is not shipped. Two CC BY 3.0 motor scooters on Poly Pizza would fit: "low poly scooter" by
Thomas Saint Pierre ([awXCP7LUcz6](https://poly.pizza/m/awXCP7LUcz6)) and "Scooter" by Poly by
Google ([eHdEFPwUfCt](https://poly.pizza/m/eHdEFPwUfCt)).

Pedestrians are primitive figures. Any vehicle or actor whose GLB is missing or fails to load is
drawn as a generated box car or primitive scooter of its footprint size, and the console shows the
error.

### Adding a model

1. Check the licence on the source page itself; prefer CC0. Note what you checked.
2. Export GLB facing +Z with left at +X and separate wheel nodes, or set `wheelNodes: []` to get
   generated wheels.
3. Copy it under `public/models/` and add its `Credit` record. A CC BY work needs the exact
   `creditLine`.
4. Point a config at it: a vehicle in `src/render/vehicles/<vehicleId>.js` (registered in
   `src/render/vehicles/index.js`), or an actor `model` key in `ACTOR_MODELS`. The renderer scales
   the model per axis to the footprint (width on X, length on Z), stands it on the ground and turns
   it to +X forward.

## Signs

Own drawings, Apache-2.0, one SVG per code of `data/signs/signs.yaml`, named by the code as written
(`public/signs/P.127.svg`). Plate sizes follow QCVN 41:2024/BGTVT Điều 12, Bảng 1 (round D 700 with
a 100 border, triangle L 700 with a 50 border, octagon D 600); `src/render/sign-art.js` holds the
size and shape per code. P.127 and DP.134 get the map sign `value` painted on at runtime.

Names and codes were checked against the sign table. **No figure has been compared with the
official annex yet**: that check belongs to the release review.

| Code | Name | Figure compared |
| --- | --- | --- |
| P.101 | Đường cấm | not yet |
| P.102 | Cấm đi ngược chiều | not yet |
| P.123a | Cấm rẽ trái | not yet |
| P.124a | Cấm quay đầu xe | not yet |
| P.127 | Tốc độ tối đa cho phép | not yet |
| DP.134 | Hết tốc độ tối đa cho phép | not yet |
| P.130 | Cấm dừng xe và đỗ xe | not yet |
| R.122 | Dừng lại | not yet |
| R.420 | Bắt đầu khu đông dân cư | not yet |
| W.208 | Giao nhau với đường ưu tiên (đường chính) | not yet |
| I.401 | Bắt đầu đường ưu tiên | not yet |
| I.407a | Đường một chiều | not yet |

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
