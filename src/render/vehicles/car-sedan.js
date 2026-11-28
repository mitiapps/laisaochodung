import { KENNEY_WHEELS } from './model-config.js';

/**
 * Player car: the Tripo "sedan" body, with the Kenney Car Kit "sedan" (CC0) as its fallback.
 * @type {import('./model-config.js').ModelConfig}
 */
export default Object.freeze({
  id: 'car-sedan',
  kind: 'car',
  glb: 'models/car-kit/sedan.glb',
  tripo: 'sedan',
  wheelNodes: [...KENNEY_WHEELS],
  wheelRadiusM: 0.32,
  heightM: 1.45,
  color: 0x2f6fb0,
});
