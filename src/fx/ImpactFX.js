import * as THREE from 'three';

const _normal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();

/**
 * Pooled bullet-hole decals. Dust puffs and sparks arrive in Pass 4.
 */
export class ImpactFX {
  constructor(scene, poolSize = 48) {
    const geometry = new THREE.CircleGeometry(0.012, 10);
    const material = new THREE.MeshBasicMaterial({
      color: 0x1a120a,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      depthWrite: false,
    });
    this.pool = [];
    this.next = 0;
    for (let i = 0; i < poolSize; i++) {
      const m = new THREE.Mesh(geometry, material);
      m.visible = false;
      m.name = 'bulletHole';
      scene.add(m);
      this.pool.push(m);
    }
  }

  /** @param {THREE.Intersection} hit */
  spawn(hit) {
    const decal = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;

    if (hit.face) {
      _normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      _normal.copy(hit.face.normal).applyMatrix3(_normalMatrix).normalize();
    } else {
      _normal.set(0, 1, 0);
    }
    decal.position.copy(hit.point).addScaledVector(_normal, 0.002);
    decal.lookAt(decal.position.x + _normal.x, decal.position.y + _normal.y, decal.position.z + _normal.z);
    decal.rotateZ(Math.random() * Math.PI * 2);
    decal.scale.setScalar(0.8 + Math.random() * 0.5);
    decal.visible = true;
    return decal;
  }
}
