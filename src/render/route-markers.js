/**
 * Route guidance: a floating marker over the next checkpoint (index from `frame.route`), and a
 * finish arch over `route.finish`, highlighted once only the finish is left.
 */

import {
  ConeGeometry,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  BoxGeometry,
} from 'three';
import { finishArchPose, finishHeading } from './layout.js';

/** @typedef {import('../contracts/map.js').GameMap} GameMap */
/** @typedef {import('../contracts/telemetry.js').Frame} Frame */

const MARKER_COLOR = 0x22d3ee;
const ARCH_HEIGHT_M = 4.5;
const POST_M = 0.3;

/**
 * Index of the checkpoint to mark, or null when only the finish is left.
 * @param {GameMap} map Map.
 * @param {Frame} frame Frame.
 * @returns {number | null} Checkpoint index.
 */
export function markedCheckpoint(map, frame) {
  const i = frame.route.nextCheckpoint;
  return Number.isInteger(i) && i >= 0 && i < map.route.checkpoints.length ? i : null;
}

/**
 * Checkered black-and-white texture, built from data so it needs no DOM.
 * @returns {DataTexture} Texture.
 */
function checkerTexture() {
  const w = 8;
  const h = 2;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = (x + y) % 2 === 0 ? 255 : 20;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  const t = new DataTexture(data, w, h);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.wrapS = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * @typedef {object} RouteMarkers
 * @property {Group} group Meshes.
 * @property {(frame: Frame, timeS: number) => void} update Move the marker; `timeS` animates it.
 * @property {() => void} dispose Free resources.
 */

/**
 * Builds the checkpoint marker and the finish arch.
 * @param {GameMap} map Map.
 * @returns {RouteMarkers} Markers.
 */
export function buildRouteMarkers(map) {
  const group = new Group();
  group.name = 'route-markers';
  const markerMaterial = new MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.85 });
  const ringMaterial = new MeshBasicMaterial({
    color: MARKER_COLOR,
    transparent: true,
    opacity: 0.5,
    side: DoubleSide,
    depthWrite: false,
  });
  const coneGeometry = new ConeGeometry(0.4, 0.8, 4);
  const ringGeometry = new RingGeometry(1.5, 1.75, 32);

  const marker = new Group();
  marker.name = 'checkpoint-marker';
  const cone = new Mesh(coneGeometry, markerMaterial);
  cone.rotation.x = Math.PI; // point down
  marker.add(cone);
  const ring = new Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  marker.add(ring);
  group.add(marker);

  const pose = finishArchPose(map.route.finish.polygon, finishHeading(map));
  const checker = checkerTexture();
  checker.repeat.set(Math.max(1, Math.round(pose.width / 1.2)), 1);
  const bannerMaterial = new MeshBasicMaterial({ map: checker, side: DoubleSide });
  const postMaterial = new MeshBasicMaterial({ color: 0xeeeeee });
  const postGeometry = new BoxGeometry(POST_M, ARCH_HEIGHT_M, POST_M);
  const bannerGeometry = new BoxGeometry(0.1, 0.8, pose.width + POST_M * 2);
  const arch = new Group();
  arch.name = 'finish-arch';
  arch.position.set(pose.x, 0, pose.z);
  arch.rotation.y = pose.heading;
  for (const side of [-1, 1]) {
    const post = new Mesh(postGeometry, postMaterial);
    post.position.set(0, ARCH_HEIGHT_M / 2, side * (pose.width / 2 + POST_M / 2));
    arch.add(post);
  }
  const banner = new Mesh(bannerGeometry, bannerMaterial);
  banner.position.y = ARCH_HEIGHT_M - 0.4;
  arch.add(banner);
  group.add(arch);

  return {
    group,
    update(frame, timeS) {
      const i = markedCheckpoint(map, frame);
      marker.visible = i !== null;
      if (i !== null) {
        const cp = map.route.checkpoints[i];
        marker.position.set(cp.pos.x, 0, cp.pos.z);
        cone.position.y = 4.2 + Math.sin(timeS * 3) * 0.25;
        cone.rotation.y = timeS * 1.5;
      }
      postMaterial.color.setHex(i === null ? MARKER_COLOR : 0xeeeeee);
    },
    dispose() {
      for (const g of [coneGeometry, ringGeometry, postGeometry, bannerGeometry]) g.dispose();
      for (const m of [markerMaterial, ringMaterial, bannerMaterial, postMaterial]) m.dispose();
      checker.dispose();
    },
  };
}
