import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';
import junction from '../../tests/fixtures/map-junction.json' with { type: 'json' };
import { pointInPolygon } from '../geometry/index.js';
import { PEDESTRIAN_FLASH_S, pedestrianSignalState } from '../world/index.js';
import { PEDESTRIAN_BLINK_HZ, PEDESTRIAN_LAMP_Y_M, buildPedestrianLights, pedestrianHeadPlacements, pedestrianLamps } from './pedestrian-lights.js';
import { rotateY } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('./pedestrian-lights.js').PedestrianLights} PedestrianLights */
/** @typedef {[number, number]} Vec2 */

const MAP = /** @type {GameMap} */ (/** @type {unknown} */ (junction));

/**
 * Deep copy of the junction fixture.
 * @returns {GameMap} Map.
 */
const clone = () => /** @type {GameMap} */ (structuredClone(MAP));

/**
 * Colour of one figure of a built head set: `[r, g, b]` of its first vertex.
 * @param {PedestrianLights} lights Built lights.
 * @param {number} head Head index.
 * @param {'red' | 'green'} figure Figure.
 * @returns {number[]} Colour.
 */
function figureColor(lights, head, figure) {
  const mesh = lights.group.getObjectByName('pedestrian-signal-figures');
  if (!(mesh instanceof Mesh)) throw new Error('no figure mesh');
  const attr = mesh.geometry.getAttribute('color');
  const v = (head * 2 + (figure === 'red' ? 0 : 1)) * 6;
  return [attr.getX(v), attr.getY(v), attr.getZ(v)];
}

/**
 * Whether a figure colour is a lit one (its brightest channel near full).
 * @param {number[]} rgb Colour.
 * @returns {boolean} Lit.
 */
const isLit = (rgb) => Math.max(...rgb) > 0.9;

// `cw-w` spans x −8.75..−7.25 and z −3.5..7 across the westbound arm; its walk signal `sig-n`
// (green 27, yellow 3, red 30, offset 30) is green for t in [30, 57) of each 60 s cycle.
const WALK_SIGNAL = /** @type {import('../contracts/map.js').Signal} */ (MAP.signals.find((s) => s.id === 'sig-n'));
const T = { walk: 40, flashOn: 53.25, flashOff: 53.75, stopRed: 10, stopYellow: 58, stopLate: 75 };

describe('pedestrian head placement', () => {
  const heads = pedestrianHeadPlacements(MAP);

  it('puts one head at each end of a crosswalk with a walk signal, timed by that signal', () => {
    expect(heads).toHaveLength(2);
    for (const h of heads) {
      expect(h.crosswalkId).toBe('cw-w');
      expect(h.walkSignal.id).toBe('sig-n');
    }
    // The two ends lie beyond the zebra's two ends across the road (z −3.5 and 7).
    const zs = heads.map((h) => h.pos.z).sort((a, b) => a - b);
    expect(zs[0]).toBeLessThan(-3.5);
    expect(zs[1]).toBeGreaterThan(7);
  });

  it('stands each post off the carriageway, beside the zebra away from the junction', () => {
    for (const h of heads) {
      /** @type {Vec2} */
      const p = [h.pos.x, h.pos.z];
      for (const road of MAP.roads) for (const lane of road.lanes) expect(pointInPolygon(p, lane.polygon)).toBe(false);
      for (const j of MAP.junctions) expect(pointInPolygon(p, j.polygon)).toBe(false);
      expect(pointInPolygon(p, /** @type {Vec2[]} */ (MAP.crosswalks[0].polygon))).toBe(false);
      // The junction lies east of the crosswalk, so the posts stand on its west side.
      expect(h.pos.x).toBeLessThan(-8.75);
    }
  });

  it('turns each head to face across the crosswalk, towards the other end', () => {
    const [a, b] = heads;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ]) {
      const n = rotateY([0, 0, 1], self.yaw);
      const dot = n[0] * (other.pos.x - self.pos.x) + n[2] * (other.pos.z - self.pos.z);
      const dist = Math.hypot(other.pos.x - self.pos.x, other.pos.z - self.pos.z);
      expect(dot / dist).toBeGreaterThan(0.99);
    }
  });

  it('draws none at crosswalks without a walk signal, or whose walk signal is missing', () => {
    const none = clone();
    delete none.crosswalks[0].walkSignalId;
    expect(pedestrianHeadPlacements(none)).toEqual([]);
    expect(buildPedestrianLights(none).group.children).toHaveLength(0);
    const dangling = clone();
    dangling.crosswalks[0].walkSignalId = 'sig-missing';
    expect(pedestrianHeadPlacements(dangling)).toEqual([]);
  });
});

