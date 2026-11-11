import * as THREE from 'three';
import { silhouetteGeometry, silhouetteMaterial, silhouetteZone } from './Duelist.js';
import { bottleGeometry, bottleMaterial, BOTTLE_COLORS } from './BottleGroup.js';
import { makeCanvas, canvasToTexture, plankTexture } from '../util/canvasTextures.js';
import { worldBox, place, merge } from '../util/geometry.js';

let wood = null;
const woodMat = () => (wood ??= new THREE.MeshStandardMaterial({ map: plankTexture('#5e3d24', 6), roughness: 0.85 }));
const iron = new THREE.MeshStandardMaterial({ color: 0x3a3836, metalness: 0.7, roughness: 0.45 });
const noRaycast = () => {};

// ---------------------------------------------------------------------------
// Running outlaw
// ---------------------------------------------------------------------------

const RUN_SPEED = 1.8; // m/s
const RUN_TURN_PAUSE = 0.4; // s at each end of the rail
const RUNNER_DOWN_TIME = 2.5; // s flat after a hit before he's back up
const RUNNER_DOWN = -Math.PI / 2 + 0.08;

/**
 * A cardboard outlaw on a trolley that runs back and forth along a rail.
 * Scored by the same zones as the pop-ups, with a moving-target bonus.
 */
export class RunnerTarget {
  /**
   * @param {THREE.Vector3} center middle of the rail on the ground
   * @param {number} halfLength rail half length (along world x)
   */
  constructor(center, halfLength = 5.5) {
    this.type = 'runner';
    this.halfLength = halfLength;
    this.speed = RUN_SPEED;
    this.object = new THREE.Group();
    this.object.name = 'runnerTarget';
    this.object.position.copy(center);

    const rail = new THREE.Mesh(merge([
      place(worldBox(halfLength * 2 + 0.6, 0.08, 0.16), 0, 0.04, 0),
      place(worldBox(0.1, 0.5, 0.1), -halfLength - 0.3, 0.25, 0),
      place(worldBox(0.1, 0.5, 0.1), halfLength + 0.3, 0.25, 0),
    ]), woodMat());
    rail.castShadow = rail.receiveShadow = true;
    rail.userData.surface = 'wood';
    this.object.add(rail);
    this.rail = rail;

    this.trolley = new THREE.Group();
    this.object.add(this.trolley);
    const cart = new THREE.Mesh(worldBox(0.6, 0.1, 0.3), iron);
    cart.position.y = 0.13;
    cart.raycast = noRaycast;
    this.trolley.add(cart);
    this.hinge = new THREE.Group();
    this.hinge.position.y = 0.18;
    this.trolley.add(this.hinge);
    this.board = new THREE.Mesh(silhouetteGeometry(), silhouetteMaterial());
    this.board.position.z = -0.01;
    this.board.castShadow = true;
    this.board.userData = { surface: 'wood', target: this };
    this.board.name = 'runnerBoard';
    this.hinge.add(this.board);

    this.staticColliders = [rail];
    this.state = 'up'; // up | falling | down | rising
    this.angle = 0;
    this.angVel = 0;
    this.downTime = 0;
    this.x = -halfLength;
    this.dir = 1;
    this.pause = 0;
    this.visible = true;
  }

  activeColliders() {
    return this.visible && this.state === 'up' ? [this.board] : [];
  }

  setVisible(v) {
    this.visible = v;
    this.object.visible = v;
  }

  onHit(hit) {
    if (!this.visible || this.state !== 'up') return null;
    const z = silhouetteZone(this.board.worldToLocal(hit.point.clone()));
    this.state = 'falling';
    this.angVel = -4 - z.precision * 3;
    return { type: 'runner', zone: z.zone, label: `RUNNER ${z.label}`, base: z.base, precision: z.precision, reaction: null, bonus: 1.5 };
  }

  update(dt) {
    if (!this.visible) return;
    // Run back and forth (he keeps sliding even when knocked flat).
    if (this.pause > 0) this.pause -= dt;
    else {
      this.x += this.dir * this.speed * dt;
      if (this.x * this.dir >= this.halfLength) { // reached the end he's running toward
        this.x = Math.sign(this.x) * this.halfLength;
        this.dir = -this.dir;
        this.pause = RUN_TURN_PAUSE;
      }
    }
    this.trolley.position.x = this.x;
    // A little bob as he "runs".
    this.board.position.y = this.state === 'up' && this.pause <= 0 ? Math.abs(Math.sin(this.x * 6)) * 0.03 : 0;

    if (this.state === 'falling') {
      this.angVel -= 16 * dt;
      this.angle += this.angVel * dt;
      if (this.angle <= RUNNER_DOWN) {
        this.angle = RUNNER_DOWN;
        this.state = 'down';
        this.downTime = 0;
      }
    } else if (this.state === 'down') {
      this.downTime += dt;
      if (this.downTime >= RUNNER_DOWN_TIME) this.state = 'rising';
    } else if (this.state === 'rising') {
      this.angle = Math.min(0, this.angle + dt * 6);
      if (this.angle === 0) this.state = 'up';
    }
    this.hinge.rotation.x = this.angle;
  }
}

