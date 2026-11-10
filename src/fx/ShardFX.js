import * as THREE from 'three';

const GRAVITY = -9.81;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/**
 * Flying debris (glass shards, wood splinters) as one InstancedMesh: a single
 * draw call however many pieces are in the air. Pieces fall under gravity,
 * bounce on the ground, then shrink away.
 */
export class ShardFX {
  constructor(scene, max = 192) {
    const geo = new THREE.TetrahedronGeometry(0.02);
    geo.scale(1, 0.35, 1.6);
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.1 }),
      max,
    );
    this.mesh.frustumCulled = false; // instances move; the bounds would be stale
    this.mesh.castShadow = false;
    this.mesh.name = 'shards';
    this.mesh.raycast = () => {};
    this.max = max;
    this.next = 0;
    this.items = Array.from({ length: max }, () => ({
      alive: false, life: 0, size: 1,
      p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Vector3(), w: new THREE.Vector3(),
    }));
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < max; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.set(0xffffff));
    }
    scene.add(this.mesh);
  }

  get activeCount() {
    return this.items.filter((s) => s.alive).length;
  }

  /**
   * @param {THREE.Vector3} point
   * @param {number} color hex
   * @param {number} count
   * @param {THREE.Vector3} [push] bullet direction: debris is thrown along it
   */
  burst(point, color, count, push = null, { speed = 2.5, size = 1, life = 2.5 } = {}) {
    for (let i = 0; i < count; i++) {
      const s = this.items[this.next];
      const idx = this.next;
      this.next = (this.next + 1) % this.max;
      s.alive = true;
      s.life = life * (0.7 + Math.random() * 0.6);
      s.size = size * (0.5 + Math.random());
      s.p.copy(point);
      s.v.set(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      if (push) s.v.addScaledVector(push, speed * 0.6);
      s.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      s.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30);
      _c.set(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
      this.mesh.setColorAt(idx, _c);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      const s = this.items[i];
      if (!s.alive) continue;
      any = true;
      s.life -= dt;
      if (s.life <= 0) {
        s.alive = false;
        this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      s.v.y += GRAVITY * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < 0.005) {
        // Bounce and skid on the sand.
        s.p.y = 0.005;
        s.v.y *= -0.25;
        s.v.x *= 0.5;
        s.v.z *= 0.5;
        s.w.multiplyScalar(0.5);
      }
      s.r.addScaledVector(s.w, dt);
      const fade = Math.min(1, s.life / 0.4);
      _s.setScalar(s.size * fade);
      _m.compose(s.p, _q.setFromEuler(_e.set(s.r.x, s.r.y, s.r.z)), _s);
      this.mesh.setMatrixAt(i, _m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
