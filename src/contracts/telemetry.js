/**
 * Telemetry contract: one plain-JSON `Frame` per fixed simulation step. The live sim and the
 * kinematic frame builder both emit it; the scorer, the HUD and the renderer only read it.
 */

/** @typedef {[number, number]} Vec2 Ground point `[x, z]` in metres. */
/** @typedef {{x: number, z: number}} Pos2 Ground position. */
/** @typedef {{x: number, y: number, z: number}} Pos3 World position or vector. */

/**
 * @typedef {'R' | 'N' | 'D' | 1 | 2 | 3 | 4 | 5} Gear Car with the manual gearbox: N, R, 1–5. Car
 *   with the automatic gearbox (an assist): the selector R, N or D, never a ratio number.
 *   Automatic scooter: N, D.
 */
/** @typedef {'off' | 'left' | 'right' | 'hazard'} Indicators Turn-signal state. */
/** @typedef {'off' | 'low' | 'high'} Lights Headlight state; `high` while flashing too. */
/** @typedef {'red' | 'yellow' | 'green'} LightState Traffic-light state; no other value exists. */
/** @typedef {'clear' | 'rain'} Weather Weather, fixed per map. */

/**
 * One wheel. Order: car front-left, front-right, rear-left, rear-right; motorbike front, rear.
 * @typedef {object} WheelState
 * @property {boolean} contact Wheel touches the ground.
 * @property {number} skid 0 grip … 1 full slide; the live sim emits only 0 or 1.
 * @property {number} steer Steering angle in radians, + to the left.
 * @property {number} spin Angular speed in rad/s, + when rolling forward.
 * @property {number} compression Suspension compression in metres.
 */

/**
 * The player vehicle.
 * @typedef {object} EgoState
 * @property {string} vehicleId Catalog id.
 * @property {import('./vehicle.js').LegalClass} legalClass Legal class.
 * @property {Pos3} pos Body centre; x and z on the ground plane. y is the body's height above its
 *   settled ride height: about 0 at rest on flat ground, which every MVP map is (D3), so the
 *   renderer stands the wheels on y with no per-vehicle offset.
 * @property {number} heading Heading θ in radians (see units.js).
 * @property {number} speed Signed forward speed in m/s (negative when reversing).
 * @property {Pos3} velocity World velocity in m/s.
 * @property {number} yawRate dθ/dt in rad/s, + turning left.
 * @property {Gear} gear Selected gear.
 * @property {number} rpm Engine speed.
 * @property {import('./controls.js').ControlInput} input Input applied this step.
 * @property {Indicators} indicators Turn signals.
 * @property {Lights} lights Headlights.
 * @property {boolean} horn Horn sounding.
 * @property {WheelState[]} wheels Wheels in the documented order.
 * @property {[Vec2, Vec2, Vec2, Vec2]} footprint Body rectangle: front-left, front-right,
 *   rear-right, rear-left (see geometry `footprint`).
 */

/**
 * Rule a traffic agent broke, as a fact set from its true state whatever caused it: the front
 * crossed the stop line on red; it travelled above the limit; it travelled against the lane
 * direction; it moved into another party's path unsafely (a car that skipped its lane-change
 * safety check, or a motorbike that moved into the ego's forward corridor inside the ego's
 * stopping distance); it entered a conflict zone inside another party's critical gap; it followed
 * below its class time gap. Inattention is an incident cause, not a violation.
 * @typedef {'red-light' | 'speeding' | 'wrong-way' | 'unsafe-lane-change' | 'no-yield' | 'tailgating'} NpcViolation
 */

/**
 * Lamp state of an actor this step. Poses always point at one of the frozen `ACTOR_LIGHTS`
 * entries, never at a fresh object, so a frame with many agents allocates no lamp objects.
 * Hazard lights are `left` and `right` together.
 * @typedef {object} ActorLights
 * @property {boolean} brake Brake lamps lit.
 * @property {boolean} left Left indicator lit.
 * @property {boolean} right Right indicator lit.
 */

/** @typedef {'off' | 'brake' | 'left' | 'right' | 'brake-left' | 'brake-right' | 'hazard'} ActorLightsName */

