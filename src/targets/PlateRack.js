import * as THREE from 'three';
import { plankTexture } from '../util/canvasTextures.js';
import { worldBox, place, merge } from '../util/geometry.js';

const PLATE_R = 0.1;
const HINGE_Y = 0.95;
const DOWN = -Math.PI / 2 + 0.08;
const RESET_DELAY = 1.6; // s after the last plate falls

let woodMaterial = null;
const steel = new THREE.MeshStandardMaterial({ color: 0xd9d3c6, metalness: 0.35, roughness: 0.5 });

/**
 * Knock-down steel plate rack: a row of round plates hinged at the bottom on a
 * wooden rack. A hit rings the plate and knocks it flat; when the whole row is
 * down it springs back up.
 */
export class PlateRack {
  /**
   * @param {THREE.Vector3} position centre of the rack on the ground
   * @param {THREE.Vector3} faceTowards the firing line
   * @param {number} count
   */
  constructor(position, faceTowards, count = 5, spacing = 0.32) {
    this.type = 'plateRack';
    this.object = new THREE.Group();
    this.object.name = 'plateRack';
    this.object.position.copy(position);
    this.object.rotation.y = Math.atan2(faceTowards.x - position.x, faceTowards.z - position.z);

    const half = ((count - 1) * spacing) / 2 + 0.2;
    woodMaterial ??= new THREE.MeshStandardMaterial({ map: plankTexture('#5e3d24', 6), roughness: 0.85 });
    this.frameParts = [
      [new THREE.Vector3(-half, HINGE_Y / 2, 0), new THREE.Vector3(0.04, HINGE_Y / 2, 0.04)],
      [new THREE.Vector3(half, HINGE_Y / 2, 0), new THREE.Vector3(0.04, HINGE_Y / 2, 0.04)],
      [new THREE.Vector3(0, HINGE_Y - 0.03, 0), new THREE.Vector3(half, 0.03, 0.05)],
    ];
    const frame = new THREE.Mesh(merge(this.frameParts.map(([c, h]) => place(worldBox(h.x * 2, h.y * 2, h.z * 2), c.x, c.y, c.z))), woodMaterial);
    frame.castShadow = frame.receiveShadow = true;
    frame.userData.surface = 'wood';
    this.object.add(frame);
    this.frame = frame;

    const geo = new THREE.CylinderGeometry(PLATE_R, PLATE_R, 0.012, 24).rotateX(Math.PI / 2).translate(0, PLATE_R + 0.02, 0);
    this.plates = Array.from({ length: count }, (_, i) => {
      const hinge = new THREE.Group();
      hinge.position.set(-((count - 1) * spacing) / 2 + i * spacing, HINGE_Y, 0.06);
      const mesh = new THREE.Mesh(geo, steel);
      mesh.castShadow = true;
      mesh.userData = { surface: 'steel', target: this, plateIndex: i };
      mesh.name = 'rackPlate';
      hinge.add(mesh);
      this.object.add(hinge);
      return { hinge, mesh, state: 'up', angle: 0, angVel: 0 };
    });
    this.resetTimer = 0;
    this.staticColliders = [frame];
    /** Set by TargetManager: (plate world position) => void, when plates spring back. */
    this.onReset = null;
  }

  activeColliders() {
    return this.plates.filter((p) => p.state === 'up').map((p) => p.mesh);
  }

  get standing() {
    return this.plates.filter((p) => p.state === 'up').length;
  }

  /** Knock plate `i` down (bullet or thrown gun). Returns false if it was already down. */
  knock(i, strength = 1) {
    const p = this.plates[i];
    if (!p || p.state !== 'up') return false;
    p.state = 'falling';
    p.angVel = -3 - strength * 3;
    if (this.standing === 0) this.resetTimer = RESET_DELAY;
    return true;
  }

  onHit(hit) {
    const i = hit.object.userData.plateIndex;
    const p = this.plates[i];
    if (!p || p.state !== 'up') return null;
    const local = p.mesh.worldToLocal(hit.point.clone());
    const d = Math.min(1, Math.hypot(local.x, local.y - (PLATE_R + 0.02)) / PLATE_R);
    const precision = 1 - d;
    this.knock(i, precision);
    return { type: 'plate', zone: d < 0.35 ? 'center' : 'plate', label: d < 0.35 ? 'CENTER PLATE' : 'PLATE', base: 40, precision, reaction: null };
  }

  update(dt) {
    for (const p of this.plates) {
      if (p.state === 'falling') {
        p.angVel -= 16 * dt;
        p.angle += p.angVel * dt;
        if (p.angle <= DOWN) {
          p.angle = DOWN;
          if (Math.abs(p.angVel) > 1.5) p.angVel = -p.angVel * 0.2;
          else { p.angVel = 0; p.state = 'down'; }
        }
      } else if (p.state === 'rising') {
        p.angle = Math.min(0, p.angle + dt * 9);
        if (p.angle === 0) p.state = 'up';
      }
      p.hinge.rotation.x = p.angle;
    }
    if (this.resetTimer > 0) {
      this.resetTimer -= dt;
      if (this.resetTimer <= 0) {
        for (const p of this.plates) p.state = 'rising';
        this.onReset?.(this.object.getWorldPosition(new THREE.Vector3()));
      }
    }
  }
}
