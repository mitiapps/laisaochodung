# Known issues

Limits of the current game, legal readings it depends on, and findings not fixed yet. Each entry
says what happens and where.

## Release blockers

`npm run release:check` lists them; with today's data it passes.

## Legal readings

- **Red light (`data/rules/red-light.yaml`).** Both stages cite the signal clause 6.9.b / 7.7.c
  (QCVN 41 6.3.3: red means stop before the stop line), even for a front that stops just past
  the line. The split into a lighter and a heavier tier (going `entryToleranceM` into the
  crosswalk or junction, `data/rules/red-light.yaml`) is a `design` score split only. Explainer articles disagree and file a
  stop past the line under 6.1.a / 7.1.a; the Cục CSGT reading the game follows is known from
  press reports, not an official document. Cục CSGT has proposed a lighter treatment for a
  vehicle that stops past the line, which is not law; a decree that adopts it is a data change to
  the first tier.
- **Yellow-light leniency (design).** Law 36 Điều 11 khoản 4 điểm b lets only a vehicle already on
  or past the stop line go on at yellow. The game also excuses a vehicle that could not stop
  at `yellowDecelMps2` (`data/rules/red-light.yaml`) from where it first saw yellow.
- **Inferred crosswalk tier (`data/rules/crosswalk-yield.yaml`).** Going straight onto an occupied
  zebra has no điểm of its own and cites the catch-all 6.1.a / 7.1.a by inference. Turning cites
  6.5.l / 7.5.b.
- **TT 38 "V = 60".** TT 38 Bảng 3, row 1, prints "V = 60" in the official text too; it most likely
  means V ≤ 60. No rule uses Bảng 3: below 60 km/h the circular sets no distance, and the
  following-distance rule deducts score only.
- **Fault in a contact (design table, `data/scoring/collision-policy.yaml` `faultRows`).** A contact
  with a car or motorbike is charged only when the player contributed: an episode of any rule but
  `nonContributingRules` active within `crashCauseWindowS` (a contributing episode), running into the vehicle ahead in the
  same lane, or striking a vehicle that carries no excusing violation (`red-light`, `wrong-way`,
  `no-yield`, `unsafe-lane-change`) that the player did not speed up into (a speed at contact more
  than `excuseMaxSpeedGainMps` above the speed when it showed, `data/scoring/collision-policy.yaml`). Speed gain stands in for
  "could have avoided it" and is a game threshold. A `red-light` or `no-yield` vehicle that was
  still moving at the contact and not ahead in the player's lane keeps excusing a player who gained
  speed (`rightOfWayViolations`), so pulling away on green into a red-light runner is a notice.
  A `red-light` or `no-yield` vehicle standing or wrecked in the junction still excuses a player
  who drives into it without gaining speed while its flag is latched (within `crashCauseWindowS`).
  Being struck from behind is never charged unless the player
  had just cut in or turned without signalling. Everything else is a notice with no deduction, as
  is every contact within `aftermathWindowS` after a notice (the shove). Contacts with pedestrians
  are always charged; static objects, kerbs and falls only escape inside the aftermath window.
- **A notice is a game ruling, not a legal one.** The notice text says the game records no fault;
  it never says the player had none. Law 36 Điều 12 khoản 3 still asks every driver to watch the
  road and slow down, and only the police decide fault.
- **A stopped player is never charged** for a contact (below `contactMinEgoSpeed`,
  `data/scoring/scoring.yaml`), even while
  an episode that would count as contributing is active, such as stopping in a junction
  (6.10.a "dừng xe"): a contact the fault table would charge below the speed gate gives a notice
  instead. A pedestrian touched below that speed gives a notice too and never ends the run; a
  static object or kerb touched below it gives nothing.
- **Va chạm and tai nạn split (design).** A charged contact with an NPC car is an accident
  (10.a / 10.b) from a closing speed of `accidentRelSpeed` (`data/scoring/scoring.yaml`). Closing speed is measured
  along the contact normal, so a fast sideswipe counts as a light contact.
- **High beam and anti-glare medians.** ND 168 excepts oncoming traffic behind "dải phân cách có
  khả năng chống chói". Maps record only `road.divided`, so on a divided road oncoming cars never
  count; a median that does not block glare is missed rather than wrongly cited.
- **Pavement and crosswalk duties.** A rule's `obligation` list is not scoped per vehicle class or
  tier: `pavement` lists the general duty (Law 36 Điều 10 khoản 1) and the motorbike duty
  (Điều 33 khoản 3 điểm b); `crosswalk-yield` lists the straight duty (Điều 12 khoản 3 điểm a)
  and the turning duty (Điều 15 khoản 3).
