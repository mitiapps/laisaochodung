/**
 * Rules data checks, pure: run by the rules build, by tests and by the release gate.
 */

export { validateRules, countUnverified, requiredGroups } from './validate.js';
