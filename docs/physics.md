# Physics

The headless simulation (`src/sim/`) drives Rapier (`@dimforge/rapier3d-compat`, `^0.21.0`) at the
fixed step `DT = 1/60` s and emits one `Frame` per step. Vehicle physics lives in `src/physics/`;
world logic (lights, actors, route) comes from `src/world/` and is not copied here.

## Step order

`sim.step(input)`:

1. Sanitise the input. Tick 0 carries `run-start`. A pending reset (after a fall or `reset()`)
   places the ego at the last passed checkpoint, or the start, and the frame carries `reset`.
2. `stepWorld` with the ego pose and indicators before the step: scripted actors, then traffic when
   it runs. Scripted kinematic bodies, and the mirror bodies of traffic agents near the ego, move
   to the returned poses during this step's `world.step`, so contacts see their real velocity (one
   step behind the pose logic).
3. With the indicator auto-cancel assist, `stepSignalCancel`; then electrics and
   `vehicle.prepare`: gearbox, rate-limited steering, per-wheel commands, drag impulse, grip
   update and `updateVehicle(DT)`; then `world.step(eventQueue)`.
4. `limitEgo` of the traffic mirror caps the ego velocity after a contact it drove into (see
   Collisions below). Contact-force events of the chassis become `collision` events, one per
   contact episode and other body (re-armed after `COLLISION_REARM_S` without contact,
   `src/sim/world-colliders.js`). A scripted fall emits `fall` and schedules the reset for the
   next step.
5. `stepRoute`, `trafficLightStates` and `clockAt` at `t = tick · DT`.

The frame of tick k shows the state after k + 1 physics steps, labelled `t = k · DT`. The sim also
runs `SETTLE_STEPS` settle steps (`src/sim/sim.js`, not reported) at creation and after each
reset, so the vehicle rests on its suspension. `ego.pos.y` is the body height above its settled ride height: about 0 at rest, matching
the frame builder.

## Traffic around the player

Traffic (`src/world/traffic/`) treats the player's vehicle as a party it perceives, never as one of
its agents. Two of its rules are visible in play:

- **A standing player closes the lane.** Once the player has stood still for `EGO_PARKED_S`
  (`src/world/traffic/index.js`, longer than a red phase) during the run, traffic treats the
  lanes under the vehicle as closed, as for a parked car, and changes lane round it instead of
  queueing behind it for ever. Moving off reopens them. The traffic pre-roll before the run does
  not count towards that time.
- **Lanes that merge take turns.** Where two lanes of one road go straight on into one exit lane,
  vehicles join it one behind the other, nearest first, and a vehicle that has waited longer at
  the line goes before one rolling up beside it. Straight paths of one road into different exit
  lanes run side by side, so a bus going straight never waits for riders on the lane beside it.

Agents spawn around the player within the map's spawn ring and leave once they are well behind it
or beyond the ring; no agent is spawned where those rules would remove it within a second.

## Rigs

Chassis space is +X forward, +Y up, +Z right, so the body rotation about +Y equals the heading θ.
Rapier's positive steering angle turns left, matching `WheelState.steer`; `ControlInput.steer` +1
is right, so the sim negates it.

- **Car (`rigs/four-wheel.js`)**: four ray wheels, front steer, rear drive. One pedal splits into
  the per-wheel caps `brakes.frontCap` and `brakes.rearCap`, front-heavy. Handbrake: the rear cap
  `brakes.handbrakeCap` and the rear side stiffness `brakes.handbrakeSideStiffness` (all in
  `vehicles/car-sedan.js`). A braking wheel never gets engine force. The chassis pitches on its
  suspension, so load transfer is real.
- **Scooter (`rigs/two-wheel.js`)**: rig A, two in-line ray wheels with
  `setEnabledRotations(false, true, false, true)`. The locks are world-axis, so the rig is valid on
  flat maps only. Independent front and rear brake caps (`brakes.frontCap`, `brakes.rearCap` in
  `vehicles/scooter.js`). Its `suspension.stiffness` is higher than the car's because Rapier
  scales the spring by chassis mass per wheel and only two wheels carry the load.

