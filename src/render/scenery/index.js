/**
 * Procedural streetscape: tube-house rows, civic buildings, towers and street furniture, built once
 * from map JSON.
 *
 * - Buildings come from the map's `building` obstacles (`use` picks the generator; a building with
 *   no `use` is a tube-house row). Their static geometry is merged per material per chunk (`CHUNK_M`).
 * - Props are one `InstancedMesh` per kind (plus awnings); the kit may name GLB models for them.
 * - Cables link power poles on tutorial maps only.
 * - Night: lit windows and sign boards carry `userData.nightEmissive` on their material and the
 *   lamp glow sprites carry `userData.nightOnly`; `createEnvironment` drives both from the clock.
 *   They start at the map's start clock, so the look is right before the first update.
 *
 * Scenery never casts shadows (`castShadow` false everywhere); it receives them.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SRGBColorSpace,
} from 'three';
import { HAS_DOM } from '../assets.js';
import { daylight, headingToYaw } from '../math.js';
import { localToWorld } from '../triangle-soup.js';
import { range } from '../../world/random.js';
import { buildCables } from './cables.js';
import { ChunkedSoups } from './chunks.js';
import { buildCivic } from './civic.js';
import { layoutBuilding, sceneryStream } from './lots.js';
import { LAMP_HEAD, PROP_KINDS, buildPropLayer, propInstances } from './props.js';
import { buildShophouseRow } from './shophouse.js';
import { createSignAtlasTexture } from './sign-atlas.js';
import { buildTower } from './tower.js';

/** @typedef {import('../../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../../contracts/map.js').Prop} Prop */
/** @typedef {import('./props.js').PropModelKey} PropModelKey */
/** @typedef {import('./props.js').PropLayer} PropLayer */
/** @typedef {import('./shophouse.js').AwningInstance} AwningInstance */

/**
 * Optional models for the scenery.
 * @typedef {object} SceneryKit
 * @property {Partial<Record<PropModelKey, string>>} [propModels] GLB path (relative to `public/`)
 *   per prop kind or `awning`; kinds without one keep their primitive shape.
 */

/**
 * @typedef {object} Scenery
 * @property {Group} group Everything the scenery draws.
 * @property {() => void} dispose Free geometries, materials and textures.
 */

/** First stream index of props, above any building index. */
const PROP_STREAM_BASE = 1 << 20;
/** Stream index of the cables. */
const CABLE_STREAM = 1 << 21;
/** Night factor from which the lamp glow shows. */
export const GLOW_FROM_NIGHT = 0.3;

/**
 * The materials of the scenery, by key. Static soups use `facade` (painted, bare and metal parts
 * alike, told apart by vertex colour), `glass`, `glass-lit` and `signs`; props `prop`; cables `cable`; lamp sprites `glow`.
 * @param {number} night Night factor at build time.
 * @returns {{materials: Record<string, import('three').Material>, textures: import('three').Texture[]}} Materials.
 */
function createMaterials(night) {
  const atlas = createSignAtlasTexture();
  const glowMap = createGlowTexture();
  const glassLit = new MeshStandardMaterial({ vertexColors: true, roughness: 0.2, metalness: 0.4, emissive: 0xffd49a });
  glassLit.userData.nightEmissive = 1;
  glassLit.emissiveIntensity = night;
  const signs = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, map: atlas });
  if (atlas) {
    signs.emissive.setHex(0xffffff);
    signs.emissiveMap = atlas;
    signs.userData.nightEmissive = 0.5;
    signs.emissiveIntensity = night * 0.5;
  }
  const glow = new PointsMaterial({
    color: 0xffd38a,
    size: 2.4,
    sizeAttenuation: true,
    map: glowMap,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  return {
    materials: {
      facade: new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
      glass: new MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.5 }),
      'glass-lit': glassLit,
      signs,
      prop: new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }),
      cable: new LineBasicMaterial({ color: 0x161616 }),
      glow,
    },
    textures: [atlas, glowMap].filter((t) => t !== null),
  };
}

