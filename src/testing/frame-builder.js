/**
 * Kinematic frame builder for tests: drives a vehicle along a path with a speed and control
 * script and emits valid `Frame`s with no physics, using the same `src/world` logic as the sim
 * (light cycles, actors with hold-when-blocked, route progress, clock).
 *
 * Kinematics: the distance along the path integrates the scripted speed with the fixed DT
 * (`s[k+1] = s[k] + v[k] · DT`). The position is the path point at `s` shifted left by the
 * scripted lateral offset. The heading follows the motion (from this tick's position to the next
 * tick's) and falls back to the path tangent while stationary. Gear, rpm, wheels and the derived
 * `input` are plausible approximations, not physics; scripts may override them.
 */

import { DT, mpsToKmh } from '../contracts/units.js';
import { neutralInput } from '../contracts/controls.js';
import { footprint, headingOf, headingVector, leftVector, angleDiff, pointAtDistance, polylineLength } from '../geometry/index.js';
import { clockAt, createActorState, createRouteState, stepActors, stepRoute, trafficLightStates } from '../world/index.js';

/** @typedef {import('../contracts/index.js').GameMap} GameMap */
/** @typedef {import('../contracts/index.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/index.js').Frame} Frame */
/** @typedef {import('../contracts/index.js').FrameEvent} FrameEvent */
/** @typedef {import('../contracts/index.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/index.js').Gear} Gear */
/** @typedef {import('../contracts/index.js').Indicators} Indicators */
/** @typedef {import('../contracts/index.js').Lights} Lights */
/** @typedef {import('../contracts/index.js').Vec2} Vec2 */
/** @typedef {import('../contracts/index.js').WheelState} WheelState */

/**
 * Keyframe of a piecewise-linear script value; held constant before the first and after the last.
 * @typedef {object} Keyframe
 * @property {number} t Time in seconds.
 * @property {number} value Value at `t`.
 */

/**
 * Step change of controls from time `t` until the next entry (fields not given keep their value).
 * @typedef {object} ControlChange
 * @property {number} t Time in seconds.
 * @property {Indicators} [indicators] Turn signals.
 * @property {Lights} [lights] Headlights.
 * @property {boolean} [horn] Horn.
 * @property {Gear} [gear] Forced gear (otherwise derived from speed).
 * @property {Partial<ControlInput>} [input] Input fields to force.
 */

/**
 * Event injected at time `t` (rounded to the nearest tick).
 * @typedef {object} ForcedEvent
 * @property {number} t Time in seconds.
 * @property {FrameEvent} event Event to emit.
 */

/**
 * @typedef {object} BuildOptions
 * @property {GameMap} map Map.
 * @property {VehicleInfo} vehicle Vehicle.
 * @property {Vec2[]} [path] Driven polyline; defaults to the centreline of `laneId`.
 * @property {string} [laneId] Lane whose centreline is driven when `path` is not given.
 * @property {number} [startS] Start distance along the path, default 0.
 * @property {number} [durationS] Frames to emit, as seconds; default until the path end is reached
 *   at standstill, the run ends, or the map time limit passes.
 * @property {number | Keyframe[]} speed Speed in m/s, constant or keyframed.
 * @property {Keyframe[]} [offset] Lateral offset from the path in metres, positive left.
 * @property {ControlChange[]} [controls] Control changes.
 * @property {ForcedEvent[]} [events] Injected events (collisions, falls, resets).
 * @property {boolean} [stopAtRunEnd] Stop after the frame with `finish` or `timeout`, default true.
 */

/**
 * Value of a constant or keyframed script at `t`.
 * @param {number | Keyframe[] | undefined} script Script.
 * @param {number} t Time.
 * @returns {number} Value.
 */
export function scriptValue(script, t) {
  if (script === undefined) return 0;
  if (typeof script === 'number') return script;
  if (script.length === 0) return 0;
  if (t <= script[0].t) return script[0].value;
  for (let i = 1; i < script.length; i += 1) {
    const a = script[i - 1];
    const b = script[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      return span > 0 ? a.value + ((b.value - a.value) * (t - a.t)) / span : b.value;
    }
  }
  return script[script.length - 1].value;
}

/**
 * Centreline of a lane by id.
 * @param {GameMap} map Map.
 * @param {string} laneId Lane id.
 * @returns {Vec2[]} Centreline.
 */
export function laneCenterline(map, laneId) {
  for (const road of map.roads) {
    for (const lane of road.lanes) if (lane.id === laneId) return lane.centerline;
  }
  throw new Error(`Unknown lane "${laneId}" in map ${map.id}`);
}

/**
 * Gear a driver would use at this speed.
 * @param {VehicleInfo} vehicle Vehicle.
 * @param {number} speed Speed in m/s.
 * @returns {Gear} Gear.
 */
function derivedGear(vehicle, speed) {
  if (vehicle.gearbox === 'auto') return 'D';
  const kmh = mpsToKmh(speed);
  if (kmh < 0.5) return 'N';
  if (kmh < 15) return 1;
  if (kmh < 30) return 2;
  if (kmh < 45) return 3;
  if (kmh < 60) return 4;
  return 5;
}

/**
 * Engine speed approximation.
 * @param {Gear} gear Gear.
 * @param {number} speed Speed in m/s.
 * @returns {number} rpm.
 */
function derivedRpm(gear, speed) {
  const idle = 800;
  if (gear === 'N' || speed <= 0) return idle;
  const topKmh = typeof gear === 'number' ? gear * 15 : 60;
  return Math.min(6500, idle + (mpsToKmh(speed) / topKmh) * 4500);
}

/**
 * Builds frames from a kinematic script.
 * @param {BuildOptions} options Script.
 * @returns {Frame[]} Frames in tick order, each valid under `assertFrame`.
 */