Brake values are Rapier impulse caps per step (not forces), so they depend on `DT`. They stay
bounded; caps around 1e4 pushed the chassis backwards in the research smoke test.

## Grip model

Rapier limits each wheel to `hypot(0.5·F, S) ≤ N · DT · frictionSlip`, so a wheel grips twice as
hard forwards as sideways. With the braking calibration of `frictionSlip` that left half the
braking grip for cornering, and a 20 m radius turn at 30 km/h flagged a skid at every step. The
isotropic correction (`skid.js`, `isotropicFrictionSlip`) scales `frictionSlip` each step by
`2·hypot(0.5·F, S) / hypot(F, S)` from the previous step's impulses. Pure braking keeps
`frictionSlip` and pure cornering gets twice it, so the limit is
`hypot(F, S) ≤ N · DT · 2 · frictionSlip` in every direction (µ ≈ 0.75 with the shipped tunings).

`map.environment.surfaceGrip` (set per map, lower in rain) multiplies `frictionSlip`.

## Danger cues

- **Skid** (`skid.js`): a grounded wheel above `SKID_MIN_SPEED_MPS` slides when
  `hypot(0.5·F, S) ≥ SKID_BUDGET_FRACTION · N · DT · frictionSlip`, or when the chassis lateral
  speed exceeds `SKID_LATERAL_SPEED_MPS`. `WheelState.skid` is 1 while sliding, else 0.
- **Fall** (`fall.js`): a front skid that starts above `fall.minSpeedKmh` and lasts more than
  `fall.holdS` (`vehicles/scooter.js`).
- **Collisions**: the chassis collider has contact-force events above
  `CONTACT_FORCE_THRESHOLD_N` (`vehicle.js`). One body is a kind plus a map id, so the wall boxes
  of one obstacle count as one body, and so do all kerbs. The same body re-arms after
  `COLLISION_REARM_S` without contact.
  Traffic agents touch the ego through kinematic mirror bodies (`src/sim/traffic-mirror.js`). An
  agent that reaches the ego pushes it at the momentum-share velocity `v · m_npc / (m_npc + m_ego)`.
  An ego that drives into an agent (its velocity along the agent's push direction below
  `-CLOSING_MPS`) latches a cap at the first touch: the perfectly inelastic common velocity
  `(m_npc · v_npc + m_ego · v_ego) / (m_npc + m_ego)` along that direction, clamped between 0 and
  the momentum-share velocity. The body pushes at the cap, and after each `world.step`, while the
  two still touch, the velocity the contact impulse added to the ego along that direction, and
  along the contact normal, is trimmed so the ego leaves no faster than the body moves that way;
  what the ego has without the impulse, such as reversing away under its own drive, stands. The cap is needed because a kinematic body is
  immovable: without it the ego would rebound backwards off an oncoming agent at about the
  momentum-share velocity, and off a standing one from Rapier's rigid contact (chassis pitch and
  suspension unwinding). `src/sim/traffic-mirror.test.js` (head-on contact) holds the ego, a car or
  a scooter driving into oncoming and standing agents, to at most the common velocity plus 0.2 m/s
  along the push direction after the contact, and (oblique head-on contact) a car that meets an
  oncoming car at an angle to at most 0.2 m/s backwards. An ego that is not closing never takes this path. Scripted actor bodies (`src/sim/actors.js`) have no cap.
  `impulse` is the peak contact force times `DT` in the first contact step. `egoSpeed` is the ego
  speed before the step. `relSpeed` is the closing speed along the contact force direction.
  `sameLaneAhead` is set for a car whose centre lies in the lane polygon holding the ego centre,
  ahead of the ego.
- **World colliders** (`src/sim/world-colliders.js`): one ground box under the map, kerb boxes of
  `KERB_HEIGHT_M` (`src/contracts/units.js`) along every pavement edge, and walls along every obstacle footprint edge. Wheel rays ride
  over the kerb rim, and the chassis clears it, so a `kerb` collision needs a bottomed-out chassis.
  The pavement surface itself is at road level. Wheel
  rays see only ground and kerbs. There is no finish sensor, because `stepRoute` owns the finish.

