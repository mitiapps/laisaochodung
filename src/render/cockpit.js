/**
 * The cockpit drawn in the first-person view, mounted in the ego's leaning frame (+X forward, +Y
 * up, +Z right of the vehicle centre on the ground). Untextured Lambert with vertex colours, two
 * meshes, so it costs two draw calls where the hidden body cost more:
 *
 * - car (left-hand drive): dash, bonnet in the body colour, A-pillars and a dark interior
 *   mirror housing in one mesh, and a steering wheel that turns with the front-wheel steer. The
 *   bonnet is drawn low and sloping (front edge at 0.6 m), so the road shows from about two metres
 *   ahead of the front; at the sedan's real 0.9 m it would hide about seven metres from a 1.2 m eye.
 * - motorbike: the dash cowl in the body colour with its speedometer face in one mesh, and the
 *   handlebar with grips and mirror stalks, which turns with the steer.
 *
 * No live mirrors: a second scene pass halves the frame rate of a software rasteriser. The mirror
 * heads are dark and reflect nothing; the chase camera is the way to look behind.
 */

import { BoxGeometry, DoubleSide, Group, Mesh, MeshLambertMaterial, TorusGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TriangleSoup } from './triangle-soup.js';

/** @typedef {[number, number, number]} Vec3 */

/** Local origin of the soups: the cockpit frame itself. */
const ORIGIN = Object.freeze({ x: 0, z: 0 });
/** Turn of the drawn steering wheel per radian of front-wheel steer (a steering ratio, design). */
export const WHEEL_TURN_PER_STEER = 4;
/** Rake of the steering wheel: its top leans back toward the driver by this angle (design). */
const WHEEL_RAKE_RAD = (25 * Math.PI) / 180;

const DASH = 0x3a3d42;
const PILLAR = 0x2c2e31;
const MIRROR = 0x2a2b2d;
const WHEEL = 0x2a2a2d;
const BAR = 0x8a8d90;
const GRIP = 0x1a1a1a;
const SPEEDO = 0x1c1c1c;

/**
 * @typedef {object} Cockpit
 * @property {Group} group Group to mount on the ego.
 * @property {(steerRad: number) => void} update Turn the wheel or handlebar for a front-wheel steer
 *   angle (+ to the left, as `WheelState.steer`).
 * @property {() => void} dispose Free geometry and materials.
 */

/**
 * Adds a flat quad strip between two points with a width along X, facing either way.
 * @param {TriangleSoup} soup Soup.
 * @param {Vec3} from Lower point.
 * @param {Vec3} to Upper point.
 * @param {number} depth Width along −X.
 */
function strut(soup, from, to, depth) {
  const a = from;
  const b = /** @type {Vec3} */ ([from[0] - depth, from[1], from[2]]);
  const c = /** @type {Vec3} */ ([to[0] - depth, to[1], to[2]]);
  const d = to;
  soup.addQuad(a, b, c, d, [0, 0, -Math.sign(from[2]) || 1]);
}

/**
 * The car cockpit for a footprint.
 * @param {number} color Body colour.
 * @param {number} lengthM Vehicle length.
 * @param {number} widthM Vehicle width.
 * @param {MeshLambertMaterial} material Vertex-coloured material.
 * @param {MeshLambertMaterial} wheelMaterial Steering-wheel material.
 * @returns {{meshes: Mesh[], turn: Group, group: Group}} Meshes, the wheel's turning node and the
 *   wheel's holder.
 */
