/**
 * Player scooter, built from primitives. The CC BY 3.0 "Scooter" by Julien Savoie named in the plan
 * is a kick scooter, not a motor scooter, so it is not shipped; a motor-scooter GLB can be dropped
 * in later by setting `glb` and `wheelNodes` (front, rear).
 * @type {import('./model-config.js').ModelConfig}
 */
export default Object.freeze({
  id: 'scooter',
  kind: 'motorbike',
  glb: null,
  wheelNodes: [],
  wheelRadiusM: 0.25,
  heightM: 1.15,
  color: 0xc0392b,
});
