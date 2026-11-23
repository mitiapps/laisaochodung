import { beforeAll, describe, expect, it } from 'vitest';
import { kmhToMps } from '../../../src/contracts/units.js';
import { createInput } from '../../../src/game/input.js';
import { createSim } from '../../../src/sim/index.js';
import { initRapier } from './driver.js';
import { loadShippedMap, vehicleOf } from '../kinematic/drive.js';

let R;
beforeAll(async () => {
  R = await initRapier();
});

/**
 * Keyboard event on a target, as the browser delivers it.
 * @param {EventTarget} target Target.
 * @param {'keydown' | 'keyup'} type Type.
 * @param {string} code Key code.
 */
function key(target, type, code) {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false }));
}

describe('scooter, S plus Space from 50 km/h on tutorial 03 grip', () => {
  it('stops without a fall', () => {
    const map = loadShippedMap('tutorial-03-ban-dem');
    const sim = createSim(R, map, vehicleOf('scooter'));
    const target = new EventTarget();
    const input = createInput({ legalClass: 'motorbike', surfaceGrip: map.environment.surfaceGrip, target, onPause: () => {} });
    input.setEnabled(true);
    input.setDriving(true);
    /** @type {import('../../../src/contracts/index.js').FrameEvent[]} */
    const falls = [];
    let frame = null;
    key(target, 'keydown', 'KeyW');
    for (let k = 0; k < 60 * 30; k += 1) {
      frame = sim.step(input.sample());
      if (frame.ego.speed >= kmhToMps(50)) break;
    }
    key(target, 'keyup', 'KeyW');
    expect(frame.ego.speed).toBeGreaterThanOrEqual(kmhToMps(50));
    key(target, 'keydown', 'KeyS');
    key(target, 'keydown', 'Space');
    for (let k = 0; k < 60 * 8; k += 1) {
      frame = sim.step(input.sample());
      falls.push(...frame.events.filter((e) => e.type === 'fall'));
      if (frame.ego.speed < 0.05) break;
    }
    key(target, 'keyup', 'KeyS');
    key(target, 'keyup', 'Space');
    input.dispose();
    if (typeof sim.dispose === 'function') sim.dispose();
    expect(falls).toEqual([]);
    expect(frame.ego.speed).toBeLessThan(0.05);
  });
});
