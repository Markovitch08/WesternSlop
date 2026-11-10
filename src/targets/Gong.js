import * as THREE from 'three';
import { plankTexture } from '../util/canvasTextures.js';
import { worldBox, place, merge } from '../util/geometry.js';

const GRAVITY = 9.81;
const CHAIN = 0.5; // chain length, metres
const PLATE_CENTER_Y = 1.4;

let woodMaterial = null;
const steelMaterial = new THREE.MeshStandardMaterial({ color: 0xe6e1d6, metalness: 0.35, roughness: 0.55 });
const chainMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3836, metalness: 0.8, roughness: 0.4 });

/**
 * Painted steel plate hanging from chains on a wooden gallows. Rings when hit
 * (smaller plates ring higher) and swings as a damped pendulum, twisting for
 * off-centre hits.
 */
export class Gong {
  /**
   * @param {THREE.Vector3} position ground point under the plate
   * @param {number} radius plate radius in metres
   * @param {THREE.Vector3} faceTowards the firing line
   */
  constructor(position, radius, faceTowards) {
    this.type = 'gong';
    this.radius = radius;
    this.object = new THREE.Group();
    this.object.name = 'gong';
    this.object.position.copy(position);
    this.object.rotation.y = Math.atan2(faceTowards.x - position.x, faceTowards.z - position.z);

    const pivotY = PLATE_CENTER_Y + radius + CHAIN;
    const halfSpan = radius + 0.35;
    woodMaterial ??= new THREE.MeshStandardMaterial({ map: plankTexture('#5e3d24', 6), roughness: 0.85 });
    // Frame parts as [centre, half extents] in local space (also used for physics).
    this.frameParts = [
      [new THREE.Vector3(-halfSpan, (pivotY + 0.1) / 2, 0), new THREE.Vector3(0.05, (pivotY + 0.1) / 2, 0.05)],
      [new THREE.Vector3(halfSpan, (pivotY + 0.1) / 2, 0), new THREE.Vector3(0.05, (pivotY + 0.1) / 2, 0.05)],
      [new THREE.Vector3(0, pivotY + 0.05, 0), new THREE.Vector3(halfSpan + 0.1, 0.05, 0.06)],
    ];
    const frame = new THREE.Mesh(merge(this.frameParts.map(([c, h]) => place(worldBox(h.x * 2, h.y * 2, h.z * 2), c.x, c.y, c.z))), woodMaterial);
    frame.castShadow = frame.receiveShadow = true;
    frame.userData.surface = 'wood';
    this.object.add(frame);

    this.pivot = new THREE.Group();
    this.pivot.position.y = pivotY;
    this.object.add(this.pivot);

    const plateGeo = new THREE.CylinderGeometry(radius, radius, 0.016, 32);
    plateGeo.rotateX(Math.PI / 2); // face +Z; local x/y are plate-face coordinates
    this.plate = new THREE.Mesh(plateGeo, steelMaterial);
    this.plate.position.y = -(CHAIN + radius);
    this.plate.castShadow = true;
    this.plate.userData.surface = 'steel';
    this.plate.userData.target = this;
    this.plate.name = 'gongPlate';
    this.pivot.add(this.plate);

    const chainLen = CHAIN + radius * (1 - Math.cos(Math.PI / 6));
    for (const side of [-1, 1]) {
      const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, chainLen, 5), chainMaterial);
      chain.position.set(side * radius * 0.5, -chainLen / 2, 0);
      chain.raycast = () => {}; // too thin to matter; avoids eating plate shots
      this.pivot.add(chain);
    }

    this.staticColliders = [frame];
    this.swing = 0; // rad, about local X (away from shooter is positive)
    this.swingVel = 0;
    this.twist = 0; // rad, about local Y
    this.twistVel = 0;
    this.length = CHAIN + radius;
  }

  activeColliders() {
    return [this.plate];
  }

  /** Knocked by something other than a bullet (a thrown revolver). */
  bump(speed) {
    this.swingVel += speed * 0.6;
    this.twistVel += (Math.random() - 0.5) * speed;
  }

  onHit(hit, shot) {
    const p = this.plate.worldToLocal(hit.point.clone());
    const d = Math.min(1, Math.hypot(p.x, p.y) / this.radius);
    const precision = 1 - d;
    let zone, label;
    if (d < 0.3) { zone = 'center'; label = 'CENTER RING'; }
    else if (d < 0.65) { zone = 'inner'; label = 'STEEL'; }
    else { zone = 'edge'; label = 'EDGE'; }

    // Momentum from the bullet: push along the plate's facing, twist off-centre.
    const localDir = shot.direction.clone().transformDirection(this.object.matrixWorld.clone().invert());
    this.swingVel += -localDir.z * 2.4;
    this.twistVel += (-p.x / this.radius) * 3.5;
    return { type: 'gong', zone, label, base: 50, precision, reaction: null };
  }

  update(dt) {
    // Substep for stability with large hits at 72 Hz.
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.swingVel += (-(GRAVITY / this.length) * Math.sin(this.swing) - 0.7 * this.swingVel) * h;
      this.swing += this.swingVel * h;
      this.twistVel += (-9 * this.twist - 1.2 * this.twistVel) * h;
      this.twist += this.twistVel * h;
    }
    this.pivot.rotation.set(this.swing, this.twist, 0);
  }
}
