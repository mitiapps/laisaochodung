/**
 * Player scooter: the procedural scooter of the traffic (`motorbike.js`) with a rider, so the ego
 * and the traffic share one look. No CC0 motor scooter model exists.
 * @type {import('./model-config.js').ModelConfig}
 */
export default Object.freeze({
  id: 'scooter',
  kind: 'motorbike',
  glb: null,
  wheelNodes: [],
  wheelRadiusM: 0.27,
  heightM: 1.15,
  color: 0xc0392b,
  procedural: 'scooter',
});
