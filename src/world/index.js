/**
 * Pure world logic shared by the sim, the frame builder, the scorer and the converter.
 * Imports only `src/contracts/` and `src/geometry/`.
 */

export { signalState, trafficLightStates } from './signals.js';
export { clockAt } from './clock.js';
export {
  ACTOR_DECEL_MPS2,
  HOLD_MARGIN_M,
  actorStoppingDistance,
  createActorState,
  stepActors,
} from './actors.js';
export {
  CHECKPOINT_DEPTH_M,
  CHECKPOINT_HALF_WIDTH_M,
  createRouteState,
  finishTarget,
  insideCheckpoint,
  stepRoute,
} from './route.js';