// ---------------------------------------------------------------------------
// Bottle toss
// ---------------------------------------------------------------------------

const TOSS_MAX = 3;
const GRAVITY = 9.81;
let tossCollider = null;

/**
 * A wooden launcher that flings a bottle high into the air when its plate is
 * shot. Hit it mid-air for an air shot; if it lands it smashes for nothing.
 */
export class BottleToss {
  /** @param {THREE.Vector3} position launcher on the ground */
  constructor(position) {
    this.type = 'bottleToss';
    this.object = new THREE.Group();
    this.object.name = 'bottleToss';
    this.object.position.copy(position);
    const box = new THREE.Mesh(worldBox(0.5, 0.4, 0.5), woodMat());
    box.position.y = 0.2;
    box.castShadow = box.receiveShadow = true;
    box.userData.surface = 'wood';
    this.object.add(box);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.45), iron);
    arm.position.set(0, 0.43, 0);
    arm.raycast = noRaycast;
    this.object.add(arm);
    this.launcher = box;
    this.arm = arm;
    this.staticColliders = [box];

    tossCollider ??= new THREE.SphereGeometry(0.1, 8, 6);
    this.bottles = Array.from({ length: TOSS_MAX }, (_, i) => {
      const color = BOTTLE_COLORS[i % BOTTLE_COLORS.length];
      const mesh = new THREE.Mesh(bottleGeometry(), bottleMaterial(color));
      mesh.geometry.computeBoundingBox();
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.raycast = noRaycast;
      const collider = new THREE.Mesh(tossCollider, bottleMaterial(color));
      collider.visible = false; // raycasts still hit it
      collider.position.y = 0.15;
      collider.userData = { target: this, surface: 'glass', noDecal: true };
      collider.name = 'tossBottle';
      mesh.add(collider);
      return { mesh, collider, color, active: false, vel: new THREE.Vector3(), spin: new THREE.Vector3(), age: 0 };
    });
    this.armKick = 0;
    /** Set by TargetManager: (point, color, scored) => void */
    this.onShatter = null;
  }

  /** Add the bottles to the scene (they fly in world space). */
  addTo(scene) {
    for (const b of this.bottles) scene.add(b.mesh);
  }

  activeColliders() {
    return this.bottles.filter((b) => b.active).map((b) => b.collider);
  }

  get inFlight() {
    return this.bottles.filter((b) => b.active).length;
  }

  /** Fling a bottle into the air. Returns false if all are already flying. */
  launch() {
    const b = this.bottles.find((x) => !x.active);
    if (!b) return false;
    this.object.updateWorldMatrix(true, false);
    b.mesh.position.copy(this.object.localToWorld(new THREE.Vector3(0, 0.5, 0)));
    b.mesh.rotation.set(0, 0, 0);
    b.vel.set(-1.4 + Math.random() * 0.8, 6.8 + Math.random() * 1.2, -0.3 + Math.random() * 0.6);
    b.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 12);
    b.active = true;
    b.age = 0;
    b.mesh.visible = true;
    this.armKick = 1;
    return true;
  }

  #shatter(b, scored) {
    b.active = false;
    b.mesh.visible = false;
    const centre = b.mesh.localToWorld(new THREE.Vector3(0, 0.15, 0));
    this.onShatter?.(centre, b.color, scored);
  }

  onHit(hit) {
    const b = this.bottles.find((x) => x.collider === hit.object && x.active);
    if (!b) return null;
    const age = b.age;
    this.#shatter(b, true);
    return { type: 'tossBottle', zone: 'air', label: 'AIR SHOT', base: 60, precision: 1, reaction: null, bonus: 1, airTime: age };
  }

  update(dt) {
    this.armKick = Math.max(0, this.armKick - dt * 4);
    this.arm.rotation.x = -this.armKick * 1.2;
    for (const b of this.bottles) {
      if (!b.active) continue;
      b.age += dt;
      b.vel.y -= GRAVITY * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      b.mesh.rotation.z += b.spin.z * dt;
      if (b.mesh.position.y < 0.05 && b.vel.y < 0) this.#shatter(b, false); // smashed on the ground
    }
  }
}

// ---------------------------------------------------------------------------
// Swinging sign
// ---------------------------------------------------------------------------

const SIGN_W = 0.7;
const SIGN_H = 0.46;
const SIGN_CHAIN = 0.45;

/**
 * A WANTED sign with a painted bullseye, hanging on chains from a gallows. It
 * sways in the wind (two damped pendulums: toward/away and side to side) and
 * hits knock it swinging. Scored by distance from the bullseye.
 */
