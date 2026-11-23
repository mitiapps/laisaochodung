/**
 * Map contract: the built map JSON (`schemaVersion: 1`) read by the sim, renderer, scorer and
 * frame builder. Every map element id is unique across the whole map.
 *
 * Invariants (checked by `assertMap` where they are checkable):
 * - A polygon is a ring of at least 3 `[x, z]` points listed once: the closing edge from the last
 *   point back to the first is implied, and the last point must not repeat the first.
 * - Each lane `centerline` runs in the lane's direction of travel.
 * - A road's lanes with `dir: 'forward'` travel along the road's reference direction (the direction
 *   of its `laneLines` polylines); `backward` lanes travel against it. `index` 0 is the lane next to
 *   the kerb on the right of its own direction, growing to the left.
 * - Left and right of a lane line are taken relative to its polyline direction.
 * - Zones already encode the QCVN 41 Điều 26 scope: they end at the next junction or end sign. A zone
 *   binds only the lanes in `laneIds`; consumers test lane membership and polygon containment.
 * - Speed-limit zones come only from a placed sign (`override`) or a tutorial source, never from OSM
 *   `maxspeed`. `default` zones carry statutory defaults (TT 38) and no sign.
 * - `stopLines[].control` is one resolved value; the converter already applied the QCVN 41 Điều 4
 *   order (lights over signs over markings).
 * - A sign `heading` is the travel heading of the traffic the sign faces.
 * - Every map lies inside an R.420 built-up zone in the MVP.
 */

/** @typedef {import('./telemetry.js').Vec2} Vec2 */
/** @typedef {import('./telemetry.js').Pos2} Pos2 */
/** @typedef {Vec2[]} Polygon Ring of `[x, z]`, closing edge implied. */
/** @typedef {Vec2[]} Polyline Open chain of `[x, z]`, at least 2 points. */
/** @typedef {[Vec2, Vec2]} Segment Line segment. */

/**
 * @typedef {object} MapEnvironment
 * @property {number} startClockMin Minute of day at `t = 0`.
 * @property {import('./telemetry.js').Weather} weather Weather for the whole run.
 * @property {number} surfaceGrip Grip multiplier, 1 for dry asphalt; rain maps use less.
 */

/**
 * @typedef {object} RouteCheckpoint
 * @property {Pos2} pos Gate centre.
 * @property {number} heading Travel heading through the gate.
 */

/**
 * @typedef {object} MapRoute
 * @property {{pos: Pos2, heading: number}} start Ego start pose.
 * @property {RouteCheckpoint[]} checkpoints Gates in driving order.
 * @property {{polygon: Polygon}} finish Finish area, counted after every checkpoint.
 * @property {number} timeLimitS Run time limit in seconds.
 */

/**
 * @typedef {object} Lane
 * @property {string} id Lane id.
 * @property {'forward' | 'backward'} dir Direction relative to the road reference direction.
 * @property {number} index 0 next to the right kerb of its own direction, growing leftwards.
 * @property {Polygon} polygon Lane area.
 * @property {Polyline} centerline Centre line in the direction of travel.
 */

/**
 * Painted line between two lanes (or a lane and the edge when one side is null).
 * @typedef {object} LaneLine
 * @property {string} id Line id.
 * @property {string | null} left Lane on the left of the polyline direction.
 * @property {string | null} right Lane on the right of the polyline direction.
 * @property {'dashed' | 'solid' | 'double-solid' | 'mixed'} type QCVN 41 marking kind.
 * @property {Polyline} polyline Line geometry.
 * @property {'both' | 'left-to-right' | 'right-to-left' | 'none'} crossable Lawful crossing direction.
 */

/**
 * @typedef {object} Road
 * @property {string} id Road id.
 * @property {number} [osmWayId] Source OSM way id.
 * @property {string} class Road class, e.g. the OSM `highway` value.
 * @property {boolean} divided Physically divided carriageways.
 * @property {boolean} oneway One-way road: all lanes are `forward`.
 * @property {Lane[]} lanes Lanes.
 * @property {LaneLine[]} laneLines Painted lines between lanes.
 */