/** @typedef {'pedestrian' | 'car' | 'motorbike'} ActorPoseKind Pose kind: taxis, buses and trucks are `car` with their own `model`. */

/**
 * The pose of a scripted map actor or a traffic agent this step. Scripted poses take model and
 * size from the map actor; traffic poses carry everything, so no consumer looks an agent up in
 * `map.actors`.
 * @typedef {object} ActorPose
 * @property {string} id Map actor id for scripted actors; `npc-<spawnIndex>` for traffic agents.
 * @property {ActorPoseKind} kind Actor kind.
 * @property {Pos2} pos Ground position of the actor centre.
 * @property {number} heading Heading θ.
 * @property {number} speed Speed this step in m/s (0 while held or idle).
 * @property {boolean} active Triggered and not yet at the end of a non-looping path; always true
 *   for a spawned traffic agent.
 * @property {string} model Renderer model key: the map actor's `model`, or a model of the traffic
 *   parameters (`TrafficParams.models`).
 * @property {number} variant Colour or livery index, an integer from 0; 0 for scripted actors.
 * @property {number} lengthM Length along the heading.
 * @property {number} widthM Width across the heading.
 * @property {ActorLights} lights One of the shared `ACTOR_LIGHTS` entries.
 * @property {'moving' | 'stopped' | 'crashed' | 'fallen'} state `moving` above 0 m/s, `stopped` at 0;
 *   `crashed` a wrecked car, `fallen` a fallen motorbike and rider.
 * @property {readonly NpcViolation[]} violations Flags true within the last `crashCauseWindowS`
 *   (latched by the traffic module). The empty case is the shared `NO_VIOLATIONS` array; scripted
 *   actors always carry it.
 */

/**
 * Navigation vector to the next target, from `stepRoute`.
 * @typedef {object} RouteNav
 * @property {number} nextCheckpoint Index of the next checkpoint; equals the checkpoint count when
 *   only the finish is left.
 * @property {number} distanceM Straight-line distance from the ego to the target.
 * @property {number} bearingRad World bearing to the target in the heading convention
 *   (0 east, π/2 north); the HUD subtracts the ego heading.
 */

/**
 * @typedef {object} FrameEnv
 * @property {number} clockMin Minute of day 0 ≤ m < 1440; advances in real time (1 s of play = 1/60 min).
 * @property {Weather} weather Weather.
 */

/**
 * Collision event. `otherId` is the actor or obstacle id, or null for kerbs and unnamed statics.
 * The fields marked optional are absent from frames recorded before traffic existed; consumers
 * default them so those frames score as before: `otherModel` null, `striker` `'ego'`,
 * `otherFromBehind` false, `otherViolations` empty.
 * @typedef {object} CollisionEvent
 * @property {'collision'} type Event type.
 * @property {'pedestrian' | 'car' | 'motorbike' | 'static' | 'kerb'} otherKind What was hit.
 * @property {string | null} otherId Map id of the other body, or the traffic agent id.
 * @property {number} impulse Contact impulse in N·s.
 * @property {number} egoSpeed Ego speed magnitude in m/s at contact.
 * @property {number} relSpeed Closing speed in m/s.
 * @property {boolean} sameLaneAhead The other car was ahead of the ego in the ego's lane.
 * @property {string | null} [otherModel] Model key of the other actor; null for statics and kerbs.
 * @property {'ego' | 'other' | 'both'} [striker] Who struck, from the closing velocities along the
 *   contact normal, using the other actor's true velocity from its pose.
 * @property {boolean} [otherFromBehind] The other party was behind the ego in the ego's lane and
 *   closing; always false while the ego is reversing.
 * @property {readonly NpcViolation[]} [otherViolations] The other actor's latched `violations`.
 */

