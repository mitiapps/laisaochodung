# Known issues

Limits of the current game, legal readings it depends on, and findings not fixed yet. Each entry
says what happens and where.

## Release blockers

`npm run release:check` lists them; with today's data it fails on:

- **Sign figures.** No sign drawing in `public/signs/` has been compared with its figure in the
  official QCVN 41 annex; every `figureChecked` in `data/signs/signs.yaml` is `null`.
- **Contact and donate settings.** `contactEmail` and `donateUrl` in `src/config/site.js` are
  `null`. The disclaimer page asks players to report errors on the contact page, which has no
  contact channel until the maintainer sets one.

## Legal readings

- **Red light (`data/rules/red-light.yaml`).** Both stages cite the signal clause 6.9.b / 7.7.c
  (QCVN 41 6.3.3: red means stop before the stop line), even for a front that stops just past
  the line. The split into a lighter and a heavier tier (going `entryToleranceM`, 1 m, into the
  crosswalk or junction) is a `design` score split only. Explainer articles disagree and file a
  stop past the line under 6.1.a / 7.1.a; the Cục CSGT reading the game follows is known from
  press reports, not an official document. Cục CSGT has proposed a lighter treatment for a
  vehicle that stops past the line, which is not law; a decree that adopts it is a data change to
  the first tier.
- **Yellow-light leniency (design).** Law 36 Điều 11 khoản 4 điểm b lets only a vehicle already on
  or past the stop line go on at yellow. The game also excuses a vehicle that could not stop
  at 3 m/s² from where it first saw yellow (`yellowDecelMps2`).
- **Inferred crosswalk tier (`data/rules/crosswalk-yield.yaml`).** Going straight onto an occupied
  zebra has no điểm of its own and cites the catch-all 6.1.a / 7.1.a by inference. Turning cites
  6.5.l / 7.5.b.
- **TT 38 "V = 60".** TT 38 Bảng 3, row 1, prints "V = 60" in the official text too; it most likely
  means V ≤ 60. No rule uses Bảng 3: below 60 km/h the circular sets no distance, and the
  following-distance rule deducts score only.
- **Va chạm and tai nạn split (design).** A contact with an NPC car is an accident (10.a / 10.b)
  from a closing speed of `accidentRelSpeed` (4.2 m/s). Closing speed is measured along the
  contact normal, so a fast sideswipe counts as a light contact.
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
- Overtaking, reversing, priority vehicles and police signals have no rule.
- OSM signs on `osm-pasteur` are curated in `data/maps/osm-pasteur/`, not surveyed: they may
  differ from the street.

## Scoring

- **A heavy score-only outcome replaces a light legal one** (`src/scoring/detectors/collision.js`).
  Inside one crash episode any heavy outcome outranks any light one, and the report keeps only
  the worst breach. A light rear-end (6.4.l / 7.3.i) followed within `rearmS` by a heavy kerb or
  static hit, or by a fall (a fall no longer closes the crash episode), drops the 6.4.l clause,
  its fine and its cause from the report; the score deduction rises.
- **Steep centre-line crossings** (`src/scoring/detectors/against-lane-dir.js`). A crossing counts
  as into the opposing lane at more than 90° off it, but the `unlawful` flag is kept only when
  `inOpposing` holds (more than `againstAngleDeg`, 120°). A crossing steeper than about 60° off
  the ego's own lane drops the flag, so a solid centre line crossed steeply is caught only by the
  10 s `maxOpposingS` rule or a junction entry, or not at all if the ego returns sooner.
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
- **Indicators** do not cancel themselves after a turn; pressing the same side again turns them off.

## Physics and maps

- The scooter rig locks rotations on world axes, so it is valid on flat maps only
  ([physics.md](physics.md)).
- Replays are deterministic on one machine and build only; the deterministic Rapier build is not
  used.
- Frame time has been measured only in headless software rendering, not on a real GPU.
- The straight side of a T-junction has no pavement or kerb: corner pavements fill only real
  corners. On `tutorial-02-nga-tu` the larger trim at j4 widens that open side from about 9 m to
  16 m.
- The lane-change detector has been checked only against scripted and autopilot drivers. If a
  human play-test shows false breaches from jerky steering, add a dwell or depth threshold to
  `lane-line-cross` from that evidence, not from bot data.

## Data licences

The repository is private, so `data/maps/LICENSE-ODbL.md` does not reach players. The credits
page says the OSM-derived map files the game downloads are released under ODbL 1.0 and links the
licence; there is no licence file next to `maps/osm-pasteur.json` itself.