/**
 * @typedef {object} Junction
 * @property {string} id Junction id.
 * @property {Polygon} polygon Junction area (the edge from which the 5 m range counts).
 * @property {string[]} roadIds Roads meeting here.
 * @property {boolean} signalized Controlled by traffic lights.
 * @property {boolean} roundabout Roundabout.
 * @property {string[]} priorityRoadIds Roads with priority; empty when none or signalised.
 */

/**
 * @typedef {object} Zone
 * @property {string} id Zone id.
 * @property {'speed-limit' | 'built-up' | 'no-stopping' | 'junction-buffer' | 'lit'} type Zone kind.
 * @property {Polygon} polygon Zone area.
 * @property {string[]} laneIds Lanes the zone binds.
 * @property {number} [valueKmh] Limit for `speed-limit` zones.
 * @property {string[]} signIds Signs that create the zone (empty for `default`).
 * @property {'override' | 'default' | 'tutorial'} source Where the zone comes from: `override` a
 *   sign placed in an OSM map's overrides, `tutorial` a tutorial source, `default` derived by the
 *   converter from a statutory default (junction buffers).
 */

/**
 * @typedef {object} StopLine
 * @property {string} id Stop line id.
 * @property {Segment} segment Line across the controlled lanes.
 * @property {string[]} laneIds Lanes that must stop here.
 * @property {'signal' | 'stop-sign' | 'give-way'} control Resolved control.
 * @property {string} [signalId] Required when `control` is `signal`.
 */

/**
 * Light cycle in seconds, phase order green → yellow → red. `offset` is how far into the cycle the
 * light is at `t = 0`: the phase position is `(t + offset) mod (green + yellow + red)`.
 * @typedef {object} SignalCycle
 * @property {number} green Green duration.
 * @property {number} yellow Yellow duration.
 * @property {number} red Red duration.
 * @property {number} offset Cycle position at `t = 0`.
 */

/**
 * Traffic-light head.
 * @typedef {object} Signal
 * @property {string} id Signal id.
 * @property {Pos2} pos Head position.
 * @property {number} heading Travel heading of the traffic it controls.
 * @property {string[]} stopLineIds Stop lines it controls.
 * @property {SignalCycle} cycle Light cycle.
 */

/**
 * @typedef {object} Crosswalk
 * @property {string} id Crosswalk id.
 * @property {Polygon} polygon Zebra area (QCVN 41 marking 7.3).
 * @property {string} [signalId] Vehicle signal that governs traffic over it.
 */

/**
 * @typedef {object} Restriction
 * @property {string} id Restriction id.
 * @property {string} junctionId Junction where it applies.
 * @property {string[]} fromLaneIds Approach lanes it binds.
 * @property {('left' | 'right' | 'uturn')[]} banned Banned manoeuvres.
 * @property {string} signId Sign that creates it.
 */

/**
 * @typedef {object} Entry
 * @property {string} id Entry id.
 * @property {Segment} segment Entry line.
 * @property {number} heading Travel heading that is banned across the line.
 * @property {('car' | 'motorbike' | 'moped' | 'all')[]} bannedClasses Banned classes.
 * @property {string} signId Sign that creates it.
 */

/**
 * @typedef {object} Pavement
 * @property {string} id Pavement id.
 * @property {Polygon} polygon Pavement (vỉa hè) area.
 */

/**
 * @typedef {object} MapSign
 * @property {string} id Sign id.
 * @property {string} code QCVN 41 code from `data/signs/signs.yaml`, e.g. `P.127`.
 * @property {number} [value] Number shown on the sign (km/h for P.127 and DP.134).
 * @property {Pos2} pos Post position.
 * @property {number} heading Travel heading of the traffic the sign faces.
 * @property {'osm' | 'override' | 'tutorial'} source Where the placement comes from.
 */

