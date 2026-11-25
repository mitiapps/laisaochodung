# Rules data

The game's legal content is data. `npm run build:rules` loads it, validates it
(`src/rules/validate.js`) and writes `src/generated/rules.json`, one `RulesBundle`
(`src/contracts/rule.js`). The build fails on any problem, such as a missing citation, an
unknown source id or an unknown clause id.

| File | Holds |
| --- | --- |
| `data/legal/sources.yaml` | Legal texts: number, edition, dates, URL, `official` |
| `data/legal/clauses.yaml` | One record per cited điểm of ND 168: fine band, licence points, suspension, quote |
| `data/legal/speed-defaults.yaml` | TT 38 default limits by class, built-up area and road type |
| `data/rules/<id>.yaml` | One rule per file (the file name is the rule id) |
| `data/scoring/scoring.yaml` | Deductions per danger level and the scorer's timing and impulse thresholds |
| `data/scoring/collision-policy.yaml` | How a collision picks its clause |
| `data/signs/signs.yaml` | Sign meanings (owned by the contracts, read here) |

## When the law changes

Fines, points and suspensions live only in `clauses.yaml`, keyed by `D<điều>.<khoản>.<điểm>`
(for example `D6.3.a`). Rules point at these ids.

1. Read the new text. Add it to `sources.yaml` if it is a new source, and add its id to the
   amended source's `amendedBy`.
2. Edit the clause record:
   - Changed amounts: set `fineVnd`, `licencePoints` or `suspensionMonths`.
   - Changed wording: replace the quote in `citation`, or add an inserted phrase to
     `amendments`. An amendment is a separate citation; it is not merged into the original
     sentence.
   - Set `effectiveFrom` to the date the new wording applies, and `checkedOn` to today.
   - Set `verified` (see below).
3. Update the cross-check fixture `scripts/rules/fixtures/nd168-detectable.csv` to the new
   values, then run `npx vitest run scripts/rules`.
4. Edit a rule's tiers only if the behaviour moves to another điểm.

A renumbered điểm is a new clause id. Add the record, point the tiers at it, and delete the
old record once nothing cites it.

## Fields

- **Citation**: `sourceId`, `article`, optional `clause` and `point`, a verbatim Vietnamese
  `quote`, and the `url` where it was read. A clause's citation must name its own điểm.
- **Tier**: has exactly one of three shapes:
  - `clause: {D6?, D7?}`: the clause for each decree group the rule covers. Điều 6 is cars;
    Điều 7 is motorbikes.
  - `scoreOnly: true`: needs a `note`.
  - `clauseFromPolicy: true`: only on the `crash` rule.

  Tiers run from mildest to worst. The worst tier whose `when` matches the detector's output
  applies (`src/scoring/tiers.js`). In `when`, `decreeGroups` limits a tier to some groups, so
  a car-only tier names only its `D6` clause.
- **`danger`** (1–5) sets the score deduction through `scoring.yaml`. It is the game's own
  scale, separate from the legal penalty.
- **`detection`**: `type` names a detector in `src/scoring/detectors/`. `params` are its
  thresholds. Every param needs a `paramBasis` entry, and every `paramBasis` key must be a
  param.

## Flags

- **`verified`** (clauses, speed defaults, sign meanings): `true` only when the value was read
  from an official text, or from two copies of which at least one is official. Unverified data
  is built and shown with the "chưa kiểm chứng" badge; the release gate
  (`scripts/release-check.js`, run by `npm run deploy`) blocks a deploy while any is left. Every
  clause, speed default and sign meaning is verified at the moment. A breach detected against an
  unverified default limit carries `basisVerified: false`, so its toast shows the badge even
  though its clause is verified.
- **`figureChecked`** (signs): the date the game's SVG was compared with the official QCVN 41
  figure, `null` until then. `countUnverified` lists every null under `figures`, and the release
  gate fails while any drawing is unchecked.
- **`inferred`** (tier): no điểm names the behaviour exactly, and the clause applies by
  reading. The UI shows "suy luận". Example: the sign-and-marking catch-all for going straight
  onto an occupied zebra.
