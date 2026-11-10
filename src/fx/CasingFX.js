import * as THREE from 'three';
import { CANNON } from '../physics/PhysicsWorld.js';

const LIFETIME = 12; // seconds a casing stays in the world
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);

/**
 * Spent brass casings as small rigid bodies, drawn with one InstancedMesh.
 * They tumble out of the cylinder, bounce and tinkle on whatever they land on,
 * then disappear after a while.
 */
export class CasingFX {
  constructor(scene, physics, sfx, max = 18) {
    this.physics = physics;
    this.sfx = sfx;
    const geo = new THREE.CylinderGeometry(0.0058, 0.0058, 0.03, 10);
    geo.rotateX(Math.PI / 2); // long axis along Z, like a chamber
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.9, roughness: 0.3 }),
      max,
    );
    this.mesh.frustumCulled = false;
    this.mesh.name = 'casings';
    this.mesh.raycast = () => {};
    scene.add(this.mesh);
    this.items = Array.from({ length: max }, (_, i) => {
      const body = new CANNON.Body({ mass: 0.012, linearDamping: 0.05, angularDamping: 0.1, allowSleep: true });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.0058, 0.0058, 0.015)));
      body.userData = { name: 'casing' };
      const item = { body, alive: false, age: 0, tinkCooldown: 0 };
      body.addEventListener('collide', (e) => {
        const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (speed > 0.25 && item.tinkCooldown <= 0) {
          item.tinkCooldown = 0.06;
          this.sfx.brassTink(_p.set(body.position.x, body.position.y, body.position.z).clone(), speed);
        }
      });
      this.mesh.setMatrixAt(i, _m.compose(_zero, _q.identity(), _zero));
      return item;
    });
    this.next = 0;
  }

  get activeCount() {
    return this.items.filter((c) => c.alive).length;
  }

  /**
   * @param {THREE.Vector3} position world position of the chamber
   * @param {THREE.Quaternion} quaternion casing orientation (gun's)
   * @param {THREE.Vector3} velocity world velocity
   */
  eject(position, quaternion, velocity) {
    const item = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    const b = item.body;
    b.position.set(position.x, position.y, position.z);
    b.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    b.velocity.set(velocity.x, velocity.y, velocity.z);
    b.angularVelocity.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
    b.wakeUp();
    this.physics.addBody(b);
    item.alive = true;
    item.age = 0;
  }

  update(dt) {
    let any = false;
    this.items.forEach((item, i) => {
      if (!item.alive) return;
      any = true;
      item.age += dt;
      item.tinkCooldown -= dt;
      const b = item.body;
      if (item.age > LIFETIME || b.position.y < -1) {
        item.alive = false;
        this.physics.removeBody(b);
        this.mesh.setMatrixAt(i, _m.compose(_zero, _q.identity(), _zero));
        return;
      }
      _p.set(b.position.x, b.position.y, b.position.z);
      _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _one));
    });
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
