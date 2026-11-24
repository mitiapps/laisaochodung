# Controls

Every control is a key and an on-screen button with the key drawn on it, so the same layout serves
a keyboard, a mouse and a touch screen. Bindings live once, in `KEY_BINDINGS`
(`src/contracts/controls.js`); the input module, the on-screen buttons and the help table on the
home page all read it.

## Presets

The player picks a preset on the home page. It is stored in `localStorage`
(`laisaochodung.controlPreset`) and fixed for a run; the pause menu shows it and says a change
applies from the next run. An empty or unknown stored value gives Đơn giản, the default.

| | Đơn giản (`simple`, default) | Thực tế (`real`) |
| --- | --- | --- |
| Car gearbox | Automatic: the gear keys move the selector R ← N ← D, the ratios shift by themselves | Manual: the gear keys step through R, N and 1–5 |
| Scooter brakes | The brake key applies both brakes (front plus rear, scaled by grip) | Separate front (brake key) and rear (Space) brakes |
| Indicator | Cancels itself after a signalled junction turn, once no junction lies ahead within the `turn-signal` rule's distance | Stays on until the same key is pressed again |

`resolveControlPreset` (`src/game/control-presets.js`) turns a preset into the sim's
`options.assists` and the input options. The auto-cancel reads its turn angle and distance from
the `turn-signal` rule, so it never switches the indicator off earlier than the scorer requires.

**The preset never changes the score.** No assist performs a scored duty: the player still
signals every turn and lane change, chooses when to brake, and the rules, tiers and penalties are
the same for both presets.

## On-screen layout

Laid out for a phone in landscape (checked at 844 × 390 and 1280 × 720, every control at least
56 px and overlapping nothing):

- **Bottom left:** the steering slider. Dragging sideways steers; letting go centres it.
- **Bottom right:** the pedals, left to right: the lever (handbrake on the car, rear brake on the
  scooter), the brake, and the throttle at the screen edge. Each fills to show how far it is
  applied.
- **Above the pedals, two arc rows:** left indicator, hazard and right indicator; then horn,
  lights, flash, gear down and gear up. The indicator and hazard buttons blink while on.
- **Top right:** pause.

A `hold` button acts from the first pointer down until the last pointer lifts; a `press` button
fires once when the pointer is lifted inside it. Buttons never take focus, so a held key keeps
working while the mouse clicks a button.

Each button carries a badge with its key. The badges hide after a touch input and come back with
the next key or mouse input.

## Keys

| Action | Keys | Mode |
| --- | --- | --- |
| Ga (throttle) | W, ↑ | hold |
| Phanh chân (car) / phanh trước (scooter) | S, ↓ | hold |
| Phanh tay (car) / phanh sau (scooter) | Space | hold |
| Lái sang trái | A, ← | hold |
| Lái sang phải | D, → | hold |
| Lên số | E | press |
| Xuống số | Q | press |
| Xi nhan trái | Z | press |
| Xi nhan phải | C | press |
| Đèn cảnh báo nguy hiểm | X | press |
| Đổi đèn: tắt, chiếu gần, chiếu xa | L | press |
| Nháy đèn chiếu xa | F | hold |
| Còi | H | hold |
| Tạm dừng / tiếp tục | Esc, P | press |

The table is written by hand from `KEY_BINDINGS`; change both together.

## Dev run options

Dev builds (`npm run dev`) read run options from the play hash query, for example
`#/play?map=osm-pasteur&vehicle=car-sedan&seed=42&traffic=off&agentScale=0.5`: `traffic` is `off`
or `map`, `seed` a decimal integer, and `agentScale` a decimal in (0, 1] that scales the map's
traffic cap (default 1). Any other value of these keys stops the run with an error. Release builds
ignore the query.

## Not supported yet

Portrait layout, fullscreen, tilt steering and gamepads. See
[known-issues.md](known-issues.md#controls).