- **`paramBasis: design`**: the threshold is the game's own, not the law's ("ngưỡng của trò
  chơi"). Breaches list these in `designParams`.

## Supersession

One act gives one breach. `supersedes: [{ruleId, decreeGroups?}]` makes a rule win over others
in the listed groups (both groups when omitted):

- `wrong-way` wins over `no-entry` and `wrong-side`.
- `banned-turn` wins over `turn-signal` for motorbikes only, where both cite 7.3.a.

The scorer works out per pair, from the tiers, which of two ways applies:

- The two rules cite no clause in common for the group (`wrong-way` 9.d against `no-entry` 5.i,
  whose text excepts 9.d, and `wrong-side` 5.b): the superseded rule is dropped whenever its
  superseding rule is active in the same step or still has an open episode.
- They share a clause (`banned-turn` and `turn-signal` on 7.3.a): only a detection citing the
  clause the superseding rule cites at that moment is dropped. A motorbike's banned U-turn
  (7.2.k) with no indicator therefore reports both 7.2.k and the separate 7.3.a.

An emitted breach cannot be taken back, so a superseding detector must fire no
later than the rule it supersedes. Wrong-way fires on the P.102 entry crossing itself, and both
junction-turn rules fire on the junction exit.

## Collision policy

A pedestrian hit, or an NPC car hit at a closing speed of at least `accidentRelSpeed` (4.2 m/s,
about 15 km/h, `design`), is an accident. Closing speed is used rather than impulse because
impulse scales with the player's mass, which differs about sevenfold between the car and the
scooter. It is measured along the contact normal, so a fast sideswipe counts as a light contact.

- It cites 10.b (`accidentB`) when the cause's clause is in `accidentBList`, and 10.a
  (`accidentA`) otherwise, including when there is no cause.
- `accidentBList` copies the lists quoted in 6.10.b and 7.10.b, and a test keeps the two
  equal.
- The cause is the worst other breach active in the last `crashCauseWindowS`: the highest
  danger, then one with a clause of the vehicle's decree group over a score-only one, then the
  most recent. The crash rule is
  evaluated after every other rule of a step, so a cause that opens or escalates on the crash's
  own step counts, at its new tier.
- A cause in `inferredAccidentCauses` (a clause id or a rule id) marks the accident as
  inferred. `pavement` is listed by rule id because its motorbike clause, 7.7.a, also covers
  wrong-way riding, which 7.10.a names.

Other contacts:

- A lighter hit on the car ahead in the same lane cites 6.4.l or 7.3.i.
- Other car contacts, static objects, kerbs and falls deduct score only.
- A contact while the ego is slower than `contactMinEgoSpeed` is never charged. A vehicle contact
  the fault table would charge gives a notice instead (`ego-slow`: the player touched it at a
  crawl and should keep a safe distance) and opens the aftermath window, so a struck, stopped
  player, or one creeping into another vehicle, still sees a notice. A pedestrian contact below
  that speed is a notice too (`pedestrian-slow`, worded neutrally, as a pedestrian may walk into a
  standing vehicle), never a deduction and never a run end. A static object or kerb touched below
  it gives nothing: it carries no penalty at any speed, and touching a kerb while parking would
  fill the screen.

### Fault table

Before a contact with a car or a motorbike is charged, `faultRows` decides whether the player is
at fault (`src/scoring/fault.js`; first match wins):

| Row | When | Result |
| --- | --- | --- |
| `aftermath` | Within `aftermathWindowS` of a notice contact (the shove), other party not a pedestrian | notice |
| `from-behind` | The other party came from behind and struck, unless a `rearEndContributingRules` episode (`lane-change`, `turn-signal`) put the player wrongly in front | notice |
| `contributing` | An episode of any rule but `nonContributingRules` (`night-horn`) is active within `crashCauseWindowS` | deduction |
| `same-lane-ahead` | The player runs into the vehicle ahead in its lane, which carries no excusing violation the player did not speed up into | deduction |
| `ego-strikes` | The player struck a vehicle that carries no excusing violation the player did not speed up into, other than a right-of-way violation of a vehicle still moving at the contact | deduction |
| `otherwise` | Anything else | notice |

The other party's violations are the flags traffic latched within `crashCauseWindowS`; a
scripted actor carries `wrong-way` while it moves against the lane it is on. Only
`excusingViolations` (`red-light`, `wrong-way`, `no-yield`, `unsafe-lane-change`) excuse a player
who strikes; a merely speeding or tailgating vehicle does not. Nor does one the player closed in
on: an excusing violation stops excusing once the player's speed at the contact (the collision
event's `egoSpeed`, not the frame's speed after the impact) is more than `excuseMaxSpeedGainMps`
(0.5 m/s, `design`) above its speed when the violation first showed on that vehicle. Another party's violation does not lift the player's own duty to observe, slow
down and keep a safe distance (10.a), so chasing a rider that cut in is the player's crash, while
a rider cutting in on a player who holds its speed is a notice. The `rightOfWayViolations`
(`red-light`, `no-yield`, `design`) are the exception: they keep excusing a player who gained
speed, unless the other vehicle was ahead in the player's lane or was standing at the contact: a
wreck, or a vehicle slower than `contactMinEgoSpeed` (0.5 m/s), such as a runner halted on the
junction connector with its flag still latched. A party crossing the player's right of way stays
at fault while the player accelerates lawfully, for example away from a green light; a standing
one is an obstacle every driver must slow down and stop for; a player who was itself speeding or running the light is charged by the `contributing`
row first. Each entry must also be in `excusingViolations`. Traffic flags a rider's cut-in
only on the step its own sideways move takes it into the player's stopping corridor; a rider the
corridor grows over as the player speeds up or steers is not cutting in. A notice carries the other
party's flags and a text from `noticeTexts`; it never states a legal conclusion. Pedestrian
contacts never enter the table, and static objects, kerbs and falls match only `aftermath`.