/**
 * @typedef {object} Obstacle
 * @property {string} id Obstacle id.
 * @property {'building' | 'parked-car' | 'barrier'} kind Obstacle kind.
 * @property {Polygon} footprint Ground footprint.
 * @property {number} height Height in metres.
 */

/** @typedef {{polygon: Polygon}} PolygonTrigger Starts when the ego footprint overlaps the polygon. */
/** @typedef {{atS: number}} TimeTrigger Starts at run time `t ≥ atS` seconds. */

/**
 * Scripted actor. It moves along `path` at `speed` once triggered and holds while the ego blocks
 * its path (see `src/world/actors.js`). A looping path is closed: the actor returns from the last
 * point to the first. A non-looping actor stops at the last point and becomes inactive.
 * @typedef {object} MapActor
 * @property {string} id Actor id.
 * @property {'pedestrian' | 'car'} kind Actor kind.
 * @property {string} model Renderer model key: `npc-sedan`, `npc-hatchback` or `pedestrian`; an
 *   unknown key renders as a generic box car or a primitive pedestrian.
 * @property {number} lengthM Length along the path.
 * @property {number} widthM Width across the path.
 * @property {Polyline} path Path; the actor starts at its first point.
 * @property {number} speed Cruise speed in m/s.
 * @property {PolygonTrigger | TimeTrigger} trigger Start condition.
 * @property {boolean} loop Closed looping path.
 */

/**
 * @typedef {object} GameMap
 * @property {1} schemaVersion Schema version.
 * @property {string} id Map id.
 * @property {import('./vehicle.js').LocalText} name Display name.
 * @property {'tutorial' | 'osm'} kind Map kind.
 * @property {string} [attribution] Required on OSM maps: "© OpenStreetMap contributors, ODbL".
 * @property {{lat: number, lon: number}} [origin] Projection origin of OSM maps.
 * @property {MapEnvironment} environment Clock, weather and grip.
 * @property {MapRoute} route Start, checkpoints, finish and time limit.
 * @property {Road[]} roads Roads.
 * @property {Junction[]} junctions Junctions.
 * @property {Zone[]} zones Zones.
 * @property {StopLine[]} stopLines Stop and give-way lines.
 * @property {Signal[]} signals Traffic-light heads (not turn signals).
 * @property {Crosswalk[]} crosswalks Pedestrian crossings.
 * @property {Restriction[]} restrictions Turn bans.
 * @property {Entry[]} entries No-entry lines.
 * @property {Pavement[]} pavements Pavements.
 * @property {MapSign[]} signs Placed signs.
 * @property {Obstacle[]} obstacles Static obstacles.
 * @property {MapActor[]} actors Scripted actors.
 */

/** Current map schema version. */
export const MAP_SCHEMA_VERSION = 1;

/** Map collections whose elements carry an id, in validation order. */
export const MAP_COLLECTIONS = Object.freeze([
  'roads',
  'junctions',
  'zones',
  'stopLines',
  'signals',
  'crosswalks',
  'restrictions',
  'entries',
  'pavements',
  'signs',
  'obstacles',
  'actors',
]);

export const ZONE_TYPES = Object.freeze(['speed-limit', 'built-up', 'no-stopping', 'junction-buffer', 'lit']);
export const ZONE_SOURCES = Object.freeze(['override', 'default', 'tutorial']);
export const LANE_LINE_TYPES = Object.freeze(['dashed', 'solid', 'double-solid', 'mixed']);
export const CROSSABLE = Object.freeze(['both', 'left-to-right', 'right-to-left', 'none']);
export const STOP_CONTROLS = Object.freeze(['signal', 'stop-sign', 'give-way']);
export const MANOEUVRES = Object.freeze(['left', 'right', 'uturn']);
export const ENTRY_CLASSES = Object.freeze(['car', 'motorbike', 'moped', 'all']);
export const SIGN_SOURCES = Object.freeze(['osm', 'override', 'tutorial']);
export const OBSTACLE_KINDS = Object.freeze(['building', 'parked-car', 'barrier']);
export const ACTOR_KINDS = Object.freeze(['pedestrian', 'car']);