/** @typedef {{type: 'fall'}} FallEvent Motorbike fell; the sim resets to the last checkpoint and emits `reset` next. */
/** @typedef {{type: 'checkpoint', index: number}} CheckpointEvent Checkpoint `index` reached. */
/** @typedef {{type: 'timeout'}} TimeoutEvent `t ≥ route.timeLimitS` before the finish. */
/** @typedef {{type: 'run-start'}} RunStartEvent First frame of a run. */
/** @typedef {{type: 'finish'}} FinishEvent Finish polygon entered after every checkpoint. */
/** @typedef {{type: 'reset'}} ResetEvent Ego placed back at the last checkpoint. */

/**
 * Frame event. `reset` and `fall` are discontinuities: consumers close open episodes, forget
 * previous positions and run no line-crossing test across them. Quit is never a frame event.
 * @typedef {CollisionEvent | FallEvent | CheckpointEvent | TimeoutEvent | RunStartEvent
 *   | FinishEvent | ResetEvent} FrameEvent
 */

/**
 * One fixed step of telemetry.
 * @typedef {object} Frame
 * @property {number} tick Tick index from 0.
 * @property {number} t Time in seconds, `tick · DT`.
 * @property {EgoState} ego Player vehicle.
 * @property {ActorPose[]} actors Scripted actors in map order, then active traffic agents in
 *   ascending spawn index. Consumers match poses by `id`, never by index.
 * @property {Record<string, LightState>} trafficLights State of every map signal by id.
 * @property {RouteNav} route Navigation to the next target.
 * @property {FrameEnv} env Clock and weather.
 * @property {FrameEvent[]} events Events of this step, possibly empty.
 */

/** @type {readonly Gear[]} */
export const GEARS = Object.freeze(['R', 'N', 'D', 1, 2, 3, 4, 5]);
/** @type {readonly Indicators[]} */
export const INDICATORS = Object.freeze(['off', 'left', 'right', 'hazard']);
/** @type {readonly Lights[]} */
export const LIGHTS = Object.freeze(['off', 'low', 'high']);
/** @type {readonly LightState[]} */
export const LIGHT_STATES = Object.freeze(['red', 'yellow', 'green']);
/** @type {readonly Weather[]} */
export const WEATHERS = Object.freeze(['clear', 'rain']);
/** @type {readonly string[]} */
export const COLLISION_KINDS = Object.freeze(['pedestrian', 'car', 'motorbike', 'static', 'kerb']);
/** @type {readonly ActorPoseKind[]} */
export const ACTOR_POSE_KINDS = Object.freeze(['pedestrian', 'car', 'motorbike']);
/** @type {readonly ActorPose['state'][]} */
export const ACTOR_POSE_STATES = Object.freeze(['moving', 'stopped', 'crashed', 'fallen']);
/** @type {readonly NpcViolation[]} */
export const NPC_VIOLATIONS = Object.freeze([
  'red-light',
  'speeding',
  'wrong-way',
  'unsafe-lane-change',
  'no-yield',
  'tailgating',
]);
/**
 * The shared empty `violations` list.
 * @type {readonly NpcViolation[]}
 */
export const NO_VIOLATIONS = Object.freeze([]);

/**
 * @param {boolean} brake Brake lamps.
 * @param {boolean} left Left indicator.
 * @param {boolean} right Right indicator.
 * @returns {Readonly<ActorLights>} Frozen entry.
 */
const lamps = (brake, left, right) => Object.freeze({ brake, left, right });

/**
 * The only lamp objects a pose may point at, keyed by name.
 * @type {Readonly<Record<ActorLightsName, Readonly<ActorLights>>>}
 */
export const ACTOR_LIGHTS = Object.freeze({
  off: lamps(false, false, false),
  brake: lamps(true, false, false),
  left: lamps(false, true, false),
  right: lamps(false, false, true),
  'brake-left': lamps(true, true, false),
  'brake-right': lamps(true, false, true),
  hazard: lamps(false, true, true),
});
/** @type {readonly FrameEvent['type'][]} */
export const EVENT_TYPES = Object.freeze([
  'collision',
  'fall',
  'checkpoint',
  'timeout',
  'run-start',
  'finish',
  'reset',
]);
/** Event types after which positions are not continuous. */
export const DISCONTINUITY_EVENTS = Object.freeze(['reset', 'fall']);
