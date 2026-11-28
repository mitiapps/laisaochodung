/**
 * Headless simulation (`CreateSim` in `src/contracts/modules.js`): Rapier physics for the ego plus
 * the shared world logic of `src/world/`, one `Frame` per fixed step. No three or svelte import;
 * the caller owns the fixed-timestep loop.
 *
 * One `step(input)`:
 * 1. Sanitise the input; on the first step emit `run-start`; apply a pending reset (fall or
 *    `reset()`) by placing the ego at the last passed checkpoint, or the start, and emit `reset`.
 * 2. `stepWorld` with the pre-step ego pose and indicators, the reset flag, the light states at
 *    `t` and last step's actor contacts: scripted actors, then traffic when it runs. Scripted
 *    poses go to their kinematic bodies; traffic agents near the ego to the mirror pool
 *    (`traffic-mirror.js`).
 * 3. With the auto-cancel assist, `stepSignalCancel` on the pre-step pose, which may switch the
 *    indicator off; then electrics, `vehicle.prepare` (gearbox, steering, wheels, `updateVehicle`), `world.step`.
 * 4. With traffic, `mirror.limitEgo` caps the ego velocity after a contact it drove into; drain
 *    contact forces into `collision` events and the touched actors fed to traffic next step;
 *    read the ego; a scripted fall emits `fall` and schedules the reset for the next step.
 * 5. `stepRoute` and `clockAt` at `t = tick · DT`; build the frame with the scripted poses, then
 *    the traffic poses.
 *
 * With `traffic: 'off'` (the default) or a map without a traffic block, no mirror pool exists and
 * collision events carry no attribution fields, so frames are those of a sim without traffic.
 *
 * `ego.pos.y` is the body height above its settled ride height: about 0 at rest, the suspension
 * movement otherwise, matching the frame builder's 0 on flat ground.
 */

import { DT } from '../contracts/units.js';
import { neutralInput } from '../contracts/controls.js';
import { assertMap } from '../contracts/assert-map.js';
import { footprint } from '../geometry/index.js';
import { checkTrafficParams } from '../contracts/traffic.js';
import { clockAt, createRouteState, stepRoute, trafficLightStates } from '../world/index.js';
import { createWorld, stepWorld } from '../world/traffic/index.js';
import { createVehicle } from '../physics/vehicle.js';
import { vehicleTuning } from '../physics/vehicles/index.js';
import { cancelIndicators, createElectrics, stepElectrics } from './electrics.js';
import { createSignalCancel, stepSignalCancel } from './signal-cancel.js';
import { buildWorldColliders, drainCollisions, holdContacts } from './world-colliders.js';
import { createActorBodies } from './actors.js';
import { createTrafficMirror } from './traffic-mirror.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').FrameEvent} FrameEvent */
/** @typedef {import('../contracts/modules.js').Sim} Sim */
/** @typedef {import('../contracts/modules.js').SimOptions} SimOptions */
/** @typedef {import('../contracts/controls.js').ControlAssists} ControlAssists */
/** @typedef {import('../contracts/traffic.js').TrafficParams} TrafficParams */

/** Physics steps run at creation and after each reset so the ego rests on its suspension. */
export const SETTLE_STEPS = 30;

/**
 * Clamps a number into a range; non-finite values become `fallback`.
 * @param {unknown} v Value.
 * @param {number} lo Minimum.
 * @param {number} hi Maximum.
 * @param {number} fallback Fallback.
 * @returns {number} Clamped value.
 */
