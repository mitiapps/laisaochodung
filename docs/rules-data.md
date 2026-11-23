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
  ships to dev builds with the "chưa kiểm chứng" badge; the release gate (`countUnverified`)
  requires none. At the moment the 8 TT 38 speed defaults and the P.130 meaning are unverified.
- **`inferred`** (tier): no điểm names the behaviour exactly, and the clause applies by
  reading. The UI shows "suy luận". Examples: the sign-and-marking catch-all for a red-light
  overshoot that stops before the crosswalk, or for going straight onto an occupied zebra.
- **`paramBasis: design`**: the threshold is the game's own, not the law's ("ngưỡng của trò
  chơi"). Breaches list these in `designParams`.

## Supersession

One act gives one breach. `supersedes: [{ruleId, decreeGroups?}]` makes a rule win over others
in the listed groups (both groups when omitted):

- `wrong-way` wins over `no-entry` and `wrong-side`.
- `banned-turn` wins over `turn-signal` for motorbikes only, where both cite 7.3.a.

A superseded rule is dropped when its superseding rule is active in the same step or still has
an open episode. An emitted breach cannot be taken back, so a superseding detector must fire no
later than the rule it supersedes. Wrong-way fires on the P.102 entry crossing itself, and both
junction-turn rules fire on the junction exit.

## Collision policy

A pedestrian hit, or an NPC car hit at or above `accidentImpulse`, is an accident:

- It cites 10.b (`accidentB`) when the cause's clause is in `accidentBList`, and 10.a
  (`accidentA`) otherwise, including when there is no cause.
- `accidentBList` copies the lists quoted in 6.10.b and 7.10.b, and a test keeps the two
  equal.
- The cause is the worst other breach active in the last `crashCauseWindowS`.
- A cause in `inferredAccidentCauses` (a clause id or a rule id) marks the accident as
  inferred. `pavement` is listed by rule id because its motorbike clause, 7.7.a, also covers
  wrong-way riding, which 7.10.a names.

Other contacts:

- A lighter hit on the car ahead in the same lane cites 6.4.l or 7.3.i.
- Other car contacts, static objects, kerbs and falls deduct score only.
- Any contact while the ego is slower than `contactMinEgoSpeed` is ignored.