export class SwingingSign {
  /**
   * @param {THREE.Vector3} position ground point under the sign
   * @param {THREE.Vector3} faceTowards the firing line
   * @param {THREE.Vector3} wind shared wind vector (m/s)
   */
  constructor(position, faceTowards, wind = null) {
    this.type = 'sign';
    this.wind = wind;
    this.object = new THREE.Group();
    this.object.name = 'swingingSign';
    this.object.position.copy(position);
    this.object.rotation.y = Math.atan2(faceTowards.x - position.x, faceTowards.z - position.z);

    const pivotY = 2.3;
    const half = SIGN_W / 2 + 0.3;
    this.frameParts = [
      [new THREE.Vector3(-half, (pivotY + 0.1) / 2, 0), new THREE.Vector3(0.05, (pivotY + 0.1) / 2, 0.05)],
      [new THREE.Vector3(half, (pivotY + 0.1) / 2, 0), new THREE.Vector3(0.05, (pivotY + 0.1) / 2, 0.05)],
      [new THREE.Vector3(0, pivotY + 0.05, 0), new THREE.Vector3(half + 0.1, 0.05, 0.06)],
    ];
    const frame = new THREE.Mesh(merge(this.frameParts.map(([c, h]) => place(worldBox(h.x * 2, h.y * 2, h.z * 2), c.x, c.y, c.z))), woodMat());
    frame.castShadow = frame.receiveShadow = true;
    frame.userData.surface = 'wood';
    this.object.add(frame);

    this.pivot = new THREE.Group();
    this.pivot.position.y = pivotY;
    this.object.add(this.pivot);
    const chains = new THREE.Mesh(merge([-1, 1].map((side) =>
      place(new THREE.CylinderGeometry(0.005, 0.005, SIGN_CHAIN, 4), side * SIGN_W * 0.35, -SIGN_CHAIN / 2, 0))), iron);
    chains.raycast = noRaycast;
    this.pivot.add(chains);
    const [c, g] = makeCanvas(512, 336);
    g.fillStyle = '#d8c39a';
    g.fillRect(0, 0, 512, 336);
    g.strokeStyle = '#4a2c14';
    g.lineWidth = 10;
    g.strokeRect(8, 8, 496, 320);
    g.fillStyle = '#3b2210';
    g.font = 'bold 64px Georgia, serif';
    g.textAlign = 'center';
    g.fillText('WANTED', 256, 78);
    for (const [r, col] of [[90, '#3b2210'], [62, '#d8c39a'], [36, '#3b2210'], [14, '#b3261e']]) {
      g.fillStyle = col;
      g.beginPath();
      g.arc(256, 210, r, 0, Math.PI * 2);
      g.fill();
    }
    // One wood box plus a painted face: 2 draw calls (a 6-material box is 6).
    const board = new THREE.Mesh(worldBox(SIGN_W, SIGN_H, 0.03), woodMat());
    board.position.y = -SIGN_CHAIN - SIGN_H / 2;
    board.castShadow = true;
    board.userData = { surface: 'wood', target: this };
    board.name = 'signBoard';
    this.pivot.add(board);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(SIGN_W * 0.96, SIGN_H * 0.94),
      new THREE.MeshStandardMaterial({ map: canvasToTexture(c, { repeat: false }), roughness: 0.9 }));
    face.position.z = 0.016;
    face.raycast = noRaycast;
    board.add(face);
    this.board = board;
    // The bullseye in board coordinates (canvas y 210 of 336, centred x).
    this.bull = new THREE.Vector2(0, SIGN_H / 2 - (210 / 336) * SIGN_H);
    this.bullR = (90 / 512) * SIGN_W; // outer painted ring, metres

    this.staticColliders = [frame];
    this.swing = 0; // toward / away
    this.swingVel = 0;
    this.sway = 0; // side to side
    this.swayVel = 0;
    this.length = SIGN_CHAIN + SIGN_H / 2;
    this.time = Math.random() * 10;
  }

  activeColliders() {
    return [this.board];
  }

  onHit(hit, shot) {
    const p = this.board.worldToLocal(hit.point.clone());
    const d = Math.hypot(p.x - this.bull.x, p.y - this.bull.y);
    const precision = Math.max(0, 1 - d / (this.bullR * 1.6));
    const inv = this.object.matrixWorld.clone().invert();
    const local = shot.direction.clone().transformDirection(inv);
    this.swingVel += -local.z * 2.2;
    this.swayVel += (Math.random() - 0.5) * 1.2;
    const zone = d < this.bullR * 0.2 ? 'bull' : d < this.bullR ? 'rings' : 'board';
    return { type: 'sign', zone, label: zone === 'bull' ? 'WANTED: BULLSEYE' : 'WANTED SIGN', base: 45, precision, reaction: null, bonus: 1.25 };
  }

  update(dt) {
    this.time += dt;
    // Wind in the sign's frame pushes it; gusts make it lively.
    let push = 0;
    let side = 0;
    if (this.wind) {
      const w = this.wind.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -this.object.rotation.y);
      push = -w.z * 0.6;
      side = w.x * 0.6;
    }
    const k = 9.81 / this.length;
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.swingVel += (-k * Math.sin(this.swing) - 0.5 * this.swingVel + push * (1 + 0.5 * Math.sin(this.time * 1.3))) * h;
      this.swing += this.swingVel * h;
      this.swayVel += (-k * Math.sin(this.sway) - 0.5 * this.swayVel + side * (1 + 0.5 * Math.sin(this.time * 0.9 + 1))) * h;
      this.sway += this.swayVel * h;
    }
    this.pivot.rotation.set(this.swing, 0, this.sway);
  }
}