export function buildFrames(options) {
  const { map, vehicle } = options;
  const path = options.path ?? (options.laneId ? laneCenterline(map, options.laneId) : null);
  if (!path || path.length < 2) throw new Error('buildFrames needs a path or a laneId');
  const pathLength = polylineLength(path);
  const stopAtRunEnd = options.stopAtRunEnd ?? true;
  const controls = [...(options.controls ?? [])].sort((a, b) => a.t - b.t);
  /** @type {Map<number, FrameEvent[]>} */
  const forced = new Map();
  for (const f of options.events ?? []) {
    const tick = Math.round(f.t / DT);
    forced.set(tick, [...(forced.get(tick) ?? []), f.event]);
  }
  const maxTicks =
    options.durationS !== undefined
      ? Math.round(options.durationS / DT)
      : Math.ceil(map.route.timeLimitS / DT) + 1;

  /**
   * Pose at distance `s` and time `t`.
   * @param {number} s Distance along the path.
   * @param {number} t Time.
   * @returns {{x: number, z: number, tangent: number}} Position and path heading.
   */
  const poseAt = (s, t) => {
    const at = pointAtDistance(path, s);
    const [lx, lz] = leftVector(at.heading);
    const off = scriptValue(options.offset, t);
    return { x: at.point[0] + lx * off, z: at.point[1] + lz * off, tangent: at.heading };
  };

  let s = Math.max(0, Math.min(pathLength, options.startS ?? 0));
  let actorState = createActorState(map);
  let routeState = createRouteState();
  let prevHeading = /** @type {number | null} */ (null);
  let prevSpeed = 0;
  /** @type {{indicators: Indicators, lights: Lights, horn: boolean, gear: Gear | null, input: Partial<ControlInput>}} */
  const held = { indicators: 'off', lights: 'off', horn: false, gear: null, input: {} };
  let nextControl = 0;
  /** @type {Frame[]} */
  const frames = [];

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const t = tick * DT;
    while (nextControl < controls.length && controls[nextControl].t <= t + 1e-9) {
      const ch = controls[nextControl];
      if (ch.indicators !== undefined) held.indicators = ch.indicators;
      if (ch.lights !== undefined) held.lights = ch.lights;
      if (ch.horn !== undefined) held.horn = ch.horn;
      if (ch.gear !== undefined) held.gear = ch.gear;
      if (ch.input !== undefined) held.input = { ...held.input, ...ch.input };
      nextControl += 1;
    }

    const atEnd = s >= pathLength - 1e-9;
    const speed = atEnd ? 0 : Math.max(0, scriptValue(options.speed, t));
    const here = poseAt(s, t);
    const sNext = Math.min(pathLength, s + speed * DT);
    const ahead = poseAt(sNext, t + DT);
    const moved = Math.hypot(ahead.x - here.x, ahead.z - here.z);
    const heading = moved > 1e-6 ? headingOf(ahead.x - here.x, ahead.z - here.z) : here.tangent;
    const yawRate = prevHeading === null ? 0 : angleDiff(prevHeading, heading) / DT;
    const accel = tick === 0 ? 0 : (speed - prevSpeed) / DT;
    const [fx, fz] = headingVector(heading);
    const fp = footprint({ x: here.x, z: here.z }, heading, vehicle.lengthM, vehicle.widthM);
    const gear = held.gear ?? derivedGear(vehicle, speed);
    const steer = Math.max(-1, Math.min(1, -yawRate / 0.8));
    const braking = Math.max(0, Math.min(1, -accel / 8));
    /** @type {ControlInput} */
    const input = {
      ...neutralInput(),
      throttle: accel > 0 ? Math.min(1, accel / 3) : speed > 0 ? 0.2 : 0,
      brakeFront: braking,
      brakeRear: vehicle.legalClass === 'car' ? 0 : braking * 0.5,
      steer,
      horn: held.horn,
      ...held.input,
    };
    const wheelCount = vehicle.legalClass === 'car' ? 4 : 2;
    const frontCount = vehicle.legalClass === 'car' ? 2 : 1;
    /** @type {WheelState[]} */
    const wheels = Array.from({ length: wheelCount }, (_, i) => ({
      contact: true,
      skid: 0,
      steer: i < frontCount ? -steer * 0.6 : 0,
      spin: speed / 0.3,
      compression: 0,
    }));

    const actors = stepActors(actorState, map, fp, speed, DT);
    actorState = actors.state;
    const route = stepRoute(routeState, map, { x: here.x, z: here.z }, t);
    routeState = route.state;

    /** @type {FrameEvent[]} */
    const events = [];
    if (tick === 0) events.push({ type: 'run-start' });
    events.push(...(forced.get(tick) ?? []), ...route.events);

    frames.push({
      tick,
      t,
      ego: {
        vehicleId: vehicle.id,
        legalClass: vehicle.legalClass,
        pos: { x: here.x, y: 0, z: here.z },
        heading,
        speed,
        velocity: { x: fx * speed, y: 0, z: fz * speed },
        yawRate,
        gear,
        rpm: derivedRpm(gear, speed),
        input,
        indicators: held.indicators,
        lights: held.lights,
        horn: held.horn,
        wheels,
        footprint: fp,
      },
      actors: actors.poses,
      trafficLights: trafficLightStates(map, t),
      route: route.nav,
      env: { clockMin: clockAt(map.environment, t), weather: map.environment.weather },
      events,
    });

    prevHeading = heading;
    prevSpeed = speed;
    s = sNext;
    if (stopAtRunEnd && route.events.some((e) => e.type === 'finish' || e.type === 'timeout')) break;
    if (options.durationS === undefined && atEnd && speed === 0 && scriptValue(options.speed, t) > 0) break;
  }
  return frames;
}