function carCockpit(color, lengthM, widthM, material, wheelMaterial) {
  const hw = widthM / 2 - 0.05;
  const soup = new TriangleSoup();
  soup.setColor(DASH).addBox(ORIGIN, 0, [0.6, 0.66, 0], [0.5, 0.32, 2 * hw]);
  // Bonnet: from the windscreen base at dash height down to a low front edge.
  const nose = lengthM / 2 - 0.15;
  soup.setColor(color).addQuad([0.85, 0.82, -hw], [0.85, 0.82, hw], [nose, 0.6, hw - 0.08], [nose, 0.6, -hw + 0.08], [0, 1, 0]);
  soup.setColor(PILLAR);
  for (const side of [-1, 1]) strut(soup, [0.85, 0.82, side * hw], [0.05, 1.42, side * (hw - 0.1)], 0.07);
  soup.setColor(MIRROR).addBox(ORIGIN, 0, [0.5, 1.34, 0], [0.03, 0.055, 0.2]);
  soup.addBox(ORIGIN, 0, [0.52, 1.39, 0], [0.015, 0.05, 0.015]);
  const body = new Mesh(/** @type {import('three').BufferGeometry} */ (soup.toGeometry()), material);

  // Steering wheel in front of the driver's seat (left of the centreline), raked back.
  const ring = new TorusGeometry(0.18, 0.022, 6, 20);
  const spokeA = new BoxGeometry(0.3, 0.03, 0.02);
  const spokeB = new BoxGeometry(0.03, 0.16, 0.02).translate(0, -0.08, 0);
  const merged = mergeGeometries([ring.toNonIndexed(), spokeA.toNonIndexed(), spokeB.toNonIndexed()]);
  ring.dispose();
  spokeA.dispose();
  spokeB.dispose();
  if (!merged) throw new Error('The steering wheel parts could not be merged');
  const mount = new Group();
  mount.position.set(0.27, 0.907, -0.36);
  // The torus lies in its XY plane; turn its axis to +X, then rake its top back toward the driver.
  mount.rotation.set(0, 0, WHEEL_RAKE_RAD, 'ZYX');
  const axis = new Group();
  axis.rotation.y = Math.PI / 2;
  mount.add(axis);
  const turn = new Group();
  axis.add(turn);
  const wheel = new Mesh(merged, wheelMaterial);
  turn.add(wheel);
  const group = new Group();
  group.add(mount);
  return { meshes: [body, wheel], turn, group };
}

/**
 * The motorbike cockpit.
 * @param {number} color Body colour.
 * @param {MeshLambertMaterial} material Vertex-coloured material.
 * @returns {{meshes: Mesh[], turn: Group, group: Group}} Meshes, the handlebar's turning node and
 *   the turning part's holder.
 */
function bikeCockpit(color, material) {
  const cowl = new TriangleSoup();
  cowl.setColor(color).addBox(ORIGIN, 0, [0.5, 1.03, 0], [0.28, 0.12, 0.34]);
  cowl.setColor(SPEEDO).addBox(ORIGIN, 0, [0.43, 1.095, 0], [0.1, 0.012, 0.16]);
  const body = new Mesh(/** @type {import('three').BufferGeometry} */ (cowl.toGeometry()), material);

  // Handlebar, grips and mirrors turn about the steering head at x = 0.5.
  const bar = new TriangleSoup();
  bar.setColor(BAR).addBox(ORIGIN, 0, [-0.04, 1.03, 0], [0.03, 0.03, 0.72]);
  for (const side of [-1, 1]) {
    bar.setColor(GRIP).addBox(ORIGIN, 0, [-0.04, 1.03, side * 0.32], [0.045, 0.045, 0.11]);
    bar.setColor(BAR).addBox(ORIGIN, 0, [-0.06, 1.16, side * 0.25], [0.015, 0.26, 0.015]);
    bar.setColor(MIRROR).addBox(ORIGIN, 0, [-0.08, 1.3, side * 0.27], [0.02, 0.055, 0.09]);
  }
  const handlebar = new Mesh(/** @type {import('three').BufferGeometry} */ (bar.toGeometry()), material);
  const turn = new Group();
  turn.position.set(0.5, 0, 0);
  turn.add(handlebar);
  const group = new Group();
  group.add(turn);
  return { meshes: [body, handlebar], turn, group };
}

/**
 * Builds the cockpit of the player vehicle.
 * @param {'car' | 'motorbike' | 'moped'} legalClass Vehicle class.
 * @param {number} color Body colour (hex).
 * @param {number} lengthM Vehicle length.
 * @param {number} widthM Vehicle width.
 * @returns {Cockpit} Cockpit.
 */
export function buildCockpit(legalClass, color, lengthM, widthM) {
  const material = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  const wheelMaterial = new MeshLambertMaterial({ color: WHEEL, side: DoubleSide });
  const isCar = legalClass === 'car';
  const parts = isCar ? carCockpit(color, lengthM, widthM, material, wheelMaterial) : bikeCockpit(color, material);
  const group = new Group();
  group.name = 'cockpit';
  group.add(parts.meshes[0]);
  group.add(parts.group);
  for (const m of parts.meshes) {
    m.castShadow = false;
    m.receiveShadow = false;
  }
  return {
    group,
    update(steerRad) {
      const steer = Number.isFinite(steerRad) ? steerRad : 0;
      // The wheel faces the driver along +X: a left turn (+steer) turns it anticlockwise as seen
      // from the seat. The handlebar turns about +Y with the front wheel.
      if (isCar) parts.turn.rotation.z = steer * WHEEL_TURN_PER_STEER;
      else parts.turn.rotation.y = steer;
    },
    dispose() {
      for (const m of parts.meshes) m.geometry.dispose();
      material.dispose();
      wheelMaterial.dispose();
    },
  };
}
