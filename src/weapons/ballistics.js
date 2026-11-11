import * as THREE from 'three';

export const GRAVITY = 9.81;
const SEGMENT_TIME = 1 / 120; // s per traced segment

const _next = new THREE.Vector3();
const _seg = new THREE.Vector3();

/** How far a bullet has dropped below its launch line after `range` metres (fired level). */
export const dropAt = (range, muzzleVelocity) => 0.5 * GRAVITY * (range / muzzleVelocity) ** 2;

/**
 * Trace a bullet: constant-gravity flight in short steps, each step raycast
 * against `colliders`. Returns the first hit (its `distance` measured along
 * the path) or null.
 * @param {THREE.Raycaster} raycaster
 * @param {THREE.Object3D[]} colliders
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} direction unit
 * @param {number} muzzleVelocity m/s
 * @param {number} maxRange metres
 */
export function traceBullet(raycaster, colliders, origin, direction, muzzleVelocity, maxRange) {
  const pos = origin.clone();
  const vel = direction.clone().multiplyScalar(muzzleVelocity);
  const t = SEGMENT_TIME;
  let travelled = 0;
  while (travelled < maxRange) {
    _next.copy(pos).addScaledVector(vel, t);
    _next.y -= 0.5 * GRAVITY * t * t;
    vel.y -= GRAVITY * t;
    _seg.subVectors(_next, pos);
    const len = _seg.length();
    raycaster.set(pos, _seg.divideScalar(len));
    raycaster.far = len;
    const hit = raycaster.intersectObjects(colliders, true)[0];
    if (hit) {
      hit.distance += travelled;
      return hit;
    }
    travelled += len;
    pos.copy(_next);
  }
  return null;
}
