import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 4;

const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * Thin wrapper around a cannon-es world.
 *
 * The world is mostly static boxes (ground, props, stands) plus a handful of
 * kinematic bodies that follow animated meshes (swinging gongs, pop-up
 * duelists) and the one dynamic body that matters: the revolver when it's out
 * of the player's hand. Static/kinematic bodies carry `userData`:
 *   surface       'sand' | 'wood' | 'steel' | 'glass' | 'plant' (clatter sounds)
 *   onGunImpact   (speed, point) => void (targets react to a thrown or dropped gun)
 */
export class PhysicsWorld {
  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    this.world.defaultContactMaterial.friction = 0.45;
    this.world.defaultContactMaterial.restitution = 0.15;
    this.followers = [];

    const ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    ground.userData = { surface: 'sand', name: 'ground' };
    this.world.addBody(ground);
    this.ground = ground;
  }

  /** Static box at a world centre with half extents (and optional rotation). */
  addStaticBox(center, halfExtents, quaternion = null, userData = {}) {
    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z)),
    });
    body.position.set(center.x, center.y, center.z);
    if (quaternion) body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    body.userData = { surface: 'wood', ...userData };
    this.world.addBody(body);
    return body;
  }

  /**
   * Static oriented box fitted to a mesh's local bounding box. Good for any
   * mesh that is itself a box (posts, planks, stands, boards).
   */
  addStaticFromMesh(mesh, userData = {}) {
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingBox();
    _box.copy(mesh.geometry.boundingBox);
    _box.getCenter(_center);
    _box.getSize(_size);
    mesh.matrixWorld.decompose(_pos, _quat, _scale);
    _size.multiply(_scale).multiplyScalar(0.5);
    _center.applyMatrix4(mesh.matrixWorld);
    return this.addStaticBox(_center, _size, _quat, { surface: mesh.userData.surface ?? 'wood', ...userData });
  }

  /**
   * Kinematic box that follows `mesh` every step (its local bounding box, or a
   * given local box). Use for moving targets the gun can bump into.
   */
  addFollower(mesh, userData = {}, localBox = null) {
    mesh.geometry.computeBoundingBox();
    const box = localBox ?? mesh.geometry.boundingBox;
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const offset = box.getCenter(new THREE.Vector3());
    const body = new CANNON.Body({ type: CANNON.Body.KINEMATIC, mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(
      Math.max(half.x, 0.01), Math.max(half.y, 0.01), Math.max(half.z, 0.01),
    )), new CANNON.Vec3(offset.x, offset.y, offset.z));
    body.userData = { surface: mesh.userData.surface ?? 'wood', ...userData };
    this.world.addBody(body);
    this.followers.push({ mesh, body });
    this.#syncFollower(mesh, body);
    return body;
  }

  #syncFollower(mesh, body) {
    mesh.updateWorldMatrix(true, false);
    mesh.matrixWorld.decompose(_pos, _quat, _scale);
    body.position.set(_pos.x, _pos.y, _pos.z);
    body.quaternion.set(_quat.x, _quat.y, _quat.z, _quat.w);
  }

  addBody(body) {
    if (!this.world.bodies.includes(body)) this.world.addBody(body);
  }

  removeBody(body) {
    if (this.world.bodies.includes(body)) this.world.removeBody(body);
  }

  step(dt) {
    for (const f of this.followers) this.#syncFollower(f.mesh, f.body);
    this.world.step(FIXED_STEP, dt, MAX_SUBSTEPS);
  }
}

export { CANNON };