- **Following distance.** It deducts score only. ND 168 6.4.l / 7.3.i also fine breaking the
  distance of a "Cự ly tối thiểu giữa hai xe" sign, with or without a collision; no shipped map
  places that sign.
- **Sources read only through others.** Law 118/2025 was read only through the consolidated
  text 55/VBHN-VPQH, and TT 09/2025 only through the amendment marks in a commercial copy of
  TT 38. TT 09 amends TT 38 Điều 10, not the Điều 6 speed tables.

## Not modelled

- Mopeds (xe gắn máy), expressways, tunnels, parking offences, user maps and sign placing are out
  of scope.
- Acts the game cannot observe: alcohol, helmet and seat belt, phone use, licence and papers,
  vehicle condition, loads and passengers.
- Overtaking, reversing, priority vehicles and police signals have no rule. A reversing rule (Law
  36/2024 Điều 16 bans reversing on one-way roads, in no-stopping areas, on crosswalks and at
  junctions) is deferred: it waits for a fetched citation and an ND 168 clause, and would be a car
  rule, since a scooter backing out with the feet is the escape the push-back exists for.
- OSM signs on `osm-pasteur` are curated in `data/maps/osm-pasteur/`, not surveyed: they may
  differ from the street.

## Scoring

- **A turn finished by backing away is not judged** (`src/scoring/detectors/junction-turn.js`).
  Backing slowly out of a junction into another arm keeps the entry only for the next exit of that
  junction. Driving forward away along the arm backed into, without crossing the junction again,
  completes the turn with no `turn-signal` or `banned-turn` check; the kept entry is dropped at the
  next junction.
- **A heavy score-only outcome replaces a light legal one** (`src/scoring/detectors/collision.js`).
  Inside one crash episode any heavy outcome outranks any light one, and the report keeps only
  the worst breach. A light rear-end (6.4.l / 7.3.i) followed within `rearmS` by a heavy kerb or
  static hit, or by a fall (a fall no longer closes the crash episode), drops the 6.4.l clause,
  its fine and its cause from the report; the score deduction rises.
- **Steep centre-line crossings** (`src/scoring/detectors/against-lane-dir.js`). A crossing counts
  as into the opposing lane at more than 90° off it, but the `unlawful` flag is kept only when
  `inOpposing` holds (more than `againstAngleDeg` off the lane, `data/rules/wrong-side.yaml`). A
  crossing steeper than 180° minus that off the ego's own lane drops the flag, so a solid centre
  line crossed steeply is caught only by the `maxOpposingS` rule (same file) or a junction entry,
  or not at all if the ego returns sooner.
- **Red light outside the bound lanes** (`src/scoring/detectors/stop-line-on-red.js`). Stop-line
  segments cover their own lanes only. Driving through the opposing lane on red scores wrong-side
  (6.5.b) but no red-light breach, a lower penalty than running the light in lane.