`paramBasis` of the collision policy gives the basis of each fault-table choice
(`nonContributingRules`, `rearEndContributingRules`, `excusingViolations`, `aftermathWindowS`,
`excuseMaxSpeedGainMps`, `rightOfWayViolations`); all are `design`, and every one the policy sets needs a basis. The rules
validator rejects a policy with a fault table and no basis for one of them.

## Lane-change gaps

The `lane-change` rule's `unsafeGap` tier fires when the player moves in front of or behind a
vehicle too closely, bumper to bumper (`src/scoring/detectors/lane-line-cross.js`). A car counts
when its centre is in the target lane; a motorbike only when its footprint overlaps the strip the
player moves into, so a rider along the far side of a wide kerb lane does not block a lawful
merge. A vehicle below `stoppedSpeedMps` (a wreck always) is too close under `gapAheadM` ahead or
`gapBehindM` behind. A moving one is too close under a moving floor: the larger of a fixed floor
and `gapTimeS` times the follower's speed (the player's for a vehicle ahead, the vehicle's own
for one behind). The fixed floor is `gapMotorbikeMinM` (2 m, `design`) for a motorbike, so a
merge into dense motorbike traffic stays possible, and `gapAheadM` or `gapBehindM` for a car.

Danger: the crash rule has two tiers. A light contact (an NPC car or a static object or kerb
below `accidentRelSpeed`) is danger 3; a pedestrian, an accident, a static or kerb hit at or above
`accidentRelSpeed`, and a fall are danger 5. A light contact followed by a heavy one in the same
episode escalates; a fall does not close an open crash episode, so a contact that knocks the rider
over is one episode at danger 5.

Fine total: an accident clause names its cause as an element of the offence ("gây tai nạn giao
thông"), so the report adds the cause's band only once. When an accident that is not inferred has
a cause with a clause, the cause's breach gets `fineAbsorbedBy` (the accident's episode id) and
its band is left out of `fineTotalVnd`. Score deductions and licence points are unchanged. A build
test keeps every clause a rule cites at or below the fine of the accident clauses of its group.

## Changing a quote

There is no generator for `data/legal/clauses.yaml`; it is maintained by hand. When a quote
changes, open the official URL of its source in `data/legal/sources.yaml`, compare the full điểm,
update the record and set `checkedOn`. `scripts/rules/check-csv.test.js`, the 10.b list test and
the validator catch a wrong value after the edit.
