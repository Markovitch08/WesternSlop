import * as THREE from 'three';

const _head = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * Hip holster that follows the player's body. Body yaw lags the head, so
 * glancing around doesn't swing the holster away from the hand.
 */
export class Holster {
  /**
   * @param {THREE.Object3D} parent
   * @param {'left'|'right'} side
   */
  constructor(parent, side = 'right') {
    this.side = side;
    this.object = new THREE.Group();
    this.object.name = 'holster';
    this.bodyYaw = 0;

    const leather = new THREE.MeshStandardMaterial({ color: 0x6e4424, roughness: 0.85 });
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.2, 0.06), leather);
    pouch.position.set(0, -0.11, -0.06);
    pouch.castShadow = true;
    this.object.add(pouch);

    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.14), leather);
    belt.position.set(-0.035 * this.#sign, 0.0, -0.03);
    this.object.add(belt);

    // Where the revolver's grip origin sits when holstered: barrel pointing down.
    this.socket = new THREE.Object3D();
    this.socket.rotation.x = -Math.PI / 2;
    this.object.add(this.socket);

    parent.add(this.object);
  }

  get #sign() {
    return this.side === 'right' ? 1 : -1;
  }

  /**
   * @param {THREE.Camera} camera the player's head
   * @param {number} dt
   */
  update(camera, dt) {
    camera.getWorldPosition(_head);
    camera.getWorldQuaternion(_headQuat);
    _fwd.set(0, 0, -1).applyQuaternion(_headQuat);
    const headYaw = Math.atan2(-_fwd.x, -_fwd.z);

    // Damp towards head yaw along the shortest arc.
    let diff = headYaw - this.bodyYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.bodyYaw += diff * Math.min(1, dt * 3);

    _offset.set(0.2 * this.#sign, 0, 0.04).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.bodyYaw);
    this.object.position.set(_head.x + _offset.x, Math.max(0.55, _head.y - 0.68), _head.z + _offset.z);
    this.object.rotation.set(0, this.bodyYaw, 0);
  }
}
