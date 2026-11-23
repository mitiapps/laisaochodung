/**
 * Detector registry: one module per `detection.type`.
 */

import * as againstLaneDir from './against-lane-dir.js';
import * as collision from './collision.js';
import * as crosswalkOccupied from './crosswalk-occupied.js';
import * as entryCross from './entry-cross.js';
import * as footprintInPolygon from './footprint-in-polygon.js';
import * as gapAhead from './gap-ahead.js';
import * as highBeamMisuse from './high-beam-misuse.js';
import * as hornInWindow from './horn-in-window.js';
import * as junctionTurn from './junction-turn.js';
import * as laneLineCross from './lane-line-cross.js';
import * as lightsRequired from './lights-required.js';
import * as speedOverLimit from './speed-over-limit.js';
import * as stopLineNoSlow from './stop-line-no-slow.js';
import * as stopLineNoStop from './stop-line-no-stop.js';
import * as stopLineOnRed from './stop-line-on-red.js';
import * as stoppedInZone from './stopped-in-zone.js';

/** @typedef {import('./common.js').Detector} Detector */

/** @type {Readonly<Record<string, Detector>>} */
export const DETECTORS = Object.freeze({
  'speed-over-limit': speedOverLimit,
  'stop-line-on-red': stopLineOnRed,
  'against-lane-dir': againstLaneDir,
  'lane-line-cross': laneLineCross,
  'junction-turn': junctionTurn,
  'stop-line-no-stop': stopLineNoStop,
  'stop-line-no-slow': stopLineNoSlow,
  'entry-cross': entryCross,
  'lights-required': lightsRequired,
  'high-beam-misuse': highBeamMisuse,
  'horn-in-window': hornInWindow,
  'stopped-in-zone': stoppedInZone,
  'footprint-in-polygon': footprintInPolygon,
  'crosswalk-occupied': crosswalkOccupied,
  'gap-ahead': gapAhead,
  collision,
});

/** Known detector types. */
export const DETECTOR_TYPES = Object.freeze(Object.keys(DETECTORS));
