import * as THREE from 'three';

/**
 * Owns all targets (pop-up duelists, steel gongs, glass bottles), their hit
 * zones, reactions and the score.
 *
 * Pass 1 provides only the state shape and the update hook main.js calls.
 * Targets, hit logic and the in-world score board arrive in Pass 3.
 */
export class TargetManager {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'targets';
    scene.add(this.root);

    this.targets = [];
    this.score = { points: 0, shots: 0, hits: 0 };
  }

  /** Meshes the ballistics raycast should test against. */
  get colliders() {
    return this.root.children;
  }

  // eslint-disable-next-line no-unused-vars
  update(dt) {}
}
