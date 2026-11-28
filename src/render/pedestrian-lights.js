/**
 * Pedestrian signal heads at both ends of every crosswalk with a `walkSignalId` (QCVN 41:2024
 * 6.5.1, Kiểu 2 layout: red standing figure on top, green walking figure below). The head at
 * each end faces across the crosswalk, towards the pedestrians waiting at the other end.
 *
 * Lamp states come from `pedestrianSignalState` on the crosswalk's `walkSignalId` signal at the
 * frame time: walk lights the green figure, flashing blinks it, stop lights the red figure. The
 * heads are visual only. Post placement is `src/world/pedestrian-posts.js`, shared with the map
 * build, which keeps scenery off the posts.
 *
 * Posts and housings are one merged mesh; every figure lives in one merged geometry whose vertex
 * colours change per update, so all heads cost two draw calls.
 */

import { BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SRGBColorSpace } from 'three';
import { headingOf } from '../geometry/index.js';
import { pedestrianPostPlacements, pedestrianSignalState } from '../world/index.js';
import { HAS_DOM } from './assets.js';
import { facingYaw } from './math.js';
import { TriangleSoup, localToWorld } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Signal} Signal */
/** @typedef {import('../contracts/map.js').Pos2} Pos2 */
/** @typedef {import('../world/signals.js').PedestrianLightState} PedestrianLightState */
/** @typedef {[number, number]} Vec2 */

/** Blink rate of the flashing green figure, in flashes per second (design). */
export const PEDESTRIAN_BLINK_HZ = 1;
/** Height of the green (lower) lamp centre above the ground (design). */
export const PEDESTRIAN_LAMP_Y_M = 2.2;
/** Lamp cell size: each figure is drawn in a square of this side. */
export const PEDESTRIAN_LAMP_M = 0.26;
/** Housing size: width, height, depth. */
const HOUSING = /** @type {const} */ ([0.34, PEDESTRIAN_LAMP_M * 2 + 0.2, 0.2]);
/** Figure atlas cells: 0 standing, 1 walking. */
const STANDING = 0;
const WALKING = 1;
const CELLS = 2;
/** Figure colours, lit and dark. */
const FIGURE_RGB = Object.freeze({
  red: { on: [1, 0.12, 0.06], off: [0.14, 0.04, 0.03] },
  green: { on: [0.1, 1, 0.35], off: [0.03, 0.13, 0.06] },
});

/**
 * One pedestrian head.
 * @typedef {object} PedestrianHeadPlacement
 * @property {string} crosswalkId Crosswalk it stands at.
 * @property {Signal} walkSignal The crosswalk's `walkSignalId` signal, which times the head.
 * @property {Pos2} pos Post base.
 * @property {number} yaw Rotation about +Y; the head's face (local +Z) points across the
 *   crosswalk to the other end.
 * @property {Pos2} faces Ground point the head faces: the middle of the crosswalk's other end.
 */

/**
 * Every pedestrian head to draw: one on each post of `pedestrianPostPlacements`, in its order. A
 * post the placement dropped for standing on the carriageway gets no head; the map build logs it.
 * @param {GameMap} map Map.
 * @returns {PedestrianHeadPlacement[]} Heads.
 */
export function pedestrianHeadPlacements(map) {
  const signals = new Map(map.signals.map((s) => [s.id, s]));
  return pedestrianPostPlacements(map).posts.map((post) => {
    const walkSignal = signals.get(post.walkSignalId);
    if (!walkSignal) throw new Error(`Pedestrian post at ${post.crosswalkId} names missing signal ${post.walkSignalId}`);
    return {
      crosswalkId: post.crosswalkId,
      walkSignal,
      pos: post.pos,
      // A face turned by `facingYaw(h)` looks against travel heading `h`, so `h` runs from the
      // facing point to the post.
      yaw: facingYaw(headingOf(post.pos.x - post.faces.x, post.pos.z - post.faces.z)),
      faces: post.faces,
    };
  });
}

/**
 * Which figures are lit for a head state at run time `t`: the red standing figure on stop, the
 * green walking figure on walk, and the green figure blinking at `PEDESTRIAN_BLINK_HZ` (lit for the
 * first half of each blink) while flashing.
 * @param {PedestrianLightState} state Head state.
 * @param {number} t Run time in seconds.
 * @returns {{red: boolean, green: boolean}} Lit figures.
 */
export function pedestrianLamps(state, t) {
  if (state === 'stop') return { red: true, green: false };
  if (state === 'walk') return { red: false, green: true };
  const phase = (((t * PEDESTRIAN_BLINK_HZ) % 1) + 1) % 1;
  return { red: false, green: phase < 0.5 };
}

/**
 * Canvas atlas of the standing and walking figures, white on transparent.
 * @returns {CanvasTexture | null} Texture, or null without a DOM.
 */