- **Supersession mode is derived, not declared** (`src/scoring/scorer.js`). Two rules that
  share a clause supersede by clause; two that share none supersede as a whole (see
  [rules-data.md](rules-data.md#supersession)). A new pair that needs whole-rule supersession
  while sharing a clause would need an explicit flag in the rule contract.
- **Two key presses in one step** (`src/game/input.js`). Edge commands keep one slot per fixed
  step, so two presses between samples (left then right, or left twice) collapse into the last.
  The indicator can then differ from what the player pressed, which can lead to a false
  turn-signal or lane-change breach.
- **Live toasts.** An accident's cause shows `fineAbsorbedBy` only in the final report, not on its
  live toast.

## Controls

- **The auto-cancel and a quick second change.** On Đơn giản, the indicator switches off once a
  signalled junction turn is done and no junction lies within the `turn-signal` rule's distance.
  A lane change to the same side within about 1.5 s of the junction exit then finds the indicator
  already off, and it must be signalled again.
- **The auto-cancel rarely fires on `osm-pasteur`**, where the next junction often lies within that
  distance of the last one; the indicator then stays on until the player switches it off.
- **Touch pedals are on or off.** A tap holds full throttle or full brake; there is no half
  pedal on a touch screen.
- **Portrait, fullscreen, tilt steering and gamepads** are not supported yet.
- On Thực tế, indicators do not cancel themselves; pressing the same side again turns them off.
- **Touch controls are tested only by emulation.** The browser tests drive them with emulated
  touch; they have never been run on a real phone.
- **No live mirrors in the cockpit view.** The mirror heads are drawn dark; switch to the chase
  view to look behind.
- **Narrow screens.** Below a 748 px HUD box for the car, or 676 px for the scooter on either
  preset, the outermost controls run off the screen: the car's hazard and Phanh tay first. The
  HUD box is the screen less 12 px of padding or the safe-area inset on each side, whichever is
  larger. Between that width and the width a centred wheel needs (816 px for the car, 712 px for
  the scooter on either preset), the row shifts and the wheel sits off centre. An 844 px wide
  notched iPhone in landscape, with insets of about 47 px, leaves about 750 px: the car fits, with
  its wheel about 33 px left of the screen's centre. This is the chosen behaviour: the controls
  stay inside the safe area and the wheel gives way. An 852 px wide phone with insets of about
  59 px leaves 734 px, below the car's 748 px, so its hazard switch and Phanh tay reach about
  14 px into the right inset, still on the screen (computed, not measured). A 667 px wide iPhone
  SE leaves 643 px: too narrow for the car and for the scooter on either preset. The browser
  tests check only screens without insets; 774 × 390 stands in for the notched 844 px phone's
  box width.
- **The gear lever is a plus/minus lever on both presets.** Số + sits on top and steps up the
  ladder R → N → D on Đơn giản (R → N → 1–5 on Thực tế). It does not follow a real automatic's
  P-R-N-D order, where R is at the front; this is kept so one lever and one pair of keys serve
  both presets.
- **The Đơn giản scooter brake is front-led.** It sits on the left hand lever, as the combined
  brake of a CBS automatic scooter does, but applies full front brake plus a rear brake scaled by
  grip, while a real combined-brake lever is rear-led.
- **Some scooter keys sit on the other side of the keyboard from their control.** The hazard and
  the horn are in the left switch cluster but use H and F; the throttle is on the right grip but
  uses W; on Thực tế the front brake beside it uses S and the left-lever rear brake uses Space.
  The keys follow the car's layout, so both vehicles share one set.
- **The chase camera sits closer behind the car than behind a real sedan.** The drawn sedan is
  taller than its `heightM`, so the camera is moved in to keep the road just ahead of the bumper
  visible over the roof (`CHASE_RIG` in `src/render/scene.js` gives the reasoning).
- **The centred steering control and the stalk cover the lower edge of the car** in the chase
  view, on every screen. The steering's background is see-through, so the car shows through it.
  This is kept, since the row cannot go lower without covering the map attribution and the camera
  cannot pitch down without losing the road ahead; the HUD repeats the indicators and the brake.

## Traffic

- **A turning bus can brush a player waiting at the stop line.** Traffic waits behind the sweep of
  a long vehicle turning, but the player's stop point is the painted line, which a bus turning
  tightly can swing over. The contact is the bus's, so the player gets a notice.
- **Traffic thins out beyond the mapped streets.** The map has no boundary: a player who drives on
  past the last mapped street leaves the spawn ring with no road in it, and traffic fades away.
- **Traffic agents can stop dead.** An agent that finds the agent ahead too close stops in one
  step instead of braking, so a player following too closely may run into it and be charged.
- **No riding against the flow or on the pavement.** Traffic agents always travel with their
  lane. The HCMC habits of riding a short way against the flow or along the pavement are out of
  scope. A scripted actor that moves against its lane carries `wrong-way`.
- **Design motorbike parameters.** Motorbike speeds, gaps, lateral slots and violation rates in
  `data/traffic/params.yaml` are game values (`paramBasis: design`), not measured HCMC data.
- **Generated vehicle bodies are static.** The Tripo motorbike, bus and car bodies have their
  wheels baked in, so the wheels neither spin nor steer, and they keep their own colours, so
  traffic cars lose their paint variants and taxis their fleet liveries.
- **Wrecks leave a fixed time after the contact.** Every wrecked traffic vehicle, whether the
  player or another agent struck it, is removed `wreckClearS` (`data/traffic/params.yaml`) after
  the contact, sliding car wrecks included, or sooner once it lies more than `wreckClearDistM`
  behind the player, out of view; the player drives on from where the contact left them. A
  wreck's `red-light` or `no-yield` latch lasts `LATCH_S` (`src/world/traffic/violations.js`),
  set to match, so a wreck standing unflagged in the road no longer happens in a run; the fault
  rows for it stay, for scripted actors and tests. The clearing check accepts the step that lands
  within half a step (`DT / 2`) of `wreckClearS`, because step times are float sums of `DT`; that
  slack is a rounding guard, not a tuning value, so retune `wreckClearS` and leave the slack
  alone.
- **A wreck vanishes in view.** It is removed in one step, with no fade or blink first.
- **NPCs cannot wreck scripted actors.** Traffic agents stop for scripted actors (perceived
  exactly), and a scripted actor holds for anything in its path, so neither ever strikes the other.
- **A parked scripted actor closes its lane.** A scripted actor that ends its path on a lane stays
  there, and traffic changes lane round it.
- **Scripted violations do not act.** A declared violation is a flag of the actor's pose, read by
  the fault table on a contact with it. The actor does not run a light or change lane, and the flag
  is not latched: it shows for as long as the actor is active.
- **NPCs change lane in the solid approach.** Nothing in `src/world/traffic/` reads a lane line's
  type, so agents still change lane on the solid stretch before a stop line that the player may
  not cross.
- **Mast arms are a build rule, not surveyed.** A far-side repeater hangs on a mast arm wherever
  the approach has two or more lanes; no map data says which real heads hang on a cantilever.
- **Civic fences are drawn only.** They have no collider, so the player can drive through them.
- **Signal countdowns** count red and green only, as the countdown lamps in Ho Chi Minh City do.
- **Traffic applies a P.127 zone to the whole lane.** The scorer reads a speed-limit zone only
  inside its polygon, but traffic binds it to every lane the zone lists, end to end. Where a zone
  covers part of a lane (`z-s-p127-40` on `rong-f0` and `rong-f1` of tutorial 01 and tutorial 03
  covers x 240 to 420 of a lane that runs 220 to 512), agents keep to 40 km/h along the whole lane
  and can be flagged `speeding` at 41 to 50 km/h outside the zone, where the player's limit is the
  TT 38 default. Fixing it needs limits that change along a lane.

## Physics and maps

- The scooter rig locks rotations on world axes, so it is valid on flat maps only
  ([physics.md](physics.md)).
- **No stop line before an unsignalled crosswalk.** QCVN 41:2024 G2.3 asks for one ("cần"), but
  the map contract has no paint-only stop-line control that the scorer and traffic would ignore,
  so a zebra away from a signalised junction has no line before it. It is the next junction item.
- **OSM junction crossings are not at their surveyed position.** The game junction ends at the
  cross road's half width plus 1 m, with no corner radii, so an OSM crossing within 15 m of a
  junction end is drawn at the junction edge, up to about 13 m nearer the junction than in OSM.
  Crossings farther out stay where surveyed and have no stop line ([maps.md](maps.md#junctions)).
- **Driving into a scripted actor rolls the player back slowly.** A car that drives at about
  60 km/h into a parked scripted car leaves the contact backwards at about 0.3 m/s, from Rapier's
  rigid contact against an immovable body (the chassis pitch and suspension unwind). Contacts
  with traffic agents cap this at the common velocity (`src/sim/traffic-mirror.js`); scripted
  actor bodies (`src/sim/actors.js`) do not.
- Replays are deterministic on one machine and build only; the deterministic Rapier build is not
  used, so a recorded run replays only on the same engine build.
- Frame time has been measured only in headless software rendering, not on a real GPU.
- **A low frame rate runs the game in slow motion.** The loop takes at most
  `MAX_STEPS_PER_FRAME` fixed steps per rendered frame (`src/game/loop.js`), so below
  `1 / (MAX_STEPS_PER_FRAME · DT)` frames per second simulated time falls behind the clock.
- In software GL (SwiftShader, 1280 × 720, dev server) the low-cost path draws `osm-pasteur` at
  about 34 frames per second and tutorial 01 at about 58.
- The straight side of a T-junction has no pavement or kerb: corner pavements fill only real
  corners. On `tutorial-02-nga-tu` the larger trim at j4 widens that open side from about 9 m to
  16 m.
- **A `laneLine` spec is read in the way's own frame for both directions** (`scripts/maps/lib/lanes.js`).
  Its stretches are measured from the way's first node and its `crossable` side is taken against
  the node order, for the backward lane lines too. On `tutorial-01-co-ban`, the "solid before the
  junction" stretch of `rong` is also solid for the first 52 m after the junction for westbound
  traffic (`rong-lb1-2`, x 460 to 512), and a `mixed` line on a two-way way would allow the
  opposite lane change to backward traffic. No source uses a `mixed` line, and the tutorial route
  drives `rong` eastbound only.
- The lane-change detector has been checked only against scripted and autopilot drivers. If a
  human play-test shows false breaches from jerky steering, add a dwell or depth threshold to
  `lane-line-cross` from that evidence, not from bot data.

## Data licences

The ODbL notice for the OSM-derived map data is `data/maps/LICENSE-ODbL.md` in the public
repository; the release gate fails without it. The built site does not ship it: the build copies
`public/` beside the bundle, and `public/maps/` has no licence file next to
`maps/osm-pasteur.json`. Players get
the "© OpenStreetMap contributors, ODbL" attribution on the play screen and the credits page,
which says the OSM-derived map files the game downloads are released under ODbL 1.0 and links
the licence text.
