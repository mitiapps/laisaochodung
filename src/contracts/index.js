/**
 * Public entry of the contracts: runtime values plus re-aliased typedefs, so consumers write
 * `import('../contracts/index.js').Frame`.
 */

export { DT, TICK_HZ, EARTH_RADIUS_M, MINUTES_PER_DAY, kmhToMps, mpsToKmh, tickTime } from './units.js';
export { LEGAL_CLASSES, DECREE_GROUPS, GEARBOXES, decreeGroupOf } from './vehicle.js';
export { KEY_BINDINGS, neutralInput } from './controls.js';
export {
  GEARS,
  INDICATORS,
  LIGHTS,
  LIGHT_STATES,
  WEATHERS,
  COLLISION_KINDS,
  EVENT_TYPES,
  DISCONTINUITY_EVENTS,
} from './telemetry.js';
export {
  MAP_SCHEMA_VERSION,
  MAP_COLLECTIONS,
  ZONE_TYPES,
  ZONE_SOURCES,
  LANE_LINE_TYPES,
  CROSSABLE,
  STOP_CONTROLS,
  MANOEUVRES,
  ENTRY_CLASSES,
  SIGN_SOURCES,
  OBSTACLE_KINDS,
  ACTOR_KINDS,
} from './map.js';
export { LICENCE_POINT_VALUES, CLAUSE_ID_PATTERN } from './rule.js';
export { ENDED_BY, LICENCE_START_POINTS } from './score.js';
export { RUN_STATUSES } from './hud.js';
export { ContractError } from './check.js';
export { assertFrame, checkFrame } from './assert-frame.js';
export { assertMap, checkMap } from './assert-map.js';

/** @typedef {import('./vehicle.js').LocalText} LocalText */
/** @typedef {import('./vehicle.js').LegalClass} LegalClass */
/** @typedef {import('./vehicle.js').DecreeGroup} DecreeGroup */
/** @typedef {import('./vehicle.js').Gearbox} Gearbox */
/** @typedef {import('./vehicle.js').VehicleInfo} VehicleInfo */

/** @typedef {import('./controls.js').ControlInput} ControlInput */
/** @typedef {import('./controls.js').ControlAction} ControlAction */
/** @typedef {import('./controls.js').KeyBinding} KeyBinding */

/** @typedef {import('./telemetry.js').Vec2} Vec2 */
/** @typedef {import('./telemetry.js').Pos2} Pos2 */
/** @typedef {import('./telemetry.js').Pos3} Pos3 */
/** @typedef {import('./telemetry.js').Gear} Gear */
/** @typedef {import('./telemetry.js').Indicators} Indicators */
/** @typedef {import('./telemetry.js').Lights} Lights */
/** @typedef {import('./telemetry.js').LightState} LightState */
/** @typedef {import('./telemetry.js').Weather} Weather */
/** @typedef {import('./telemetry.js').WheelState} WheelState */
/** @typedef {import('./telemetry.js').EgoState} EgoState */
/** @typedef {import('./telemetry.js').ActorPose} ActorPose */
/** @typedef {import('./telemetry.js').RouteNav} RouteNav */
/** @typedef {import('./telemetry.js').FrameEnv} FrameEnv */
/** @typedef {import('./telemetry.js').CollisionEvent} CollisionEvent */
/** @typedef {import('./telemetry.js').FrameEvent} FrameEvent */
/** @typedef {import('./telemetry.js').Frame} Frame */

/** @typedef {import('./map.js').Polygon} Polygon */
/** @typedef {import('./map.js').Polyline} Polyline */
/** @typedef {import('./map.js').Segment} Segment */
/** @typedef {import('./map.js').MapEnvironment} MapEnvironment */
/** @typedef {import('./map.js').RouteCheckpoint} RouteCheckpoint */
/** @typedef {import('./map.js').MapRoute} MapRoute */
/** @typedef {import('./map.js').Lane} Lane */
/** @typedef {import('./map.js').LaneLine} LaneLine */
/** @typedef {import('./map.js').Road} Road */
/** @typedef {import('./map.js').Junction} Junction */
/** @typedef {import('./map.js').Zone} Zone */
/** @typedef {import('./map.js').StopLine} StopLine */
/** @typedef {import('./map.js').SignalCycle} SignalCycle */
/** @typedef {import('./map.js').Signal} Signal */
/** @typedef {import('./map.js').Crosswalk} Crosswalk */
/** @typedef {import('./map.js').Restriction} Restriction */
/** @typedef {import('./map.js').Entry} Entry */
/** @typedef {import('./map.js').Pavement} Pavement */
/** @typedef {import('./map.js').MapSign} MapSign */
/** @typedef {import('./map.js').Obstacle} Obstacle */
/** @typedef {import('./map.js').MapActor} MapActor */
/** @typedef {import('./map.js').GameMap} GameMap */

/** @typedef {import('./rule.js').Citation} Citation */
/** @typedef {import('./rule.js').Source} Source */
/** @typedef {import('./rule.js').Range} Range */
/** @typedef {import('./rule.js').Clause} Clause */
/** @typedef {import('./rule.js').Tier} Tier */
/** @typedef {import('./rule.js').Detection} Detection */
/** @typedef {import('./rule.js').Rule} Rule */
/** @typedef {import('./rule.js').SignMeaning} SignMeaning */
/** @typedef {import('./rule.js').SpeedDefault} SpeedDefault */
/** @typedef {import('./rule.js').ScoringTable} ScoringTable */
/** @typedef {import('./rule.js').CollisionPolicy} CollisionPolicy */
/** @typedef {import('./rule.js').RulesBundle} RulesBundle */

/** @typedef {import('./score.js').Breach} Breach */
/** @typedef {import('./score.js').ScoreContext} ScoreContext */
/** @typedef {import('./score.js').ScoreReport} ScoreReport */

/** @typedef {import('./modules.js').ScorerStep} ScorerStep */
/** @typedef {import('./modules.js').Scorer} Scorer */
/** @typedef {import('./modules.js').CreateScorer} CreateScorer */
/** @typedef {import('./modules.js').ScoreRun} ScoreRun */
/** @typedef {import('./modules.js').Sim} Sim */
/** @typedef {import('./modules.js').CreateSim} CreateSim */
/** @typedef {import('./modules.js').Renderer} Renderer */
/** @typedef {import('./modules.js').CreateRenderer} CreateRenderer */

/** @typedef {import('./catalog.js').MapIndexEntry} MapIndexEntry */
/** @typedef {import('./catalog.js').Credit} Credit */

/** @typedef {import('./hud.js').HudState} HudState */
/** @typedef {import('./hud.js').GameApi} GameApi */
