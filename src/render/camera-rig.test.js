import { Mesh, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildCockpit } from './cockpit.js';
import { CHASE_FOV_DEG, COCKPIT_RIG, chaseTarget, cockpitTarget, createCameraRig } from './scene.js';

/**
 * Framing of the two cameras, checked by projecting points of the drawn vehicles through the
 * shipped rig numbers. Heights are fractions of the frame height from the top.
 */

const ASPECT = 16 / 9;
const POSE = Object.freeze({ x: 0, y: 0, z: 0, heading: 0 });

/**
 * A camera placed by a rig target.
 * @param {{eye: number[], look: number[]}} t Eye and look points.
 * @param {number} fovDeg Vertical field of view.
 * @returns {PerspectiveCamera} Camera.
 */
function cameraAt(t, fovDeg) {
  const camera = new PerspectiveCamera(fovDeg, ASPECT, 0.1, 300);
  camera.position.set(t.eye[0], t.eye[1], t.eye[2]);
  camera.lookAt(t.look[0], t.look[1], t.look[2]);
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Height of a world point on screen, from the top (0) to the bottom (1).
 * @param {PerspectiveCamera} camera Camera.
 * @param {[number, number, number]} p Point (heading 0: +X forward).
 * @returns {number} Fraction from the top.
 */
function fromTop(camera, p) {
  const v = new Vector3(...p).project(camera);
  return (1 - v.y) / 2;
}

/**
 * Height of the horizon straight ahead, from the top.
 * @param {PerspectiveCamera} camera Camera.
 * @returns {number} Fraction from the top.
 */
function horizon(camera) {
  return fromTop(camera, [camera.position.x + 1e5, camera.position.y, camera.position.z]);
}

/**
 * Side profiles of the drawn vehicles along their centreline, `[along, height]` from rear to
 * front (heading 0, +X forward). The sedan is the Car Kit model as fitted to the 4.5 × 1.8 m
 * footprint (the fit keeps the model's proportions, so its roof stands 1.89 m high); the scooter
 * is the procedural scooter, 1.85 m long, with its rider's head at about 1.7 m above the seat.
 */
const PROFILES = Object.freeze({
  car: { frontM: 2.25, points: [[-2.25, 1.02], [-1.5, 0.93], [-1.25, 1.3], [-1, 1.82], [-0.75, 1.89], [0.25, 1.89], [0.5, 1.78], [0.75, 1.16], [1.25, 1.0], [2, 1.04], [2.25, 0.58]] },
  motorbike: { frontM: 0.925, points: [[-0.925, 0.7], [-0.4, 0.95], [-0.2, 1.7], [0.0, 1.45], [0.5, 1.08], [0.925, 0.6]] },
});

describe('the chase camera', () => {
  for (const legalClass of /** @type {const} */ (['car', 'motorbike'])) {
    const camera = cameraAt(chaseTarget(POSE, legalClass), CHASE_FOV_DEG);
    const profile = PROFILES[legalClass];
    const top = Math.min(...profile.points.map(([along, h]) => fromTop(camera, [along, h, 0])));

    it(`keeps the ${legalClass} at or below the middle of the screen`, () => {
      expect(top).toBeGreaterThanOrEqual(0.5);
    });

    it(`shows the ground 4 m ahead of the ${legalClass}'s front above its silhouette`, () => {
      expect(fromTop(camera, [profile.frontM + 4, 0, 0])).toBeLessThan(top);
    });

    it(`puts the horizon between 18 % and 30 % from the top for the ${legalClass}`, () => {
      const h = horizon(camera);
      expect(h).toBeGreaterThanOrEqual(0.18);
      expect(h).toBeLessThanOrEqual(0.3);
    });
  }

  it('follows the heading: behind and above the vehicle, looking ahead', () => {
    const t = chaseTarget({ x: 10, y: 0, z: 5, heading: Math.PI / 2 }, 'car');
    expect(t.eye[0]).toBeCloseTo(10, 6);
    expect(t.eye[2]).toBeGreaterThan(5);
    expect(t.look[2]).toBeLessThan(5);
  });
});

describe('the cockpit camera', () => {
  it('sits at the driver seat of a left-hand-drive car and on the scooter centreline', () => {
    const car = cockpitTarget(POSE, 'car');
    expect(car.eye[2]).toBeCloseTo(-COCKPIT_RIG.car.leftM, 6); // left of heading 0 is −Z
    expect(car.eye[1]).toBeCloseTo(COCKPIT_RIG.car.upM, 6);
    expect(car.look[2]).toBeCloseTo(car.eye[2], 6);
    const turned = cockpitTarget({ x: 0, y: 0, z: 0, heading: Math.PI / 2 }, 'car');
    expect(turned.eye[0]).toBeCloseTo(-COCKPIT_RIG.car.leftM, 6); // left of north is west
    const bike = cockpitTarget(POSE, 'motorbike');
    expect(bike.eye[2]).toBeCloseTo(0, 6);
  });

  for (const legalClass of /** @type {const} */ (['car', 'motorbike'])) {
    it(`draws a ${legalClass} cockpit filling 10–30 % of the frame at the bottom centre, with the road from at most 4 m ahead`, () => {
      const rig = COCKPIT_RIG[legalClass];
      const t = cockpitTarget(POSE, legalClass);
      const camera = cameraAt(t, rig.fovDeg);
      const cockpit = buildCockpit(legalClass, 0x2f6fb0, legalClass === 'car' ? 4.5 : 1.85, legalClass === 'car' ? 1.8 : 0.7);
      cockpit.group.updateMatrixWorld(true);
      /** @type {Mesh[]} */
      const meshes = [];
      cockpit.group.traverse((o) => {
        if (o instanceof Mesh) meshes.push(o);
      });
      expect(meshes.length).toBeLessThanOrEqual(3);
      const ray = new Raycaster();
      // Walk up the centre column from the bottom edge to the first row the cockpit leaves open.
      let open = -1;
      for (let row = 0; row <= 1000; row += 1) {
        const f = 1 - row / 1000;
        ray.setFromCamera(new Vector2(0, 1 - 2 * f), camera);
        if (ray.intersectObjects(meshes, false).length === 0) {
          open = f;
          break;
        }
      }
      const fill = 1 - open;
      expect(fill).toBeGreaterThanOrEqual(0.1);
      expect(fill).toBeLessThanOrEqual(0.3);
      // Where that open row meets the ground, measured from the vehicle's front.
      ray.setFromCamera(new Vector2(0, 1 - 2 * open), camera);
      const d = ray.ray.direction;
      expect(d.y).toBeLessThan(0);
      const s = -camera.position.y / d.y;
      const groundX = camera.position.x + d.x * s;
      const front = legalClass === 'car' ? 2.25 : 0.925;
      expect(groundX - front).toBeGreaterThan(0);
      expect(groundX - front).toBeLessThanOrEqual(4);
      cockpit.dispose();
    });
  }

  it('turns the wheel and the handlebar with the steer, and ignores a bad value', () => {
    const car = buildCockpit('car', 0xffffff, 4.5, 1.8);
    car.update(0.2);
    let turned = 0;
    car.group.traverse((o) => {
      if (o.rotation.z !== 0 && o.children.length === 1 && o.children[0] instanceof Mesh) turned = o.rotation.z;
    });
    expect(turned).toBeCloseTo(0.8, 6);
    car.update(Number.NaN);
    car.dispose();
    const bike = buildCockpit('motorbike', 0xffffff, 1.85, 0.7);
    bike.update(-0.3);
    const bar = bike.group.children[1].children[0];
    expect(bar.rotation.y).toBeCloseTo(-0.3, 6);
    bike.dispose();
  });
});

describe('createCameraRig', () => {
  it('switches the field of view, holds the cockpit camera rigid and rolls with half the lean on a motorbike', () => {
    const rig = createCameraRig(ASPECT, 'motorbike');
    expect(rig.mode()).toBe('chase');
    expect(rig.camera.fov).toBe(CHASE_FOV_DEG);
    rig.follow(POSE, 0, 0, true, [0, 0, 0]);
    // Chase smoothing: a jump of the pose moves the camera only part of the way.
    rig.follow({ ...POSE, x: 10 }, 0, 1 / 60, false, [0, 0, 0]);
    expect(rig.camera.position.x).toBeLessThan(10 - 5.5 - 1);
    rig.setMode('cockpit');
    expect(rig.camera.fov).toBe(COCKPIT_RIG.motorbike.fovDeg);
    rig.follow({ ...POSE, x: 10 }, 0, 1 / 60, false, [0, 0, 0]);
    expect(rig.camera.position.x).toBeCloseTo(10 + COCKPIT_RIG.motorbike.aheadM, 6);
    const level = rig.camera.quaternion.clone();
    rig.follow({ ...POSE, x: 10 }, 0.4, 1 / 60, false, [0, 0, 0]);
    expect(rig.camera.quaternion.angleTo(level)).toBeCloseTo(0.2, 6);
    expect(() => rig.setMode(/** @type {never} */ ('drone'))).toThrow(RangeError);
  });

  it('does not roll the car cockpit and applies the shake in both modes', () => {
    const rig = createCameraRig(ASPECT, 'car');
    rig.setMode('cockpit');
    rig.follow(POSE, 0.4, 0, true, [0, 0.1, 0]);
    expect(rig.camera.position.y).toBeCloseTo(COCKPIT_RIG.car.upM + 0.1, 6);
    const up = new Vector3(0, 1, 0).applyQuaternion(rig.camera.quaternion);
    expect(up.z).toBeCloseTo(0, 6);
    rig.setMode('chase');
    rig.follow(POSE, 0, 0, true, [0, 0.1, 0]);
    expect(rig.camera.position.y).toBeCloseTo(chaseTarget(POSE, 'car').eye[1] + 0.1, 6);
  });
});
