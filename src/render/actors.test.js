import { describe, expect, it } from 'vitest';
import map from '../../tests/fixtures/map-minimal.json' with { type: 'json' };
import frames from '../../tests/fixtures/frames-straight.json' with { type: 'json' };
import { ACTOR_LIGHTS } from '../contracts/index.js';
import { buildActors } from './actors.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */

const fixture = /** @type {GameMap} */ (/** @type {unknown} */ (map));
const base = /** @type {Frame} */ (/** @type {unknown} */ (frames[0]));

/**
 * Traffic agent pose.
 * @param {string} id Id.
 * @param {'car' | 'motorbike'} kind Kind.
 * @param {number} x Position.
 * @returns {ActorPose} Pose.
 */
const agent = (id, kind, x) => ({
  id,
  kind,
  pos: { x, z: 1.75 },
  heading: 0,
  speed: 5,
  active: true,
  model: kind === 'car' ? 'car' : 'motorbike',
  variant: 0,
  lengthM: kind === 'car' ? 4.5 : 1.9,
  widthM: kind === 'car' ? 1.8 : 0.8,
  lights: ACTOR_LIGHTS.off,
  state: 'moving',
  violations: [],
});

/**
 * Frame with the scripted poses of the fixture plus traffic poses.
 * @param {number} tick Tick.
 * @param {ActorPose[]} poses Traffic poses.
 * @returns {Frame} Frame.
 */
const frameWith = (tick, poses) => ({ ...base, tick, actors: [...base.actors, ...poses] });

describe('traffic view pool', () => {
  it('draws an agent from its first frame, at its pose, and gives the view back when it leaves', () => {
    const actors = buildActors(fixture);
    const scripted = actors.group.children.length;
    expect(scripted).toBe(fixture.actors.length);

    actors.update(null, frameWith(1, [agent('npc-10', 'car', 10), agent('npc-11', 'motorbike', 20)]), 1, true);
    expect(actors.group.children).toHaveLength(scripted + 2);
    const car = actors.group.children.find((c) => Math.abs(c.position.x - 10) < 1e-9);
    expect(car).toBeDefined();

    // npc-10 leaves; its view leaves the scene.
    actors.update(null, frameWith(2, [agent('npc-11', 'motorbike', 21)]), 1, true);
    expect(actors.group.children).toHaveLength(scripted + 1);
    expect(actors.group.children).not.toContain(car);

    // A new car of the same shape takes the freed view.
    actors.update(null, frameWith(3, [agent('npc-11', 'motorbike', 22), agent('npc-12', 'car', 30)]), 1, true);
    expect(actors.group.children).toHaveLength(scripted + 2);
    expect(actors.group.children).toContain(car);
    expect(car?.position.x).toBeCloseTo(30);

    actors.reset();
    expect(actors.group.children).toHaveLength(scripted);
    actors.dispose();
  });
});
