/**
 * Static map meshes: ground, lanes and junctions, pavements with kerbs, painted markings and the
 * non-building obstacles (parked cars, barriers). Buildings belong to the scenery
 * (`src/render/scenery/`). Geometry is merged per material, so the whole road network costs about
 * ten draw calls whatever the map size.
 *
 * Look: weathered asphalt at an albedo of about 0.11 (aged asphalt is 0.10–0.20, LBNL Heat Island
 * Group, https://heatisland.lbl.gov/node/21), granite pavement slabs through a tiling texture, and kerbs at the collider height with a
 * lighter granite top.
 */

import { CanvasTexture, Color, Group, Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three';
import { KERB_HEIGHT_M } from '../contracts/units.js';
import { polygonCentroid } from '../geometry/index.js';
import { HAS_DOM } from './assets.js';
import { nearestLaneHeading } from './layout.js';
import { crosswalkStripes, laneLineQuads, stopLineQuads } from './markings.js';
import { TriangleSoup, outwardNormal } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {[number, number]} Vec2 */

/** Heights of the layers in metres, stacked to avoid z-fighting; the pavement sits on the kerb top. */
export const LAYER_Y = Object.freeze({ ground: -0.03, road: 0, paint: 0.015, pavement: KERB_HEIGHT_M });

/** Width of the lighter granite strip along every pavement edge (kerb stone top, design). */
export const KERB_STONE_M = 0.18;
/** Pavement texture repeat in metres: one tile holds 4 × 2 slabs of 30 × 60 cm (design). */
export const PAVEMENT_TILE_M = 1.2;

/** Margin of ground drawn around the map, in metres. */
const GROUND_MARGIN_M = 150;

/** Colours of the static materials. */
const COLORS = Object.freeze({
  ground: 0x6f7f4f,
  // sRGB 0x5c5d5f is a linear albedo of about 0.105.
  asphalt: 0x5c5d5f,
  pavement: 0xb3b0aa,
  kerb: 0xd6d4ce,
  white: 0xf2f2f0,
  yellow: 0xf2c230,
  'parked-car': 0x5a6f8a,
  barrier: 0xd84a3a,
});

/**
 * @typedef {object} RoadMeshes
 * @property {Group} group Everything static.
 * @property {MeshStandardMaterial} asphalt Asphalt material (the scene darkens it in rain).
 * @property {Record<string, number>} triangles Triangles per material key, for tests and budgets.
 * @property {() => void} dispose Free geometries and materials.
 */

/**
 * Axis-aligned bounds of every polygon of the map.
 * @param {GameMap} map Map.
 * @returns {{minX: number, maxX: number, minZ: number, maxZ: number}} Bounds.
 */
export function mapBounds(map) {
  /** @type {Vec2[]} */
  const pts = [];
  for (const road of map.roads) for (const lane of road.lanes) pts.push(...lane.polygon);
  for (const j of map.junctions) pts.push(...j.polygon);
  for (const p of map.pavements) pts.push(...p.polygon);
  for (const o of map.obstacles) pts.push(...o.footprint);
  pts.push([map.route.start.pos.x, map.route.start.pos.z]);
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/**
 * Builds the static meshes of a map.
 * @param {GameMap} map Map.
 * @returns {RoadMeshes} Meshes.
 */
export function buildRoadMeshes(map) {
  /** @type {Record<string, TriangleSoup>} */
  const soups = {};
  /**
   * @param {string} key Material key.
   * @returns {TriangleSoup} Soup.
   */
  const soup = (key) => (soups[key] ??= new TriangleSoup());

  const b = mapBounds(map);
  soup('ground').addGroundPolygon(
    [
      [b.minX - GROUND_MARGIN_M, b.minZ - GROUND_MARGIN_M],
      [b.maxX + GROUND_MARGIN_M, b.minZ - GROUND_MARGIN_M],
      [b.maxX + GROUND_MARGIN_M, b.maxZ + GROUND_MARGIN_M],
      [b.minX - GROUND_MARGIN_M, b.maxZ + GROUND_MARGIN_M],
    ],
    LAYER_Y.ground,
  );

  for (const road of map.roads) {
    /** @type {Map<string, Lane>} */
    const lanes = new Map(road.lanes.map((l) => [l.id, l]));
    for (const lane of road.lanes) soup('asphalt').addGroundPolygon(lane.polygon, LAYER_Y.road);
    for (const line of road.laneLines) {
      const { color, quads } = laneLineQuads(line, lanes);
      soup(color).addGroundQuads(quads, LAYER_Y.paint);
    }
  }
  for (const j of map.junctions) soup('asphalt').addGroundPolygon(j.polygon, LAYER_Y.road);

  for (const sl of map.stopLines) soup('white').addGroundQuads(stopLineQuads(sl), LAYER_Y.paint);
  for (const cw of map.crosswalks) {
    const heading = nearestLaneHeading(map, polygonCentroid(cw.polygon));
    if (heading === null) continue;
    soup('white').addGroundQuads(crosswalkStripes(cw.polygon, heading), LAYER_Y.paint);
  }

  for (const p of map.pavements) {
    soup('pavement').addGroundPolygon(p.polygon, LAYER_Y.pavement, PAVEMENT_TILE_M);
    soup('kerb').addWalls(p.polygon, LAYER_Y.ground, LAYER_Y.pavement);
    addKerbStones(soup('kerb'), p.polygon);
  }
  for (const o of map.obstacles) if (o.kind !== 'building') soup(o.kind).addPrism(o.footprint, o.height);

  const group = new Group();
  group.name = 'map-static';
  /** @type {MeshStandardMaterial[]} */
  const materials = [];
  /** @type {Record<string, number>} */
  const triangles = {};
  /** @type {MeshStandardMaterial | null} */
  let asphalt = null;
  const slabs = createPavementTexture();
  for (const [key, s] of Object.entries(soups)) {
    const geometry = s.toGeometry();
    if (!geometry) continue;
    const paint = key === 'white' || key === 'yellow';
    const material = new MeshStandardMaterial({
      color: new Color(slabs && key === 'pavement' ? 0xffffff : (COLORS[/** @type {keyof typeof COLORS} */ (key)] ?? 0x888888)),
      map: key === 'pavement' ? slabs : null,
      roughness: paint ? 0.6 : 0.9,
      metalness: 0,
      polygonOffset: paint,
      polygonOffsetFactor: paint ? -2 : 0,
      polygonOffsetUnits: paint ? -2 : 0,
    });
    if (key === 'asphalt') asphalt = material;
    materials.push(material);
    const mesh = new Mesh(geometry, material);
    mesh.name = `static-${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    triangles[key] = s.triangleCount;
  }

  return {
    group,
    asphalt: asphalt ?? new MeshStandardMaterial({ color: COLORS.asphalt }),
    triangles,
    dispose() {
      group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      slabs?.dispose();
    },
  };
}

/**
 * Lighter kerb-stone strip just inside every pavement edge, a hair above the pavement surface.
 * @param {TriangleSoup} soup Kerb soup.
 * @param {Vec2[]} polygon Pavement ring.
 */
export function addKerbStones(soup, polygon) {
  const y = LAYER_Y.pavement + 0.002;
  for (let i = 0; i < polygon.length; i += 1) {
    const n = outwardNormal(polygon, i);
    if (!n) continue;
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const w = KERB_STONE_M;
    soup.addQuad(
      [a[0], y, a[1]],
      [b[0], y, b[1]],
      [b[0] - n[0] * w, y, b[1] - n[1] * w],
      [a[0] - n[0] * w, y, a[1] - n[1] * w],
      [0, 1, 0],
    );
  }
}

/**
 * Grey granite slabs, 4 × 2 per tile with darker joints and a little tone variation per slab.
 * @returns {CanvasTexture | null} Repeating texture, or null without a DOM.
 */
function createPavementTexture() {
  if (!HAS_DOM) return null;
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#77736c';
  ctx.fillRect(0, 0, px, px);
  const tones = ['#b6b2ab', '#aeaaa2', '#bbb7b0', '#a9a59e', '#b2aea6', '#b8b4ad', '#aca8a0', '#b4b0a9'];
  const cw = px / 4;
  const ch = px / 2;
  for (let r = 0; r < 2; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      ctx.fillStyle = tones[r * 4 + c];
      ctx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 4);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
