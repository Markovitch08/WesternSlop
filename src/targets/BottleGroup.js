import * as THREE from 'three';

const RESPAWN_DELAY = 2.5; // seconds after the last bottle breaks
const BOTTLE_COLORS = [0x2e6b3a, 0x6b3a12, 0x9fc7c9];

let bottleGeo = null;
let colliderGeo = null;
const materials = new Map();

function bottleGeometry() {
  if (bottleGeo) return bottleGeo;
  const profile = [
    [0, 0], [0.034, 0], [0.036, 0.01], [0.036, 0.17], [0.03, 0.2], [0.014, 0.235],
    [0.012, 0.285], [0.015, 0.29], [0.015, 0.3], [0, 0.3],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  bottleGeo = new THREE.LatheGeometry(profile, 14);
  return bottleGeo;
}

function bottleMaterial(color) {
  if (!materials.has(color)) {
    materials.set(color, new THREE.MeshStandardMaterial({
      color, transparent: true, opacity: 0.82, roughness: 0.08, metalness: 0.1, envMapIntensity: 1.6,
    }));
  }
  return materials.get(color);
}

/**
 * A row of glass bottles. Each bottle has an invisible, slightly fatter
 * cylinder collider (bottles are small in VR; this keeps the game fair).
 * Bottles shatter into instanced shards; the row resets once all are broken.
 */
export class BottleGroup {
  /** @param {THREE.Vector3[]} positions world positions of bottle bases */
  constructor(parent, positions) {
    this.type = 'bottle';
    this.object = new THREE.Group();
    this.object.name = 'bottles';
    parent.add(this.object);
    colliderGeo ??= new THREE.CylinderGeometry(0.05, 0.05, 0.31, 8).translate(0, 0.155, 0);

    this.bottles = positions.map((pos, i) => {
      const color = BOTTLE_COLORS[i % BOTTLE_COLORS.length];
      const mesh = new THREE.Mesh(bottleGeometry(), bottleMaterial(color));
      mesh.position.copy(pos);
      mesh.rotation.y = Math.random() * Math.PI;
      mesh.castShadow = true;
      const collider = new THREE.Mesh(colliderGeo, bottleMaterial(color));
      collider.visible = false; // raycasts still hit invisible meshes
      collider.userData = { target: this, bottleIndex: i, surface: 'glass', noDecal: true };
      collider.name = 'bottleCollider';
      mesh.add(collider);
      this.object.add(mesh);
      return { mesh, collider, color, broken: false };
    });
    this.respawnTimer = 0;
    this.staticColliders = [];
    /** Set by TargetManager: (point, color, direction) => void */
    this.onShatter = null;
  }

  activeColliders() {
    return this.bottles.filter((b) => !b.broken).map((b) => b.collider);
  }

  get remaining() {
    return this.bottles.filter((b) => !b.broken).length;
  }

  /** Break bottle `i`. Returns false if it was already broken. */
  shatter(i, direction = null) {
    const b = this.bottles[i];
    if (!b || b.broken) return false;
    b.broken = true;
    b.mesh.visible = false;
    const center = b.mesh.localToWorld(new THREE.Vector3(0, 0.15, 0));
    this.onShatter?.(center, b.color, direction);
    if (this.remaining === 0) this.respawnTimer = RESPAWN_DELAY;
    return true;
  }

  onHit(hit, shot) {
    const i = hit.object.userData.bottleIndex;
    if (!this.shatter(i, shot.direction)) return null;
    return { type: 'bottle', zone: 'bottle', label: 'BOTTLE', base: 30, precision: 1, reaction: null };
  }

  update(dt) {
    if (this.respawnTimer <= 0) return;
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      for (const b of this.bottles) {
        b.broken = false;
        b.mesh.visible = true;
      }
    }
  }
}