function createFigureAtlas() {
  if (!HAS_DOM) return null;
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = s * CELLS;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s * 0.11;
  /**
   * Strokes a polyline in cell coordinates (0–1, y down).
   * @param {number} cell Cell.
   * @param {[number, number][]} pts Points.
   */
  const line = (cell, pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo((cell + x) * s, y * s) : ctx.lineTo((cell + x) * s, y * s)));
    ctx.stroke();
  };
  /**
   * Fills the head disc of a figure.
   * @param {number} cell Cell.
   * @param {number} x Centre x.
   */
  const head = (cell, x) => {
    ctx.beginPath();
    ctx.arc((cell + x) * s, 0.15 * s, 0.09 * s, 0, Math.PI * 2);
    ctx.fill();
  };
  // Standing: upright body, arms down, legs together.
  head(STANDING, 0.5);
  line(STANDING, [
    [0.5, 0.28],
    [0.5, 0.6],
  ]);
  line(STANDING, [
    [0.36, 0.56],
    [0.36, 0.32],
    [0.64, 0.32],
    [0.64, 0.56],
  ]);
  line(STANDING, [
    [0.44, 0.92],
    [0.44, 0.6],
    [0.56, 0.6],
    [0.56, 0.92],
  ]);
  // Walking: leaning body mid-stride, arms swinging.
  head(WALKING, 0.56);
  line(WALKING, [
    [0.53, 0.29],
    [0.47, 0.58],
  ]);
  line(WALKING, [
    [0.3, 0.5],
    [0.4, 0.36],
    [0.52, 0.34],
    [0.64, 0.46],
    [0.74, 0.5],
  ]);
  line(WALKING, [
    [0.24, 0.9],
    [0.36, 0.74],
    [0.47, 0.58],
    [0.6, 0.74],
    [0.72, 0.92],
  ]);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * @typedef {object} PedestrianLights
 * @property {Group} group Meshes.
 * @property {PedestrianHeadPlacement[]} heads Drawn heads, in figure order.
 * @property {(t?: number) => void} update Light the figures for run time `t`; without it every
 *   figure is dark.
 * @property {() => void} dispose Free resources.
 */

/**
 * Builds every pedestrian head of the map.
 * @param {GameMap} map Map.
 * @returns {PedestrianLights} Pedestrian lights.
 */
export function buildPedestrianLights(map) {
  const group = new Group();
  group.name = 'pedestrian-lights';
  const heads = pedestrianHeadPlacements(map);
  const body = new TriangleSoup();
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const uvs = [];
  const greenY = PEDESTRIAN_LAMP_Y_M;
  const redY = greenY + PEDESTRIAN_LAMP_M + 0.04;
  const headY = (greenY + redY) / 2;
  const top = headY + HOUSING[1] / 2;
  for (const { pos, yaw } of heads) {
    body.addBox(pos, yaw, [0, top / 2, -HOUSING[2] / 2 - 0.05], [0.1, top, 0.1]);
    body.addBox(pos, yaw, [0, headY, 0], [...HOUSING]);
    // Red standing figure on top, green walking figure below (Kiểu 2).
    for (const [cell, y] of /** @type {const} */ ([
      [STANDING, redY],
      [WALKING, greenY],
    ])) {
      const h = PEDESTRIAN_LAMP_M / 2;
      const z = HOUSING[2] / 2 + 0.006;
      const u0 = cell / CELLS;
      const u1 = (cell + 1) / CELLS;
      /** @type {[number, number, number, number][]} */
      const corners = [
        [-h, y - h, u0, 0],
        [h, y - h, u1, 0],
        [h, y + h, u1, 1],
        [-h, y - h, u0, 0],
        [h, y + h, u1, 1],
        [-h, y + h, u0, 1],
      ];
      for (const [x, cy, u, v] of corners) {
        positions.push(...localToWorld(pos, yaw, [x, cy, z]));
        uvs.push(u, v);
      }
    }
  }
  const bodyMaterial = new MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.7 });
  const bodyGeometry = body.toGeometry();
  if (bodyGeometry) {
    const mesh = new Mesh(bodyGeometry, bodyMaterial);
    mesh.name = 'pedestrian-signal-bodies';
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  const atlas = createFigureAtlas();
  const figureMaterial = new MeshBasicMaterial({ vertexColors: true, map: atlas, transparent: true, alphaTest: 0.3 });
  /** @type {BufferGeometry | null} */
  let figureGeometry = null;
  /** @type {Float32BufferAttribute | null} */
  let colorAttr = null;
  if (positions.length > 0) {
    figureGeometry = new BufferGeometry();
    figureGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    figureGeometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    colorAttr = new Float32BufferAttribute(new Float32Array(positions.length), 3);
    figureGeometry.setAttribute('color', colorAttr);
    figureGeometry.computeBoundingSphere();
    const mesh = new Mesh(figureGeometry, figureMaterial);
    mesh.name = 'pedestrian-signal-figures';
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  /**
   * Colours one figure quad.
   * @param {number} quad Quad index.
   * @param {readonly number[]} rgb Colour.
   */
  const paint = (quad, rgb) => {
    if (!colorAttr) return;
    for (let k = 0; k < 6; k += 1) colorAttr.setXYZ(quad * 6 + k, rgb[0], rgb[1], rgb[2]);
  };

  /**
   * @param {number} [t] Run time in seconds.
   */
  const update = (t) => {
    heads.forEach((head, i) => {
      const lit = t === undefined ? { red: false, green: false } : pedestrianLamps(pedestrianSignalState(head.walkSignal, t), t);
      paint(i * 2, lit.red ? FIGURE_RGB.red.on : FIGURE_RGB.red.off);
      paint(i * 2 + 1, lit.green ? FIGURE_RGB.green.on : FIGURE_RGB.green.off);
    });
    if (colorAttr) colorAttr.needsUpdate = true;
  };
  update();

  return {
    group,
    heads,
    update,
    dispose() {
      bodyGeometry?.dispose();
      figureGeometry?.dispose();
      bodyMaterial.dispose();
      figureMaterial.dispose();
      atlas?.dispose();
    },
  };
}

