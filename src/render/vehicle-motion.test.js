import { describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, Vector3 } from 'three';
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import { createVehicleView } from './vehicle-view.js';
import { createFallGhosts } from './effects.js';
import { vehicleModel } from './vehicles/index.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('three').Object3D} Object3D */

const frame = /** @type {Frame} */ (/** @type {unknown} */ (frames[0]));

/**
 * Generated wheel pivots of a view, in creation (`WheelState`) order.
 * @param {Object3D} root View root.
 * @returns {Object3D[]} Pivots.
 */
function wheelPivots(root) {
  /** @type {Object3D[]} */
  const out = [];
  root.traverse((o) => {
    if (o.rotation.order === 'YXZ') out.push(o);
  });
  return out;
}

/**
 * A car view at the origin facing east (heading 0), posed with the given steer and spin.
 * @param {number} steer Front wheel steer, + left.
 * @param {number} spin Spin angle of every wheel.
 * @returns {Object3D[]} Wheel pivots after the pose.
 */
function posedCar(steer, spin) {
  const view = createVehicleView({ config: { ...vehicleModel('car-sedan', 'car'), glb: null }, lengthM: 4.5, widthM: 1.8, lamps: false });
  const ego = { ...frame.ego, wheels: frame.ego.wheels.map((w, i) => ({ ...w, steer: i < 2 ? steer : 0 })) };
  view.update({ x: 0, y: 0, z: 0, heading: 0 }, ego, [spin, spin, spin, spin], null);
  view.root.updateMatrixWorld(true);
  return wheelPivots(view.root);
}

/**
 * World direction of a pivot-local vector.
 * @param {Object3D} pivot Pivot.
 * @param {[number, number, number]} v Local vector.
 * @returns {Vector3} World direction.
 */
function worldDir(pivot, v) {
  const origin = pivot.localToWorld(new Vector3(0, 0, 0));
  return pivot.localToWorld(new Vector3(...v)).sub(origin);
}

describe('wheel motion', () => {
  it('turns the front wheels towards the vehicle left for a positive steer', () => {
    const [fl, fr, rl] = posedCar(0.3, 0);
    // Pivots use the model frame: forward is local +Z. Heading 0 faces +X; its left is −Z.
    for (const w of [fl, fr]) {
      const fwd = worldDir(w, [0, 0, 1]).normalize();
      expect(fwd.x).toBeCloseTo(Math.cos(0.3), 6);
      expect(fwd.z).toBeCloseTo(-Math.sin(0.3), 6);
    }
    expect(worldDir(rl, [0, 0, 1]).normalize().z).toBeCloseTo(0, 9);
  });

  it('rolls the top of a wheel forward for a positive spin angle', () => {
    const [fl] = posedCar(0, 0.2);
    const top = worldDir(fl, [0, 1, 0]);
    expect(top.x).toBeGreaterThan(0);
  });
});

describe('fall ghost', () => {
  it('rolls a copy onto its side over 0.6 s and removes it after 2 s', () => {
    const ghosts = createFallGhosts();
    const ghost = new Group();
    const lean = new Group();
    lean.add(new Mesh(new BoxGeometry()));
    ghost.add(lean);
    ghosts.spawn(ghost, 10, true);
    ghosts.update(10.3);
    expect(Math.abs(lean.rotation.x)).toBeGreaterThan(0);
    expect(Math.abs(lean.rotation.x)).toBeLessThan(Math.PI / 2);
    ghosts.update(10.7);
    // Left side: negative roll moves the top to the vehicle's left.
    expect(lean.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    ghosts.update(12.1);
    expect(ghosts.group.children).toHaveLength(0);
  });

  it('copies a vehicle view as a ghost whose first child is the lean group', () => {
    const view = createVehicleView({ config: vehicleModel('scooter', 'motorbike'), lengthM: 1.85, widthM: 0.7, lamps: true });
    const copy = view.ghost();
    expect(copy.children[0]).toBeInstanceOf(Group);
    expect(copy).not.toBe(view.root);
    view.dispose();
  });
});