## Spike result (rig A)

Rig A passed its gate on flat ground with the isotropic correction; rig B (four narrow rays) was
not needed.

| Check | Result |
| --- | --- |
| 20 m radius at 30 km/h | max radial error 0.17 m, no skid, roll and pitch exactly 0 |
| 50 km/h, front 0.5 plus rear full, dry | 15.1 m, no front skid |
| 50 km/h, front only, full, dry | front skid, falls |

With pitch locked there is no load transfer: the front wheel locks at the same lever whether the
rear brake is on or not.

- **Dry:** the front is safe up to about 0.6 of the lever, and from 0.65 it locks and the scooter
  falls above the fall speed.
- **Rain (grip 0.6):** the safe front lever is about 0.35.

A load-transfer emulation, with front grip rising under deceleration, was tried. Measured from a
clean start, it left a window of only about one cap unit in which front-only locks but front
plus rear does not. That did not survive a ±5 % cap change, so it was dropped.

## Calibration

The tests next to the code calibrate the tuning (`vehicles/*.js`). The bench (`bench.js`) puts one
vehicle on a flat box, sets it to 50 km/h and holds the input until it stops:

| Vehicle, input | Dry | Rain (grip 0.6) |
| --- | --- | --- |
| Car, full pedal | 12.7 m, skids (friction-limited) | 21.2 m |
| Car, pedal 0.2 | 34.3 m, no skid (cap-limited) | |
| Scooter, front 0.5 plus rear full | 15.1 m | |
| Scooter, front 0.6 plus rear full | 13.8 m | front 0.35: 21.7 m, no fall |
| Scooter, front only, full | 24.1 m, falls | |

The target is `v² / (2µg)` ≈ 13 m at µ ≈ 0.75, with a tolerated window of 11 to 16 m. To
re-tune, change `frictionSlip` or the caps in `vehicles/<id>.js` and run
`npx vitest run src/physics src/sim`.

Mass, gear ratios and final drive, torque, limiter, the reverse lockout speed, the scooter's CVT
force curve and the speed at which the steering lock halves (`steering.refSpeedMps`) live in
`vehicles/car-sedan.js` and `vehicles/scooter.js`.

## Assists

The Đơn giản preset ([controls.md](controls.md)) turns on three assists; none performs a scored
duty.

- **Auto-shift (car).** The gear keys move a selector R ← N ← D; in D the box shifts up one gear
  at `upRpm` while the throttle is open and down at `downRpm` to the highest lower gear that turns
  above it, never twice within `minIntervalS`, and moves off in first below a crawl
  (`src/physics/gearbox.js`, values `design` in `gearbox.autoShift` of `vehicles/car-sedan.js`).
  Measured: 0–60 km/h in 8.9 s against 8.4 s on the test driver's manual schedule, up-shifts at
  17.5, 28.8, 42.9 and 60.0 km/h; 30 km/h holds 3rd at about 1,450 rpm and 50 km/h holds 4th at
  about 1,730 rpm. The lowest rpm right after an up-shift (`upRpm` times the next gear's ratio
  over the current one, lowest on the 1–2 shift) stays above `downRpm`, so the box cannot hunt.
- **Combined brake (scooter).** The brake key adds rear brake `combinedRearPerGrip × grip`
  (`design`, `vehicles/scooter.js`) to the capped front brake
  `SCOOTER_FRONT_BRAKE_PER_GRIP × grip` (`src/game/input.js`). Measured on a straight stop from
  50 km/h: dry 14.5 m in 2.1 s, grip 0.6 23.7 m in 3.5 s, with no skid and no fall at either
  grip.
- **Indicator auto-cancel.** After a signalled junction turn of at least the `turn-signal` rule's
  `turnMinDeg`, the indicator switches off once no junction lies within its `signalFromM` ahead.

## Determinism

The plain Rapier build is deterministic on one machine and build: two sims fed the same input
script give identical frames (tested). Cross-platform replays would need the deterministic
build, which the MVP does not use.