function clamp(v, lo, hi, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/**
 * Normalises untrusted input: clamps analog values and drops unknown commands.
 * @param {Partial<ControlInput> | null | undefined} input Raw input.
 * @returns {ControlInput} Valid input.
 */
export function sanitizeInput(input) {
  const i = input ?? {};
  const n = neutralInput();
  return {
    throttle: clamp(i.throttle, 0, 1, n.throttle),
    brakeFront: clamp(i.brakeFront, 0, 1, n.brakeFront),
    brakeRear: clamp(i.brakeRear, 0, 1, n.brakeRear),
    steer: clamp(i.steer, -1, 1, n.steer),
    handbrake: i.handbrake === true,
    gearCmd: i.gearCmd === 'up' || i.gearCmd === 'down' ? i.gearCmd : null,
    signalCmd: i.signalCmd === 'left' || i.signalCmd === 'right' || i.signalCmd === 'hazard' ? i.signalCmd : null,
    lightsCmd: i.lightsCmd === 'cycle' || i.lightsCmd === 'flash' ? i.lightsCmd : null,
    horn: i.horn === true,
    pushBack: i.pushBack === true,
  };
}

/**
 * Validates the assists of the sim options; absent means all off.
 * @param {unknown} raw `options.assists`.
 * @returns {ControlAssists} Assists.
 */
export function parseAssists(raw) {
  if (raw === undefined) return { autoGearbox: false, signalAutoCancel: null };
  if (raw === null || typeof raw !== 'object') throw new TypeError('options.assists must be an object');
  const a = /** @type {Record<string, unknown>} */ (raw);
  const autoGearbox = a.autoGearbox ?? false;
  if (typeof autoGearbox !== 'boolean') throw new TypeError('options.assists.autoGearbox must be a boolean');
  const cancel = a.signalAutoCancel ?? null;
  if (cancel === null) return { autoGearbox, signalAutoCancel: null };
  if (typeof cancel !== 'object') throw new TypeError('options.assists.signalAutoCancel must be an object or null');
  const c = /** @type {Record<string, unknown>} */ (cancel);
  const { turnMinDeg, clearM } = c;
  if (typeof turnMinDeg !== 'number' || !(turnMinDeg > 0 && turnMinDeg < 180)) {
    throw new RangeError(`options.assists.signalAutoCancel.turnMinDeg must be in (0, 180), got ${String(turnMinDeg)}`);
  }
  if (typeof clearM !== 'number' || !Number.isFinite(clearM) || clearM < 0) {
    throw new RangeError(`options.assists.signalAutoCancel.clearM must be a finite number ≥ 0, got ${String(clearM)}`);
  }
  return { autoGearbox, signalAutoCancel: { turnMinDeg, clearM } };
}

/**
 * Validates the traffic options; traffic runs only with `traffic: 'map'` on a map with a traffic
 * block.
 * @param {SimOptions} options Options.
 * @param {GameMap} map Map.
 * @returns {{traffic: 'map' | 'off', runSeed: number, params: TrafficParams | null}} Traffic options.
 */
export function parseTraffic(options, map) {
  const traffic = options.traffic ?? 'off';
  if (traffic !== 'map' && traffic !== 'off') throw new RangeError(`options.traffic must be 'map' or 'off', got ${String(traffic)}`);
  const runSeed = options.runSeed ?? 0;
  if (!Number.isInteger(runSeed) || runSeed < 0 || runSeed > 0xffffffff) {
    throw new RangeError(`options.runSeed must be a 32-bit unsigned integer, got ${String(runSeed)}`);
  }
  if (traffic === 'off' || !map.traffic) return { traffic, runSeed, params: null };
  const problems = checkTrafficParams(options.params);
  if (problems.length > 0) throw new TypeError(`options.params are invalid traffic parameters: ${problems.slice(0, 5).join('; ')}`);
  return { traffic, runSeed, params: /** @type {TrafficParams} */ (options.params) };
}

/**
 * Creates the simulation.
 * @param {unknown} rapier Initialised `@dimforge/rapier3d-compat` module.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {SimOptions} [options] Traffic and assist options.
 * @returns {Sim} Simulation.
 */
export function createSim(rapier, map, vehicleInfo, options = {}) {
  const R = /** @type {Rapier} */ (rapier);
  if (!R || typeof R.World !== 'function' || typeof R.EventQueue !== 'function') {
    throw new TypeError('createSim needs the initialised @dimforge/rapier3d-compat module');
  }
  assertMap(map);
  if (!vehicleInfo || typeof vehicleInfo.id !== 'string') throw new TypeError('createSim needs a VehicleInfo');
  const tuning = vehicleTuning(vehicleInfo.id);
  const expectedRig = vehicleInfo.legalClass === 'car' ? 'four-wheel' : 'two-wheel';
  if (tuning.rig !== expectedRig) {
    throw new Error(`Vehicle ${vehicleInfo.id} is a ${vehicleInfo.legalClass} but its tuning uses ${tuning.rig}`);
  }
  if (options === null || typeof options !== 'object') throw new TypeError('createSim options must be an object');
  const assists = parseAssists(options.assists);
  const cancelCfg = assists.signalAutoCancel;
  const trafficOpts = parseTraffic(options, map);
  const params = trafficOpts.params;
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('options.now must be a function');
  const now = options.now ?? null;
  /** Wall time of the last step's world step and traffic mirror, in clock units; null without a clock. */
  /** @type {number | null} */
  let trafficMs = null;

  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const queue = new R.EventQueue(true);
  const tags = buildWorldColliders(R, world, map);
  const actorBodies = createActorBodies(R, world, map, tags);
  const { start } = map.route;
  const vehicle = createVehicle(R, world, tuning, map.environment.surfaceGrip, start.pos, start.heading, {
    autoGearbox: assists.autoGearbox,
  });
  const egoHandle = vehicle.collider.handle;
  // The pool exists only while traffic runs, so a sim without traffic keeps today's bodies.
  const mirror =
    params === null
      ? null
      : createTrafficMirror(R, world, tags, {
          maxMirrored: params.maxMirrored,
          mirrorRadiusM: params.mirrorRadiusM,
          egoMassKg: tuning.massKg,
          egoSize: { lengthM: 2 * tuning.chassis.halfLength, widthM: 2 * tuning.chassis.halfWidth },
          massOf: (model) => {
            const m = params.models[model];
            if (!m) throw new Error(`Traffic pose names unknown model ${model}`);
            return m.massKg;
          },
          dt: DT,
        });
  /** @type {(handle: number) => import('./world-colliders.js').ActorMotion | null} */
  const motionOf = mirror === null ? actorBodies.motionOf : (h) => actorBodies.motionOf(h) ?? mirror.motionOf(h);

  const settle = () => {
    const idle = neutralInput();
    for (let k = 0; k < SETTLE_STEPS; k += 1) {
      vehicle.prepare(idle);
      world.step(queue);
      queue.drainContactForceEvents(() => {});
    }
    vehicle.read();
  };
  settle();
  // Body origin height at rest on flat ground; frames report `pos.y` relative to it.
  const rideHeight = vehicle.body.translation().y;

  let tick = 0;
  let worldState = createWorld(map, params === null ? {} : { traffic: 'map', params, runSeed: trafficOpts.runSeed });
  let routeState = createRouteState();
  let electrics = createElectrics();
  let signalCancel = createSignalCancel();
  let pendingReset = false;
  let disposed = false;
  /** @type {import('./world-colliders.js').ContactMemory} */
  const contacts = new Map();
  /** @type {string[]} */
  let touched = [];

  /** @returns {{pos: {x: number, z: number}, heading: number}} Last passed checkpoint or the start. */
  const resetPose = () => (routeState.next > 0 ? map.route.checkpoints[routeState.next - 1] : start);

  return {
    step(rawInput) {
      if (disposed) throw new Error('Sim already disposed');
      const input = sanitizeInput(rawInput);
      const t = tick * DT;
      /** @type {FrameEvent[]} */
      const events = [];
      if (tick === 0) events.push({ type: 'run-start' });
      const egoReset = pendingReset;
      if (pendingReset) {
        const p = resetPose();
        // Mirror bodies go before the settle steps, so an ego placed inside an agent meets no body.
        mirror?.parkAll();
        vehicle.place(p.pos, p.heading);
        settle();
        contacts.clear();
        signalCancel = createSignalCancel();
        pendingReset = false;
        events.push({ type: 'reset' });
      }

      const pre = vehicle.pose();
      const lights = trafficLightStates(map, t);
      const t0 = now === null ? 0 : now();
      const ws = stepWorld(worldState, {
        ego: {
          pos: pre.pos,
          heading: pre.heading,
          speed: pre.speed,
          lengthM: vehicleInfo.lengthM,
          widthM: vehicleInfo.widthM,
          indicators: electrics.indicators,
        },
        egoReset,
        lights,
        egoContacts: touched,
        t,
      });
      worldState = ws.worldState;
      actorBodies.update(ws.scriptedPoses);
      mirror?.update(ws.trafficPoses, pre);
      if (now !== null) trafficMs = now() - t0;

      if (cancelCfg !== null) {
        const sc = stepSignalCancel(signalCancel, map, pre, electrics.indicators, cancelCfg, DT);
        signalCancel = sc.state;
        // A press on the same step wins over the cancel.
        if (sc.cancel && input.signalCmd === null) electrics = cancelIndicators(electrics);
      }
      const el = stepElectrics(electrics, input);
      electrics = el.state;

      vehicle.prepare(input);
      world.step(queue);
      mirror?.limitEgo(vehicle.body, vehicle.collider);
      const drained = drainCollisions(queue, contacts, {
        tick,
        egoHandle,
        ego: pre,
        tags,
        motionOf,
        map,
        strikerShare: params === null ? null : params.strikerShare,
      });
      holdContacts(world, vehicle.collider, tags, contacts, tick);
      events.push(...drained.events);
      touched = drained.touchedIds;

      const ego = vehicle.read();
      if (ego.fell) {
        events.push({ type: 'fall' });
        pendingReset = true;
      }
      const route = stepRoute(routeState, map, { x: ego.pos.x, z: ego.pos.z }, t);
      routeState = route.state;
      events.push(...route.events);

      /** @type {Frame} */
      const frame = {
        tick,
        t,
        ego: {
          vehicleId: vehicleInfo.id,
          legalClass: vehicleInfo.legalClass,
          pos: { x: ego.pos.x, y: ego.pos.y - rideHeight, z: ego.pos.z },
          heading: ego.heading,
          speed: ego.speed,
          velocity: ego.velocity,
          yawRate: ego.yawRate,
          gear: ego.gear,
          rpm: ego.rpm,
          input,
          indicators: el.indicators,
          lights: el.lights,
          horn: el.horn,
          wheels: ego.wheels,
          footprint: footprint(ego.pos, ego.heading, vehicleInfo.lengthM, vehicleInfo.widthM),
        },
        actors: mirror === null ? ws.scriptedPoses : [...ws.scriptedPoses, ...ws.trafficPoses],
        trafficLights: lights,
        route: route.nav,
        env: { clockMin: clockAt(map.environment, t), weather: map.environment.weather },
        events,
      };
      tick += 1;
      return frame;
    },

    reset() {
      if (disposed) throw new Error('Sim already disposed');
      pendingReset = true;
    },

    trafficMs() {
      return trafficMs;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      vehicle.dispose();
      queue.free();
      world.free();
    },
  };
}
