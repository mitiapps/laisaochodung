/**
 * Tuning lookup by catalog id.
 */

import { carSedan } from './car-sedan.js';
import { scooter } from './scooter.js';

/** @type {Readonly<Record<string, import('../tuning.js').VehicleTuning>>} */
const TUNINGS = Object.freeze({ [carSedan.id]: carSedan, [scooter.id]: scooter });

/**
 * Tuning of a catalog vehicle.
 * @param {string} vehicleId Catalog id.
 * @returns {import('../tuning.js').VehicleTuning} Tuning.
 */
export function vehicleTuning(vehicleId) {
  const tuning = TUNINGS[vehicleId];
  if (!tuning) throw new Error(`No physics tuning for vehicle "${vehicleId}"`);
  return tuning;
}