describe('pedestrian head states', () => {
  it('samples the fixture cycle where the shared state says walk, flashing and stop', () => {
    expect(PEDESTRIAN_FLASH_S).toBe(5);
    expect(pedestrianSignalState(WALK_SIGNAL, T.walk)).toBe('walk');
    expect(pedestrianSignalState(WALK_SIGNAL, T.flashOn)).toBe('flashing');
    expect(pedestrianSignalState(WALK_SIGNAL, T.flashOff)).toBe('flashing');
    expect(pedestrianSignalState(WALK_SIGNAL, T.stopRed)).toBe('stop');
    expect(pedestrianSignalState(WALK_SIGNAL, T.stopYellow)).toBe('stop');
    expect(pedestrianSignalState(WALK_SIGNAL, T.stopLate)).toBe('stop');
  });

  it('lights red on stop, green on walk, and blinks green while flashing', () => {
    expect(pedestrianLamps('stop', 3.1)).toEqual({ red: true, green: false });
    expect(pedestrianLamps('walk', 3.6)).toEqual({ red: false, green: true });
    const period = 1 / PEDESTRIAN_BLINK_HZ;
    expect(pedestrianLamps('flashing', 10 + period * 0.25)).toEqual({ red: false, green: true });
    expect(pedestrianLamps('flashing', 10 + period * 0.75)).toEqual({ red: false, green: false });
    expect(pedestrianLamps('flashing', 11 + period * 0.25)).toEqual({ red: false, green: true });
  });

  it('paints both heads of a crosswalk from its walk signal at the frame time', () => {
    const lights = buildPedestrianLights(MAP);
    const meshes = lights.group.children.filter((o) => o instanceof Mesh);
    expect(meshes.map((m) => m.name).sort()).toEqual(['pedestrian-signal-bodies', 'pedestrian-signal-figures']);
    /** @type {[number, boolean, boolean][]} */
    const cases = [
      [T.walk, false, true],
      [T.flashOn, false, true],
      [T.flashOff, false, false],
      [T.stopRed, true, false],
      [T.stopYellow, true, false],
    ];
    for (const [t, red, green] of cases) {
      lights.update(t);
      for (const head of [0, 1]) {
        expect(isLit(figureColor(lights, head, 'red')), `red at t=${t}`).toBe(red);
        expect(isLit(figureColor(lights, head, 'green')), `green at t=${t}`).toBe(green);
      }
    }
    lights.update();
    expect(isLit(figureColor(lights, 0, 'red'))).toBe(false);
    expect(isLit(figureColor(lights, 0, 'green'))).toBe(false);
    lights.dispose();
  });

  it('keeps the red figure above the green one at walking height', () => {
    const lights = buildPedestrianLights(MAP);
    const mesh = /** @type {Mesh} */ (lights.group.getObjectByName('pedestrian-signal-figures'));
    const pos = mesh.geometry.getAttribute('position');
    // Quad 0 is head 0's red figure, quad 1 its green figure; vertex 0 is each quad's bottom.
    expect(pos.getY(6)).toBeCloseTo(PEDESTRIAN_LAMP_Y_M - 0.13, 6);
    expect(pos.getY(0)).toBeGreaterThan(pos.getY(6) + 0.2);
    lights.dispose();
  });
});
