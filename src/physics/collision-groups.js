/**
 * Collision groups shared by the vehicle rig and the sim colliders. A Rapier interaction group is
 * `membership << 16 | filter`.
 */

export const GROUP = Object.freeze({
  GROUND: 0x0001,
  KERB: 0x0002,
  STATIC: 0x0004,
  ACTOR: 0x0008,
  EGO: 0x0010,
});

/**
 * Packs a Rapier interaction group.
 * @param {number} membership Groups the collider belongs to.
 * @param {number} filter Groups it interacts with.
 * @returns {number} Packed groups.
 */
export function interactionGroups(membership, filter) {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/** Groups the wheel rays see: the road surface and kerb tops, never bodies or walls. */
export const WHEEL_RAY_GROUPS = interactionGroups(GROUP.EGO, GROUP.GROUND | GROUP.KERB);
