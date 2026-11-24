/**
 * Three-lamp traffic-light heads at map `signals[]`: red on top, yellow in the middle, green at the
 * bottom (QCVN 41:2024 Điều 6, 6.1.1). Lamp states come from `frame.trafficLights`. Poles and
 * housings are merged; lamps share six materials (three colours, lit or dark).
 *
 * Sizes from QCVN 41:2024 Điều 9 and Phụ lục A:
 * - side pole: lowest lamp 1.7–5.8 m above the ground; 2.5 m here;
 * - cantilever arm: lowest lamp 5.2–7.8 m; 5.5 m here, with a 4 m arm (design);
 * - main lenses 200–300 mm; 300 mm here;
 * - countdown (Dạng 8): red digits on red, green digits on green. Yellow shows yellow digits here
 *   (design). The seconds come from the signal cycle at the frame time, through `signalState`.
 *
 * Every countdown digit lives in one merged geometry whose UVs and colours change per update, so
 * all countdowns cost one draw call.
 */

import {
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
} from 'three';
import { signalState } from '../world/index.js';
import { HAS_DOM } from './assets.js';
import { facingYaw } from './math.js';
import { TriangleSoup, localToWorld } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Signal} Signal */
/** @typedef {import('../contracts/telemetry.js').LightState} LightState */
/** @typedef {'side' | 'cantilever'} SignalMount */

/** Lens diameter (QCVN 41 Phụ lục A: 200–300 mm). */
export const LENS_M = 0.3;
/** Centre-to-centre spacing of the lamps in a head. */
export const LAMP_SPACING_M = 0.38;
/** Lowest lamp centre above the ground for each mount. */
export const LOWEST_LAMP_Y_M = Object.freeze({ side: 2.5, cantilever: 5.5 });
/** Cantilever arm reach from the mast to the head (design). */
export const ARM_M = 4;
/** Housing size: width, height, depth. */
const HOUSING = /** @type {const} */ ([0.44, LAMP_SPACING_M * 2 + LENS_M + 0.16, 0.28]);
/** Countdown box size and digit size. */
const COUNTDOWN = Object.freeze({ w: 0.62, h: 0.44, digitW: 0.24, digitH: 0.34 });
/** Vertical lamp offsets from the head centre, in lamp order. */
const LAMP_ORDER = /** @type {const} */ ([
  ['red', LAMP_SPACING_M],
  ['yellow', 0],
  ['green', -LAMP_SPACING_M],
]);
const LAMP_COLORS = Object.freeze({ red: 0xff2a1a, yellow: 0xffb300, green: 0x19e05a });
/** Digit atlas: cells 0–9 hold the digits and cell 10 is blank. */
const DIGIT_CELLS = 11;
const BLANK = 10;

/**
 * Which lamp is lit for a state; unknown or missing states light nothing.
 * @param {LightState | undefined} state Light state.
 * @param {'red' | 'yellow' | 'green'} lamp Lamp colour.
 * @returns {boolean} Lit.
 */
export function lampLit(state, lamp) {
  return state === lamp;
}

/**
 * Head centre height for a mount: the lowest (green) lamp sits at the mount's height.
 * @param {SignalMount} mount Mount.
 * @returns {number} Height in metres.
 */
export function headCentreY(mount) {
  return LOWEST_LAMP_Y_M[mount] + LAMP_SPACING_M;
}

/**
 * Whole seconds left in the current phase of a signal at run time `t`, at least 1, at most 99.
 * @param {Signal} signal Signal.
 * @param {number} t Run time in seconds.
 * @returns {{state: LightState, seconds: number}} Phase and seconds left.
 */
export function countdown(signal, t) {
  const state = signalState(signal, t);
  const { green, yellow, red, offset } = signal.cycle;
  const period = green + yellow + red;
  const u = (((t + offset) % period) + period) % period;
  const end = state === 'green' ? green : state === 'yellow' ? green + yellow : period;
  return { state, seconds: Math.max(1, Math.min(99, Math.ceil(end - u - 1e-9))) };
}

/**
 * Atlas cells of the two digits shown for a number of seconds: a leading blank under 10.
 * @param {number} seconds Seconds, 1–99.
 * @returns {[number, number]} Tens cell, units cell.
 */