/**
 * Soft round sprite for the lamp glow.
 * @returns {CanvasTexture | null} Texture, or null without a DOM.
 */
function createGlowTexture() {
  if (!HAS_DOM) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Builds the scenery of a map.
 * @param {GameMap} map Map.
 * @param {SceneryKit} [kit] Optional models.
 * @returns {Scenery} Scenery.
 */
export function buildScenery(map, kit = {}) {
  const night = 1 - daylight(map.environment.startClockMin);
  const { materials, textures } = createMaterials(night);
  const group = new Group();
  group.name = 'scenery';

  // Buildings.
  const soups = new ChunkedSoups();
  /** @type {AwningInstance[]} */
  const awnings = [];
  map.obstacles
    .filter((o) => o.kind === 'building')
    .forEach((building, index) => {
      const layout = layoutBuilding(map, building, index);
      if (layout.use === 'shophouse') awnings.push(...buildShophouseRow(layout, soups));
      else if (layout.use === 'tower') buildTower(layout, soups);
      else buildCivic(layout, soups);
    });
  const chunkMeshes = soups.build(group, materials);

  // Props, one instanced layer per kind present, then awnings.
  const props = map.props ?? [];
  /** @type {PropLayer[]} */
  const layers = [];
  const models = kit.propModels ?? {};
  for (const kind of PROP_KINDS) {
    const ofKind = props.filter((p) => p.kind === kind);
    if (ofKind.length === 0) continue;
    const rngs = ofKind.map((p) => sceneryStream(map.id, PROP_STREAM_BASE + props.indexOf(p)));
    const instances = propInstances(
      ofKind,
      (i) => (kind === 'tree' ? range(rngs[i], 0.8, 1.25) : 1),
      (i) => (kind === 'tree' ? greenTint(range(rngs[i], 0, 1)) : 0xffffff),
    );
    layers.push(buildPropLayer(group, kind, instances, materials.prop, models[kind]));
  }
  if (awnings.length > 0) {
    const instances = awnings.map((a) => ({
      x: a.x,
      y: a.y,
      z: a.z,
      yaw: a.yaw,
      scale: /** @type {[number, number, number]} */ ([a.width, 1, 1]),
      tint: a.color,
    }));
    layers.push(buildPropLayer(group, 'awning', instances, materials.prop, models.awning));
  }

  // Cables between power poles, tutorials only.
  const cables =
    map.kind === 'tutorial'
      ? buildCables(
          props.filter((p) => p.kind === 'power-pole'),
          sceneryStream(map.id, CABLE_STREAM),
          /** @type {LineBasicMaterial} */ (materials.cable),
        )
      : null;
  if (cables) group.add(cables);

  // Lamp glow sprites.
  const lamps = props.filter((p) => p.kind === 'lamp');
  /** @type {Points | null} */
  let glow = null;
  if (lamps.length > 0) {
    const positions = lamps.flatMap((p) => localToWorld(p.pos, headingToYaw(p.heading), [LAMP_HEAD[0], LAMP_HEAD[1] - 0.15, LAMP_HEAD[2]]));
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    glow = new Points(geometry, materials.glow);
    glow.name = 'scenery-lamp-glow';
    glow.userData.nightOnly = GLOW_FROM_NIGHT;
    glow.visible = night >= GLOW_FROM_NIGHT;
    glow.castShadow = false;
    group.add(glow);
  }

  return {
    group,
    dispose() {
      for (const m of chunkMeshes) m.geometry.dispose();
      for (const l of layers) l.dispose();
      cables?.geometry.dispose();
      glow?.geometry.dispose();
      for (const m of Object.values(materials)) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

/**
 * Tree crown tint from a draw in [0, 1): slightly yellower to slightly bluer greens.
 * @param {number} u Draw.
 * @returns {number} Colour.
 */
function greenTint(u) {
  const r = Math.round(0xd8 + u * 0x27);
  const b = Math.round(0xe0 - u * 0x30);
  return (r << 16) | (0xff << 8) | b;
}
