/**
 * Static map meshes: ground, lanes and junctions, pavements with kerbs, painted markings and
 * obstacles. Geometry is merged per material, so the whole road network costs about ten draw
 * calls whatever the map size.
 */

import { Color, Group, Mesh, MeshStandardMaterial } from 'three';
import { polygonCentroid } from '../geometry/index.js';
import { nearestLaneHeading } from './layout.js';
import { crosswalkStripes, laneLineQuads, stopLineQuads } from './markings.js';
import { TriangleSoup } from './triangle-soup.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/map.js').Lane} Lane */
/** @typedef {[number, number]} Vec2 */

/** Heights of the layers in metres, stacked to avoid z-fighting. */
export const LAYER_Y = Object.freeze({ ground: -0.03, road: 0, paint: 0.015, pavement: 0.15 });

/** Margin of ground drawn around the map, in metres. */
const GROUND_MARGIN_M = 150;

/** Colours of the static materials. */
const COLORS = Object.freeze({
  ground: 0x6f7f4f,
  asphalt: 0x3d3f42,
  pavement: 0xb7b2a8,
  kerb: 0xdcdcd6,
  white: 0xf2f2f0,
  yellow: 0xf2c230,
  building: 0xd8cfc0,
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
    soup('pavement').addGroundPolygon(p.polygon, LAYER_Y.pavement);
    soup('kerb').addWalls(p.polygon, LAYER_Y.ground, LAYER_Y.pavement);
  }
  for (const o of map.obstacles) soup(o.kind).addPrism(o.footprint, o.height);

  const group = new Group();
  group.name = 'map-static';
  /** @type {MeshStandardMaterial[]} */
  const materials = [];
  /** @type {Record<string, number>} */
  const triangles = {};
  /** @type {MeshStandardMaterial | null} */
  let asphalt = null;
  for (const [key, s] of Object.entries(soups)) {
    const geometry = s.toGeometry();
    if (!geometry) continue;
    const paint = key === 'white' || key === 'yellow';
    const material = new MeshStandardMaterial({
      color: new Color(COLORS[/** @type {keyof typeof COLORS} */ (key)] ?? 0x888888),
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
    },
  };
}
