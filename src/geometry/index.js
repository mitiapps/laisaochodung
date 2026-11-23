/**
 * Pure 2D geometry on the ground plane. Points are `[x, z]` tuples; see `src/contracts/units.js`
 * for axes and the heading convention. This module imports nothing outside itself.
 */

export { normalizeAngle, angleDiff, headingVector, leftVector, headingOf, footprint, distance } from './pose.js';
export { sideOf, segmentIntersection, segmentsIntersect, segmentCrossesPolyline } from './segment.js';
export { pointInPolygon, polygonSignedArea, polygonCentroid, polygonsIntersect } from './polygon.js';
export {
  polylineLength,
  cumulativeLengths,
  pointAtDistance,
  slicePolyline,
  offsetPolyline,
  projectOntoPolyline,
} from './polyline.js';
