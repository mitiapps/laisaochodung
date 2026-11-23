import { KENNEY_WHEELS } from './model-config.js';

/** @type {import('./model-config.js').ModelConfig} Player car: Kenney Car Kit "sedan" (CC0). */
export default Object.freeze({
  id: 'car-sedan',
  kind: 'car',
  glb: 'models/car-kit/sedan.glb',
  wheelNodes: [...KENNEY_WHEELS],
  wheelRadiusM: 0.32,
  heightM: 1.45,
  color: 0x2f6fb0,
});