export function digitCells(seconds) {
  const s = Math.max(0, Math.min(99, Math.round(seconds)));
  return [s >= 10 ? Math.floor(s / 10) : BLANK, s % 10];
}

/**
 * Canvas atlas of the digits 0–9 and a blank cell, white on transparent.
 * @returns {CanvasTexture | null} Texture, or null without a DOM.
 */
function createDigitAtlas() {
  if (!HAS_DOM) return null;
  const cw = 48;
  const ch = 64;
  const canvas = document.createElement('canvas');
  canvas.width = cw * DIGIT_CELLS;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${ch * 0.9}px "Courier New", monospace`;
  for (let d = 0; d < 10; d += 1) ctx.fillText(String(d), d * cw + cw / 2, ch / 2 + 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * @typedef {object} TrafficLights
 * @property {Group} group Meshes.
 * @property {(states: Record<string, LightState>, t?: number) => void} update Light the lamps and,
 *   with the run time `t`, show the countdowns (without it they stay blank).
 * @property {() => void} dispose Free resources.
 */

/**
 * @typedef {object} TrafficLightOptions
 * @property {ReadonlySet<string>} [cantilever] Ids of signals hung from a cantilever arm; the rest
 *   stand on a side pole.
 */

/**
 * Builds every signal head of the map.
 * @param {GameMap} map Map.
 * @param {TrafficLightOptions} [options] Options.
 * @returns {TrafficLights} Traffic lights.
 */
export function buildTrafficLights(map, options = {}) {
  const group = new Group();
  group.name = 'traffic-lights';
  const body = new TriangleSoup();
  const lampGeometry = new CircleGeometry(LENS_M / 2, 16);
  /** @type {Record<string, {on: MeshBasicMaterial, off: MeshStandardMaterial}>} */
  const mats = {};
  for (const [lamp, color] of Object.entries(LAMP_COLORS)) {
    mats[lamp] = {
      on: new MeshBasicMaterial({ color }),
      off: new MeshStandardMaterial({ color: 0x1b1b1b, emissive: color, emissiveIntensity: 0.06, roughness: 0.4 }),
    };
  }
  /** @type {{signalId: string, lamp: 'red' | 'yellow' | 'green', mesh: Mesh}[]} */
  const lamps = [];
  /** @type {number[]} */
  const digitPositions = [];

  for (const signal of map.signals) {
    const mount = options.cantilever?.has(signal.id) ? 'cantilever' : 'side';
    const yaw = facingYaw(signal.heading);
    const headY = headCentreY(mount);
    const top = headY + HOUSING[1] / 2;
    if (mount === 'side') {
      body.addBox(signal.pos, yaw, [0, top / 2, -HOUSING[2] / 2 - 0.06], [0.12, top, 0.12]);
    } else {
      // The mast stands ARM_M to the right of the traffic (local +X of a face turned by
      // `facingYaw`), and the arm reaches over the lane to the head.
      body.addBox(signal.pos, yaw, [ARM_M, (top + 0.4) / 2, -HOUSING[2] / 2 - 0.1], [0.22, top + 0.4, 0.22]);
      body.addBox(signal.pos, yaw, [ARM_M / 2, top + 0.2, -HOUSING[2] / 2 - 0.1], [ARM_M, 0.12, 0.12]);
    }
    body.addBox(signal.pos, yaw, [0, headY, 0], [...HOUSING]);
    // Countdown box beside the head, on the right of the traffic.
    const cx = HOUSING[0] / 2 + COUNTDOWN.w / 2 + 0.04;
    body.addBox(signal.pos, yaw, [cx, headY, 0], [COUNTDOWN.w, COUNTDOWN.h, HOUSING[2]]);
    for (const dx of [-COUNTDOWN.digitW / 2 - 0.01, COUNTDOWN.digitW / 2 + 0.01]) {
      const x0 = cx + dx - COUNTDOWN.digitW / 2;
      const x1 = cx + dx + COUNTDOWN.digitW / 2;
      const y0 = headY - COUNTDOWN.digitH / 2;
      const y1 = headY + COUNTDOWN.digitH / 2;
      const z = HOUSING[2] / 2 + 0.006;
      const corners = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y0],
        [x1, y1],
        [x0, y1],
      ];
      for (const [x, y] of corners) digitPositions.push(...localToWorld(signal.pos, yaw, [x, y, z]));
    }
    for (const [lamp, dy] of LAMP_ORDER) {
      const mesh = new Mesh(lampGeometry, mats[lamp].off);
      mesh.name = `lamp-${signal.id}-${lamp}`;
      mesh.position.set(signal.pos.x, headY + dy, signal.pos.z);
      mesh.rotation.y = yaw;
      mesh.translateZ(HOUSING[2] / 2 + 0.005);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      lamps.push({ signalId: signal.id, lamp, mesh });
    }
  }
  const bodyMaterial = new MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.7 });
  const geometry = body.toGeometry();
  if (geometry) {
    const mesh = new Mesh(geometry, bodyMaterial);
    mesh.name = 'signal-bodies';
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Countdown digits: one geometry for every signal, 2 digits × 2 triangles each.
  const atlas = createDigitAtlas();
  const digitMaterial = new MeshBasicMaterial({ vertexColors: true, map: atlas, transparent: true, alphaTest: 0.3 });
  /** @type {BufferGeometry | null} */
  let digitGeometry = null;
  /** @type {Float32BufferAttribute | null} */
  let uvAttr = null;
  /** @type {Float32BufferAttribute | null} */
  let colorAttr = null;
  if (digitPositions.length > 0) {
    digitGeometry = new BufferGeometry();
    digitGeometry.setAttribute('position', new Float32BufferAttribute(digitPositions, 3));
    const n = digitPositions.length / 3;
    uvAttr = new Float32BufferAttribute(new Float32Array(n * 2), 2);
    colorAttr = new Float32BufferAttribute(new Float32Array(n * 3), 3);
    digitGeometry.setAttribute('uv', uvAttr);
    digitGeometry.setAttribute('color', colorAttr);
    digitGeometry.computeBoundingSphere();
    const mesh = new Mesh(digitGeometry, digitMaterial);
    mesh.name = 'signal-countdowns';
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  /** @type {Record<LightState, [number, number, number]>} */
  const digitColors = {
    red: [1, 0.1, 0.05],
    yellow: [1, 0.65, 0],
    green: [0.1, 1, 0.3],
  };

  /**
   * Writes one digit quad.
   * @param {number} quad Quad index.
   * @param {number} cell Atlas cell.
   * @param {[number, number, number]} rgb Colour.
   */
  const writeDigit = (quad, cell, rgb) => {
    if (!uvAttr || !colorAttr) return;
    const u0 = cell / DIGIT_CELLS;
    const u1 = (cell + 1) / DIGIT_CELLS;
    const uv = [
      [u0, 0],
      [u1, 0],
      [u1, 1],
      [u0, 0],
      [u1, 1],
      [u0, 1],
    ];
    for (let k = 0; k < 6; k += 1) {
      uvAttr.setXY(quad * 6 + k, uv[k][0], uv[k][1]);
      colorAttr.setXYZ(quad * 6 + k, rgb[0], rgb[1], rgb[2]);
    }
  };

  return {
    group,
    update(states, t) {
      for (const l of lamps) l.mesh.material = lampLit(states[l.signalId], l.lamp) ? mats[l.lamp].on : mats[l.lamp].off;
      map.signals.forEach((signal, i) => {
        const state = states[signal.id];
        const c = t === undefined || !state ? null : countdown(signal, t);
        // A frame state that disagrees with the cycle (a stale frame) shows nothing.
        const cells = c && c.state === state ? digitCells(c.seconds) : [BLANK, BLANK];
        const rgb = state ? digitColors[state] : digitColors.red;
        writeDigit(i * 2, cells[0], cells[0] === BLANK ? [0, 0, 0] : rgb);
        writeDigit(i * 2 + 1, cells[1], cells[1] === BLANK ? [0, 0, 0] : rgb);
      });
      if (uvAttr && colorAttr) {
        uvAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
      }
    },
    dispose() {
      geometry?.dispose();
      digitGeometry?.dispose();
      lampGeometry.dispose();
      bodyMaterial.dispose();
      digitMaterial.dispose();
      atlas?.dispose();
      for (const m of Object.values(mats)) {
        m.on.dispose();
        m.off.dispose();
      }
    },
  };
}
