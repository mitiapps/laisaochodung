/**
 * Frame validation: shape, enums and finite numbers.
 */

import { Checker, ContractError } from './check.js';

/** @typedef {import('./check.js').UntrustedJson} UntrustedJson */
import { LEGAL_CLASSES } from './vehicle.js';
import {
  COLLISION_KINDS,
  EVENT_TYPES,
  GEARS,
  INDICATORS,
  LIGHT_STATES,
  LIGHTS,
  WEATHERS,
} from './telemetry.js';

/**
 * Lists every problem of a frame; empty when valid.
 * @param {unknown} frame Candidate frame.
 * @returns {string[]} Problems.
 */
export function checkFrame(frame) {
  const c = new Checker();
  if (!c.object(frame, 'frame')) return c.problems;
  const f = /** @type {UntrustedJson} */ (frame);
  c.number(f.tick, 'tick', { integer: true, min: 0 });
  c.number(f.t, 't', { min: 0 });

  if (c.object(f.ego, 'ego')) checkEgo(c, f.ego);

  if (c.array(f.actors, 'actors')) {
    f.actors.forEach((a, i) => {
      const p = `actors[${i}]`;
      if (!c.object(a, p)) return;
      c.string(a.id, `${p}.id`);
      c.oneOf(a.kind, ['pedestrian', 'car'], `${p}.kind`);
      c.pos2(a.pos, `${p}.pos`);
      c.number(a.heading, `${p}.heading`);
      c.number(a.speed, `${p}.speed`, { min: 0 });
      c.boolean(a.active, `${p}.active`);
    });
  }

  if (c.object(f.trafficLights, 'trafficLights')) {
    for (const [id, state] of Object.entries(f.trafficLights)) c.oneOf(state, LIGHT_STATES, `trafficLights.${id}`);
  }

  if (c.object(f.route, 'route')) {
    c.number(f.route.nextCheckpoint, 'route.nextCheckpoint', { integer: true, min: 0 });
    c.number(f.route.distanceM, 'route.distanceM', { min: 0 });
    c.number(f.route.bearingRad, 'route.bearingRad');
  }

  if (c.object(f.env, 'env')) {
    c.number(f.env.clockMin, 'env.clockMin', { min: 0, max: 1440 });
    if (f.env.clockMin === 1440) c.fail('env.clockMin', 'must be below 1440');
    c.oneOf(f.env.weather, WEATHERS, 'env.weather');
  }

  if (c.array(f.events, 'events')) {
    f.events.forEach((e, i) => checkEvent(c, e, `events[${i}]`));
  }
  return c.problems;
}

/**
 * @param {Checker} c Checker.
 * @param {UntrustedJson} ego Ego state (untrusted).
 * @returns {void}
 */
function checkEgo(c, ego) {
  c.string(ego.vehicleId, 'ego.vehicleId');
  c.oneOf(ego.legalClass, LEGAL_CLASSES, 'ego.legalClass');
  c.pos3(ego.pos, 'ego.pos');
  c.number(ego.heading, 'ego.heading');
  c.number(ego.speed, 'ego.speed');
  c.pos3(ego.velocity, 'ego.velocity');
  c.number(ego.yawRate, 'ego.yawRate');
  c.oneOf(ego.gear, GEARS, 'ego.gear');
  c.number(ego.rpm, 'ego.rpm', { min: 0 });
  if (c.object(ego.input, 'ego.input')) {
    const i = ego.input;
    c.number(i.throttle, 'ego.input.throttle', { min: 0, max: 1 });
    c.number(i.brakeFront, 'ego.input.brakeFront', { min: 0, max: 1 });
    c.number(i.brakeRear, 'ego.input.brakeRear', { min: 0, max: 1 });
    c.number(i.steer, 'ego.input.steer', { min: -1, max: 1 });
    c.boolean(i.handbrake, 'ego.input.handbrake');
    c.oneOf(i.gearCmd, ['up', 'down', null], 'ego.input.gearCmd');
    c.oneOf(i.signalCmd, ['left', 'right', 'hazard', null], 'ego.input.signalCmd');
    c.oneOf(i.lightsCmd, ['cycle', 'flash', null], 'ego.input.lightsCmd');
    c.boolean(i.horn, 'ego.input.horn');
  }
  c.oneOf(ego.indicators, INDICATORS, 'ego.indicators');
  c.oneOf(ego.lights, LIGHTS, 'ego.lights');
  c.boolean(ego.horn, 'ego.horn');
  if (c.array(ego.wheels, 'ego.wheels')) {
    if (ego.wheels.length === 0) c.fail('ego.wheels', 'expected at least one wheel');
    ego.wheels.forEach((w, i) => {
      const p = `ego.wheels[${i}]`;
      if (!c.object(w, p)) return;
      c.boolean(w.contact, `${p}.contact`);
      c.number(w.skid, `${p}.skid`, { min: 0, max: 1 });
      c.number(w.steer, `${p}.steer`);
      c.number(w.spin, `${p}.spin`);
      c.number(w.compression, `${p}.compression`);
    });
  }
  if (c.array(ego.footprint, 'ego.footprint')) {
    if (ego.footprint.length !== 4) c.fail('ego.footprint', 'expected 4 corners');
    else ego.footprint.forEach((p, i) => c.vec2(p, `ego.footprint[${i}]`));
  }
}

/**
 * @param {Checker} c Checker.
 * @param {UntrustedJson} e Event (untrusted).
 * @param {string} p Path.
 * @returns {void}
 */
function checkEvent(c, e, p) {
  if (!c.object(e, p)) return;
  if (!c.oneOf(e.type, EVENT_TYPES, `${p}.type`)) return;
  if (e.type === 'collision') {
    c.oneOf(e.otherKind, COLLISION_KINDS, `${p}.otherKind`);
    if (e.otherId !== null) c.string(e.otherId, `${p}.otherId`);
    c.number(e.impulse, `${p}.impulse`, { min: 0 });
    c.number(e.egoSpeed, `${p}.egoSpeed`, { min: 0 });
    c.number(e.relSpeed, `${p}.relSpeed`, { min: 0 });
    c.boolean(e.sameLaneAhead, `${p}.sameLaneAhead`);
  } else if (e.type === 'checkpoint') {
    c.number(e.index, `${p}.index`, { integer: true, min: 0 });
  }
}

/**
 * Throws a `ContractError` listing every problem unless the frame is valid.
 * @param {unknown} frame Candidate frame.
 * @returns {asserts frame is import('./telemetry.js').Frame} Narrowed frame.
 */
export function assertFrame(frame) {
  const problems = checkFrame(frame);
  if (problems.length > 0) throw new ContractError('frame', problems);
}
