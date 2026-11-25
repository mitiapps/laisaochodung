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
| Scooter brakes | The brake key applies both brakes (front plus rear, scaled by grip); Space still applies the rear alone, a key with no on-screen button, since the Phanh pedal already applies both | Separate front (brake key) and rear (Space) brakes |
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
  It is the way to see a vehicle beside or behind, which lane changes and turns need. The camera
  sits 6.5 m behind and 4.5 m above a car, looking at the ground 6.5 m ahead of its centre, and
  5.5 m behind and 3.6 m above a scooter, looking 5 m ahead (`CHASE_RIG` in
  `src/render/scene.js`). The drawn sedan is 1.89 m tall, the proportions of its Car Kit model,
  not a real sedan's 1.45 m, so the car's camera sits closer than its height alone would need.
- **Thứ nhất (trong xe)**, `cockpit`: from the driver's seat of a left-hand-drive car, over a dash,
  a low bonnet and a steering wheel; or from the rider's eyes over the handlebar, mirrors and dash
  cowl, rolling with half the bike's lean. The mirrors are dark: there are no live mirrors.

The view never changes the run: it is not part of a frame, the score or the replay.

## On-screen layout

The controls follow a cabin from left to right (`controlLayout` in `src/ui/lib/hud-view.js`, which
the HUD draws and the browser tests read):

| Zone | Car | Scooter |
| --- | --- | --- |
| Left stalk, or the left switch cluster | Đèn, Nháy above ←, → | Đèn, Nháy above ←, →, Còi |
| Left lever | — | Phanh sau, on Thực tế only |
| Steering | a round wheel | a handlebar |
| Horn | Còi, right of the wheel | in the switch cluster |
| Pedals | Phanh chân, Ga | Phanh (Đơn giản) or Phanh trước (Thực tế), Ga |
| Right console, at the right edge | hazard, Số +, Số −, Phanh tay, top to bottom | hazard, above Ga |
| Top right | Góc nhìn, Tạm dừng | the same |

- **Phone or touch screen** (checked at 844 × 390): the steering sits at the bottom left in the
  left thumb's reach, with the stalk rows above it; the pedals and the console sit at the bottom
  right. Two thumbs cannot reach the middle of a phone while one holds a pedal.
- **Desktop window** (a mouse or trackpad and at least 1100 × 560, checked at 1280 × 720 and
  1100 × 600): the steering moves to the bottom centre, 40 px up so the map attribution stays
  readable under it, with the stalk on its left and the car's horn on its right. The speed panel
  sits beside that group.
- Every control is at least 56 px and overlaps nothing. Dragging the steering sideways steers and
  letting go centres it; the drawing turns with the steering applied. The pedals and levers fill to
  show how far they are applied; on Đơn giản the scooter's brake also shows the rear brake it
  applies. The indicator and hazard buttons blink while on.
- **Top centre:** breach and notice toasts, newest first. A notice shows for 4 s, a breach for
  6 s. Below 480 px of viewport height (a landscape phone) only the newest one shows, with a "+N"
  count of the others; the result screen lists them all.

A `hold` button acts from the first pointer down until the last pointer lifts; a `press` button
fires once when the pointer is lifted inside it. Buttons never take focus, so a held key keeps
working while the mouse clicks a button. The top-right buttons stay usable while the run is
paused.

Each button carries a badge with its key. The badges hide after a touch input and come back with
the next key or mouse input.

## Keys

The keys sit where the controls sit in a cabin: the wheel and pedals under the left hand (W A S
D), the stalk just above and left of them (Q E Z X), and the gear lever and handbrake under the
right hand (I K L). A player on the arrow keys has the left hand free for the stalk, and Page Up
and Page Down beside the arrows for the gears.

| Action | Keys | Mode | Cabin position |
| --- | --- | --- | --- |
| Ga (throttle) | W, ↑ | hold | pedal |
| Phanh chân (ô tô) / phanh trước (xe máy) | S, ↓ | hold | pedal |
| Lái sang trái | A, ← | hold | wheel |
| Lái sang phải | D, → | hold | wheel |
| Xi nhan trái | Q | press | left stalk |
| Xi nhan phải | E | press | left stalk |
| Đổi đèn: tắt, chiếu gần, chiếu xa | Z | press | left stalk |
| Nháy đèn chiếu xa | X | hold | left stalk |
| Còi | F | hold | wheel hub |
| Đèn cảnh báo nguy hiểm | H | press | centre dash |
| Lên số (ô tô) | I, Page Up | press | right-hand lever |
| Xuống số (ô tô) | K, Page Down | press | right-hand lever |
| Phanh tay (ô tô) | L | hold | right of the lever |
| Phanh sau (xe máy) | Space | hold | left lever |
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
