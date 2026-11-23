/**
 * Three-lamp traffic-light heads at map `signals[]`: red on top, yellow in the middle, green at the
 * bottom (QCVN 41:2024 Điều 6, 6.1.1). Lamp states come from `frame.trafficLights` only. Poles and
 * housings are merged; lamps share six materials (three colours, lit or dark).
 */

import { CircleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { facingYaw } from './math.js';
import { TriangleSoup } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').LightState} LightState */

/** Height of the head centre above the ground (a drawing choice). */
export const HEAD_Y_M = 3.4;
/** Housing size: width, height, depth. */
const HOUSING = /** @type {const} */ ([0.36, 0.95, 0.24]);
/** Lamp radius (QCVN 41 Phụ lục A gives 200–300 mm lamp diameters). */
const LAMP_R_M = 0.12;
/** Vertical lamp offsets from the head centre, in lamp order. */
const LAMP_ORDER = /** @type {const} */ ([
  ['red', 0.29],
  ['yellow', 0],
  ['green', -0.29],
]);
const LAMP_COLORS = Object.freeze({ red: 0xff2a1a, yellow: 0xffb300, green: 0x19e05a });

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
 * @typedef {object} TrafficLights
 * @property {Group} group Meshes.
 * @property {(states: Record<string, LightState>) => void} update Light the lamps.
 * @property {() => void} dispose Free resources.
 */

/**
 * Builds every signal head of the map.
 * @param {GameMap} map Map.
 * @returns {TrafficLights} Traffic lights.
 */
export function buildTrafficLights(map) {
  const group = new Group();
  group.name = 'traffic-lights';
  const body = new TriangleSoup();
  const lampGeometry = new CircleGeometry(LAMP_R_M, 16);
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

  for (const signal of map.signals) {
    const yaw = facingYaw(signal.heading);
    body.addBox(signal.pos, yaw, [0, (HEAD_Y_M - HOUSING[1] / 2) / 2, -HOUSING[2] / 2 - 0.06], [
      0.1,
      HEAD_Y_M - HOUSING[1] / 2,
      0.1,
    ]);
    body.addBox(signal.pos, yaw, [0, HEAD_Y_M, 0], [...HOUSING]);
    for (const [lamp, dy] of LAMP_ORDER) {
      const mesh = new Mesh(lampGeometry, mats[lamp].off);
      mesh.name = `lamp-${signal.id}-${lamp}`;
      mesh.position.set(signal.pos.x, HEAD_Y_M + dy, signal.pos.z);
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

  return {
    group,
    update(states) {
      for (const l of lamps) l.mesh.material = lampLit(states[l.signalId], l.lamp) ? mats[l.lamp].on : mats[l.lamp].off;
    },
    dispose() {
      geometry?.dispose();
      lampGeometry.dispose();
      bodyMaterial.dispose();
      for (const m of Object.values(mats)) {
        m.on.dispose();
        m.off.dispose();
      }
    },
  };
}
