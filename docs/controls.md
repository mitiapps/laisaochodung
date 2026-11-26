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
| Scooter brakes | The brake key applies both brakes (front plus rear, scaled by grip); Space still applies the rear alone, a key with no on-screen button, since the Phanh lever already applies both | Separate front (brake key) and rear (Space) brakes |
| Indicator | Cancels itself after a signalled junction turn, once no junction lies ahead within the `turn-signal` rule's distance | Stays on until the same key is pressed again |

`resolveControlPreset` (`src/game/control-presets.js`) turns a preset into the sim's
`options.assists` and the input options. The auto-cancel reads its turn angle and distance from
the `turn-signal` rule, so it never switches the indicator off earlier than the scorer requires.

**The preset never changes the score.** No assist performs a scored duty: the player still
signals every turn and lane change, chooses when to brake, and the rules, tiers and penalties are
the same for both presets.

## Camera

Two views, switched at any time in a run, paused or not, with V or the **Góc nhìn** button at the
top right; the home page has the same choice. The choice is stored in `localStorage`
(`laisaochodung.cameraMode`); an empty or unknown value gives the chase view.

- **Thứ ba (sau xe)**, `chase`, the default: behind and above the vehicle, pitched down so the
  vehicle sits in the lower half of the screen and the road shows from a few metres ahead of it.
  It is the way to see a vehicle beside or behind, which lane changes and turns need. Its distance,
  height and aim for each vehicle class are `CHASE_RIG` in `src/render/scene.js`.
- **Thứ nhất (trong xe)**, `cockpit`: from the driver's seat of a left-hand-drive car, over a dash,
  a low bonnet and a steering wheel; or from the rider's eyes over the handlebar, mirrors and dash
  cowl, rolling with half the bike's lean. The mirrors are dark: there are no live mirrors.

The view never changes the run: it is not part of a frame, the score or the replay.

## On-screen layout

The controls follow a cabin from left to right (`controlLayout` in `src/ui/lib/hud-view.js`, which
the HUD draws and the browser tests read). One layout serves every screen: the wheel or the
handlebar sits at the bottom centre, everything left of it in one group against its left edge and
everything right of it in one group against its right edge. On a screen too narrow for both sides
of a centred wheel, the whole row shifts towards the narrower side until both fit, so the wheel
sits a little off centre. The groups sit a little above the bottom so the map attribution under
them stays readable.

| Zone | Car | Scooter |
| --- | --- | --- |
| Left stalk, or the left switch cluster | Đèn, Nháy above ←, → | Đèn, Nháy, hazard above ←, →, Còi |
| Left hand lever | — | Phanh sau on Thực tế, Phanh (both brakes) on Đơn giản |
| Steering, at the bottom centre | a round wheel | a handlebar |
| Horn | Còi, immediately right of the wheel | in the switch cluster |
| Pedals | Phanh chân, Ga, next to the horn | — |
| Right end of the handlebar | — | Phanh trước over the Ga twist grip on Thực tế, Ga alone on Đơn giản |
| Gear lever | Số + over Số −, with the gear on the knob between them; a plus/minus lever, not a P-R-N-D gate, so one lever serves both presets | — |
| Right-hand console | hazard over Phanh tay | — |
| Speed panel | left of the stalk, with the gear and the rpm bar | right of the grip, no gear |
| Top right | Góc nhìn, Tạm dừng | the same |

- The layout is checked at 1280 × 720, 1100 × 600, 844 × 390, 800 × 360 and 774 × 390 (the HUD
  box of a notched 844 px phone). Every control is at
  least 56 px and overlaps nothing, and the speed panel has a fixed width, so a three-digit speed
  never grows it.
- The narrowest HUD box that fits every control is 748 px for the car and 676 px for the scooter
  on either preset: a 772 or 700 px wide screen with no safe-area insets. The anchor and its bounds are `place`
  in `src/ui/hud/hud.svelte`.
- The scooter is an automatic ("Xe tay ga"), so its rear brake is the left hand lever, not a foot
  pedal, and it has no gear to show. On Đơn giản its one brake is the left hand lever, as on a
  combined-brake scooter: it applies both brakes and shows the rear brake it applies; Space still
  applies the rear alone, with no on-screen button.
- Dragging the steering sideways steers and letting go centres it; the drawing turns with the
  steering applied. Its background is mostly see-through, so the vehicle shows through it in the
  chase view. The pedals, levers and grip fill to show how far they are applied; the grip's ribs
  roll as it opens, and the handbrake's handle tilts up and turns red while applied. The throttle
  grip is held, not twisted: pressing it applies full throttle. The indicator and hazard buttons
  blink while on.
- **Top centre:** breach and notice toasts, newest first. A notice shows for `HUD_NOTICE_S`
  (`src/game/hud-state.js`), a breach for `TOAST_MS` (`src/ui/lib/toast-stack.js`). On a short
  viewport (a landscape phone) only the newest one shows, with a "+N" count of the others; the
  result screen lists them all.

A `hold` button acts from the first pointer down until the last pointer lifts; a `press` button
fires once when the pointer is lifted inside it. Buttons never take focus, so a held key keeps
working while the mouse clicks a button. The top-right buttons stay usable while the run is
paused.

Each button carries a badge with its key. The badges hide after a touch input and come back with
the next key or mouse input.

## Keys

The keys sit where the controls sit on screen, by relative position: the wheel and pedals under
the left hand (W A S D), the stalk just above and left of them (Q E Z X), the horn just right of
the wheel keys (F), and the hazard, gear lever and handbrake further right (H, I K L). A player on the arrow keys has the left hand free for the stalk, and Page Up
and Page Down beside the arrows for the gears.

| Action | Keys | Mode | Cabin position |
| --- | --- | --- | --- |
| Ga (throttle) | W, ↑ | hold | right grip (scooter) / pedal |
| Phanh chân (ô tô) / phanh trước (xe máy) | S, ↓ | hold | right lever on Thực tế, left lever on Đơn giản (scooter) / pedal |
| Lái sang trái | A, ← | hold | wheel |
| Lái sang phải | D, → | hold | wheel |
| Xi nhan trái | Q | press | left stalk |
| Xi nhan phải | E | press | left stalk |
| Đổi đèn: tắt, chiếu gần, chiếu xa | Z | press | left stalk |
| Nháy đèn chiếu xa | X | hold | left stalk |
| Còi | F | hold | right of the wheel |
| Đèn cảnh báo nguy hiểm | H | press | right console (car) / switch cluster (scooter) |
| Lên số (ô tô) | I, Page Up | press | gear lever |
| Xuống số (ô tô) | K, Page Down | press | gear lever |
| Phanh tay (ô tô) | L | hold | right of the gear lever |
| Phanh sau (xe máy) | Space | hold | left hand lever on Thực tế |
| Đổi góc nhìn | V | press | — |
| Tạm dừng / tiếp tục | Esc, P | press | — |

The handbrake and the rear brake are one control in the input: L or Space applies the handbrake
on a car and the rear brake on a scooter, so a habit key still works. The scooter's gearbox has no
selector to drive, so the gear keys do nothing on it. No key needs Ctrl, Alt, Meta, Shift, Tab,
Enter or a function key.

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
