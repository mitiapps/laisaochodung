/**
 * Pure world logic shared by the sim, the frame builder, the scorer and the converter.
 * Imports only `src/contracts/` and `src/geometry/`.
 */

export { PEDESTRIAN_FLASH_S, pedestrianSignalState, signalState, trafficLightStates } from './signals.js';
export { clockAt } from './clock.js';
export { POST_MAX_EXTRA_M, POST_OUT_M, POST_SIDE_M, POST_STEP_M, pedestrianPostPlacements } from './pedestrian-posts.js';
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
export {
  MULBERRY_INCREMENT,
  createStream,
  hash32,
  hashString,
  mulberry32,
  nextUint32,
  normalish,
  pick,
  range,
  splitmix32,
  streamFor,
  uniform,
} from './random.js';
