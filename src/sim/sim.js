/**
 * Headless simulation (`CreateSim` in `src/contracts/modules.js`): Rapier physics for the ego plus
 * the shared world logic of `src/world/`, one `Frame` per fixed step. No three or svelte import;
 * the caller owns the fixed-timestep loop.
 *
 * One `step(input)`:
 * 1. Sanitise the input; on the first step emit `run-start`; apply a pending reset (fall or
 *    `reset()`) by placing the ego at the last passed checkpoint, or the start, and emit `reset`.
 * 2. `stepActors` with the ego footprint before the step; mirror the poses onto kinematic bodies.
 * 3. With the auto-cancel assist, `stepSignalCancel` on the pre-step pose, which may switch the
 *    indicator off; then electrics, `vehicle.prepare` (gearbox, steering, wheels, `updateVehicle`), `world.step`.
 * 4. Drain contact forces into `collision` events; read the ego; a scripted fall emits `fall`
 *    and schedules the reset for the next step.
 * 5. `stepRoute`, `trafficLightStates` and `clockAt` at `t = tick · DT`; build the frame.
 *
 * `ego.pos.y` is the body height above its settled ride height: about 0 at rest, the suspension
 * movement otherwise, matching the frame builder's 0 on flat ground.
 */

import { DT } from '../contracts/units.js';
import { neutralInput } from '../contracts/controls.js';
import { assertMap } from '../contracts/assert-map.js';
import { footprint } from '../geometry/index.js';
import { clockAt, createActorState, createRouteState, stepActors, stepRoute, trafficLightStates } from '../world/index.js';
import { createVehicle } from '../physics/vehicle.js';
import { vehicleTuning } from '../physics/vehicles/index.js';
import { cancelIndicators, createElectrics, stepElectrics } from './electrics.js';
import { createSignalCancel, stepSignalCancel } from './signal-cancel.js';
import { buildWorldColliders, drainCollisions } from './world-colliders.js';
import { createActorBodies } from './actors.js';

/** @typedef {typeof import('@dimforge/rapier3d-compat').default} Rapier */
/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/vehicle.js').VehicleInfo} VehicleInfo */
/** @typedef {import('../contracts/controls.js').ControlInput} ControlInput */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').FrameEvent} FrameEvent */
/** @typedef {import('../contracts/modules.js').Sim} Sim */
/** @typedef {import('../contracts/modules.js').SimOptions} SimOptions */
/** @typedef {import('../contracts/controls.js').ControlAssists} ControlAssists */

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
 * Creates the simulation.
 * @param {unknown} rapier Initialised `@dimforge/rapier3d-compat` module.
 * @param {GameMap} map Map.
 * @param {VehicleInfo} vehicleInfo Vehicle.
 * @param {SimOptions} [options] Options; only `assists` is read here.
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
  let actorState = createActorState(map);
  let routeState = createRouteState();
  let electrics = createElectrics();
  let signalCancel = createSignalCancel();
  let pendingReset = false;
  let disposed = false;
  /** @type {import('./world-colliders.js').ContactMemory} */
  const contacts = new Map();

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
      if (pendingReset) {
        const p = resetPose();
        vehicle.place(p.pos, p.heading);
        settle();
        contacts.clear();
        signalCancel = createSignalCancel();
        pendingReset = false;
        events.push({ type: 'reset' });
      }

      const pre = vehicle.pose();
      const preFootprint = footprint(pre.pos, pre.heading, vehicleInfo.lengthM, vehicleInfo.widthM);
      const actors = stepActors(actorState, map, [preFootprint], Math.abs(pre.speed), DT);
      actorState = actors.state;
      actorBodies.update(actors.poses);

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
      events.push(
        ...drainCollisions(queue, contacts, {
          tick,
          egoHandle,
          ego: pre,
          tags,
          motionOf: actorBodies.motionOf,
          map,
        }),
      );

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
        actors: actors.poses,
        trafficLights: trafficLightStates(map, t),
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

    dispose() {
      if (disposed) return;
      disposed = true;
      vehicle.dispose();
      queue.free();
      world.free();
    },
  };
}
