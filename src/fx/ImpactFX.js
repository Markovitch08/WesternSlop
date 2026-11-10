import * as THREE from 'three';

const _normal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const noRaycast = () => {};

/**
 * Pooled bullet-hole decals. Each decal is parented to the mesh it hit, so
 * holes ride along with swinging gongs and falling pop-up targets. Steel
 * takes a pale lead splash instead of a hole. Dust puffs and sparks arrive in
 * Pass 4.
 */
export class ImpactFX {
  constructor(scene, poolSize = 64) {
    this.scene = scene;
    this.geometry = new THREE.CircleGeometry(0.012, 10);
    const decalMat = (color) => new THREE.MeshBasicMaterial({
      color, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false,
    });
    this.materials = {
      hole: decalMat(0x1a120a),
      splash: decalMat(0x9a9a98),
    };
    this.pool = [];
    this.next = 0;
    for (let i = 0; i < poolSize; i++) {
      const m = new THREE.Mesh(this.geometry, this.materials.hole);
      m.visible = false;
      m.name = 'bulletHole';
      m.raycast = noRaycast; // bullets must never hit a decal
      scene.add(m);
      this.pool.push(m);
    }
  }

  /** @param {THREE.Intersection} hit @returns {THREE.Mesh|null} */
  spawn(hit) {
    const target = hit.object;
    if (target.userData.noDecal) return null;
    const decal = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;

    if (hit.face) {
      _normalMatrix.getNormalMatrix(target.matrixWorld);
      _normal.copy(hit.face.normal).applyMatrix3(_normalMatrix).normalize();
    } else {
      _normal.set(0, 1, 0);
    }
    const steel = target.userData.surface === 'steel';
    decal.material = steel ? this.materials.splash : this.materials.hole;

    // Place in world space, then re-parent while keeping the world transform.
    this.scene.attach(decal);
    decal.position.copy(hit.point).addScaledVector(_normal, 0.002);
    decal.quaternion.identity();
    decal.lookAt(decal.position.x + _normal.x, decal.position.y + _normal.y, decal.position.z + _normal.z);
    decal.rotateZ(Math.random() * Math.PI * 2);
    decal.scale.setScalar((steel ? 1.6 : 1) * (0.8 + Math.random() * 0.5));
    decal.visible = true;
    decal.updateMatrixWorld();
    target.attach(decal);
    return decal;
  }
}
