import * as THREE from 'three';
import { BUTTON } from '../xr/XRManager.js';
import { traceBullet, dropAt } from './ballistics.js';
import { worldBox, place, merge } from '../util/geometry.js';

/**
 * Lever-action rifle, kept on a rack beside the bench.
 *
 *  - Grab it from the rack with either hand's grip. Squeeze the other hand's
 *    grip near the wooden fore-end to hold it two-handed: it then points
 *    along the line from your back hand to your front hand.
 *  - Trigger fires the chambered round. Work the lever (A / X) to eject the
 *    case and chamber the next one: no lever, no shot (a dry click).
 *  - 10 in the magazine plus 1 in the chamber; it reloads when it goes back on
 *    the rack. Let go and it returns to the rack.
 *  - 400 m/s with gravity drop; buckhorn sights zeroed at SIGHT_ZERO metres.
 */
export const RifleState = Object.freeze({ RACKED: 'racked', HELD: 'held', RETURNING: 'returning' });

export const MUZZLE_VELOCITY = 400; // m/s
const MAX_RANGE = 250;
const MAGAZINE = 10;
const GRAB_RADIUS = 0.25;
const SUPPORT_RADIUS = 0.18; // off hand -> fore-end
const LEVER_TIME = 0.35; // s for a full lever stroke
const RETURN_TIME = 0.4;
const SA_BREAK = 0.55;
const TRIGGER_RESET = 0.25;

const BORE_Y = 0.045;
const MUZZLE_Z = -0.76;
const FORE_END = new THREE.Vector3(0, 0.03, -0.38); // where the support hand goes
const SIGHT_ZERO = 25; // metres
const REAR_SIGHT = { y: BORE_Y + 0.019, z: -0.16 };
const FRONT_SIGHT_Z = -0.73;
const ZERO_Y = BORE_Y - dropAt(SIGHT_ZERO, MUZZLE_VELOCITY);
const FRONT_SIGHT_Y = REAR_SIGHT.y + ((ZERO_Y - REAR_SIGHT.y) * (REAR_SIGHT.z - FRONT_SIGHT_Z)) / (REAR_SIGHT.z + SIGHT_ZERO);

// Recoil spring on the model (heavier, slower kick than the revolver).
const RECOIL_K = 220;
const RECOIL_C = 24;
const RECOIL_SUBSTEP = 1 / 240;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class Rifle extends THREE.EventDispatcher {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {import('../xr/XRManager.js').XRManager} deps.xr
   * @param {import('../audio/SoundFX.js').SoundFX} deps.sfx
   * @param {import('../fx/ImpactFX.js').ImpactFX} deps.impacts
   * @param {import('../fx/ParticleFX.js').ParticleFX} [deps.fx]
   * @param {import('../fx/CasingFX.js').CasingFX} [deps.casings]
   * @param {() => THREE.Object3D[]} deps.getColliders
   */
  constructor({ scene, xr, sfx, impacts, fx = null, casings = null, getColliders }, rackPosition = new THREE.Vector3(1.1, 0, -0.45)) {
    super();
    Object.assign(this, { scene, xr, sfx, impacts, fx, casings, getColliders });
    this.raycaster = new THREE.Raycaster();
    this.enabled = true;

    this.object = new THREE.Group();
    this.object.name = 'rifle';
    this.recoilPivot = new THREE.Group();
    this.object.add(this.recoilPivot);
    this.#buildModel();
    this.#buildRack(rackPosition);
    this.rackSocket.add(this.object);

    this.state = RifleState.RACKED;
    this.hand = null;
    this.support = null; // the steadying hand, if any
    this.magazine = MAGAZINE;
    this.chamber = 'live'; // 'live' | 'spent' | 'empty'
    this.leverT = 0; // 0..1 through a lever stroke
    this.levering = false;
    this.triggerArmed = true;
    this.recoil = { ang: 0, angVel: 0, z: 0, zVel: 0 };
    this.tween = null;

    xr.addEventListener('squeezestart', ({ hand }) => this.#onSqueezeStart(hand));
    xr.addEventListener('squeezeend', ({ hand }) => this.#onSqueezeEnd(hand));
  }

  // -------------------------------------------------------------------------
  // Model and rack
  // -------------------------------------------------------------------------
  #buildModel() {
    const walnut = new THREE.MeshStandardMaterial({ color: 0x6b3a1c, roughness: 0.55 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.85, roughness: 0.35 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.9, roughness: 0.3 });
    // Parts merged per material: 3 meshes (+ the lever), not ~14 draw calls.
    const parts = { walnut: [], brass: [], steel: [] };
    const part = (mat, geo, x, y, z, rx = 0) => parts[mat].push(place(geo, x, y, z, rx));
    // Butt stock (behind the hand, against the shoulder) and wrist.
    part('walnut', new THREE.BoxGeometry(0.035, 0.05, 0.12), 0, -0.005, 0.04);
    part('walnut', new THREE.BoxGeometry(0.04, 0.11, 0.2), 0, -0.04, 0.2, 0.18);
    // Brass receiver, steel barrel and magazine tube, wooden fore-end.
    part('brass', new THREE.BoxGeometry(0.032, 0.06, 0.15), 0, 0.02, -0.08);
    part('steel', new THREE.CylinderGeometry(0.009, 0.01, 0.6, 12).rotateX(Math.PI / 2), 0, BORE_Y, -0.455);
    part('steel', new THREE.CylinderGeometry(0.0075, 0.0075, 0.5, 10).rotateX(Math.PI / 2), 0, BORE_Y - 0.02, -0.41);
    part('walnut', new THREE.BoxGeometry(0.034, 0.034, 0.26), 0, BORE_Y - 0.016, -0.3);
    // Sights: buckhorn rear notch, front blade with a brass bead.
    for (const side of [-1, 1]) part('steel', new THREE.BoxGeometry(0.006, 0.012, 0.004), side * 0.006, REAR_SIGHT.y + 0.004, REAR_SIGHT.z);
    part('steel', new THREE.BoxGeometry(0.018, 0.004, 0.004), 0, REAR_SIGHT.y - 0.002, REAR_SIGHT.z);
    const bladeH = FRONT_SIGHT_Y - (BORE_Y + 0.009) + 0.001;
    part('steel', new THREE.BoxGeometry(0.0025, bladeH, 0.008), 0, FRONT_SIGHT_Y - bladeH / 2, FRONT_SIGHT_Z);
    part('brass', new THREE.SphereGeometry(0.0013, 8, 6), 0, FRONT_SIGHT_Y - 0.0016, FRONT_SIGHT_Z + 0.004);
    const mats = { walnut, brass, steel };
    const add = (geo, mat, parent = this.recoilPivot) => {
      const m = new THREE.Mesh(geo, mat); // small: no shadow pass
      m.raycast = () => {};
      parent.add(m);
      return m;
    };
    for (const [name, geos] of Object.entries(parts)) add(merge(geos), mats[name]);
    // Lever loop, pivoting under the front of the receiver.
    this.lever = new THREE.Group();
    this.lever.position.set(0, -0.012, -0.14);
    this.recoilPivot.add(this.lever);
    add(merge([
      place(new THREE.BoxGeometry(0.008, 0.008, 0.13), 0, -0.004, 0.065),
      place(new THREE.TorusGeometry(0.03, 0.004, 6, 12, Math.PI), 0, -0.03, 0.1, 0, Math.PI / 2, 0),
    ]), steel, this.lever);
    // Muzzle and the points the sights / support hand use.
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, BORE_Y, MUZZLE_Z);
    this.sightRear = new THREE.Object3D();
    this.sightRear.position.set(0, REAR_SIGHT.y, REAR_SIGHT.z);
    this.sightFront = new THREE.Object3D();
    this.sightFront.position.set(0, FRONT_SIGHT_Y, FRONT_SIGHT_Z);
    this.foreEnd = new THREE.Object3D();
    this.foreEnd.position.copy(FORE_END);
    this.ejection = new THREE.Object3D();
    this.ejection.position.set(0.02, 0.05, -0.08);
    this.recoilPivot.add(this.muzzle, this.sightRear, this.sightFront, this.foreEnd, this.ejection);
  }

  #buildRack(position) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.9 });
    // Waist-high: two forked posts the rifle lies across, barrel downrange.
    const rack = new THREE.Mesh(merge([
      place(worldBox(0.05, 0.98, 0.05), 0, 0.49, 0.06),
      place(worldBox(0.05, 0.98, 0.05), 0, 0.49, -0.46),
      ...[0.06, -0.46].flatMap((z) => [
        place(worldBox(0.012, 0.06, 0.012), -0.025, 1.0, z),
        place(worldBox(0.012, 0.06, 0.012), 0.025, 1.0, z),
      ]),
      place(worldBox(0.08, 0.04, 0.6), 0, 0.02, -0.2),
    ]), wood);
    rack.position.copy(position);
    rack.castShadow = rack.receiveShadow = true;
    rack.userData.surface = 'wood';
    rack.name = 'rifleRack';
    this.scene.add(rack);
    this.rack = rack;
    // The rifle lies in the forks, grip at hand height.
    this.rackSocket = new THREE.Object3D();
    this.rackSocket.position.set(0, 1.0, 0.04);
    rack.add(this.rackSocket);
    this.colliders = [rack];
  }

  // -------------------------------------------------------------------------
  // Holding
  // -------------------------------------------------------------------------
  get isHeld() {
    return this.state === RifleState.HELD;
  }

  get rounds() {
    return this.magazine + (this.chamber === 'live' ? 1 : 0);
  }

  #onSqueezeStart(hand) {
    if (!this.enabled || hand.held) return;
    if (this.isHeld && hand !== this.hand) {
      // The other hand on the fore-end steadies it.
      if (this.foreEnd.getWorldPosition(_v).distanceTo(hand.position) < SUPPORT_RADIUS) {
        this.support = hand;
        hand.held = { type: 'rifleSupport', rifle: this };
        this.xr.pulse(hand, 0.2, 20);
        this.dispatchEvent({ type: 'support', hand });
      }
      return;
    }
    if (this.isHeld) return;
    this.object.updateWorldMatrix(true, false);
    if (this.object.getWorldPosition(_v).distanceTo(hand.position) > GRAB_RADIUS) return;
    this.grab(hand);
  }

  #onSqueezeEnd(hand) {
    if (hand === this.support) this.#dropSupport();
    else if (hand === this.hand) this.release();
  }

  #dropSupport() {
    if (!this.support) return;
    if (this.support.held?.type === 'rifleSupport') this.support.held = null;
    this.support = null;
    this.#alignToHand();
  }

  grab(hand) {
    this.hand = hand;
    hand.held = this;
    this.state = RifleState.HELD;
    this.tween = null;
    this.triggerArmed = hand.values[BUTTON.TRIGGER] < TRIGGER_RESET;
    hand.grip.attach(this.object);
    this.#alignToHand(true);
    this.sfx.holster();
    this.xr.pulse(hand, 0.3, 30);
    this.dispatchEvent({ type: 'grab', hand });
  }

  /** One-handed: barrel along the controller's pointing ray (as with the revolver). */
  #alignToHand(tween = false) {
    const hand = this.hand;
    if (!hand) return;
    hand.grip.updateWorldMatrix(true, false);
    hand.controller.updateWorldMatrix(true, false);
    hand.grip.getWorldQuaternion(_q).invert();
    hand.controller.getWorldQuaternion(_q2);
    const target = _q.multiply(_q2).clone();
    if (tween) this.tween = { t: 0, dur: 0.1, fromPos: this.object.position.clone(), fromQuat: this.object.quaternion.clone(), toPos: new THREE.Vector3(), toQuat: target };
    else {
      this.object.position.set(0, 0, 0);
      this.object.quaternion.copy(target);
    }
  }

  /** Let go: back to the rack (and reloaded there). */
  release() {
    this.#dropSupport();
    if (this.hand) this.hand.held = null;
    this.hand = null;
    this.state = RifleState.RETURNING;
    this.rackSocket.attach(this.object);
    this.tween = {
      t: 0, dur: RETURN_TIME, fromPos: this.object.position.clone(), fromQuat: this.object.quaternion.clone(),
      toPos: new THREE.Vector3(), toQuat: new THREE.Quaternion(),
      onDone: () => {
        this.state = RifleState.RACKED;
        this.magazine = MAGAZINE;
        this.chamber = 'live';
        this.sfx.holster();
        this.dispatchEvent({ type: 'racked' });
      },
    };
  }

  /** Put it straight back on the rack (no animation). */
  stow() {
    if (this.isHeld || this.state === RifleState.RETURNING) {
      this.#dropSupport();
      if (this.hand) this.hand.held = null;
      this.hand = null;
      this.tween = null;
      this.rackSocket.add(this.object);
      this.object.position.set(0, 0, 0);
      this.object.quaternion.identity();
      this.state = RifleState.RACKED;
    }
  }

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------
  /** Work the lever: eject what's in the chamber, feed the next round. */
  workLever() {
    if (!this.isHeld || this.levering) return false;
    this.levering = true;
    this.leverT = 0;
    this.sfx.leverAction();
    this.xr.pulse(this.hand, 0.25, 30);
    if (this.chamber !== 'empty') {
      this.ejection.updateWorldMatrix(true, false);
      const pos = this.ejection.getWorldPosition(new THREE.Vector3());
      const q = this.object.getWorldQuaternion(new THREE.Quaternion());
      const vel = new THREE.Vector3(1.2, 1.4, 0.3).applyQuaternion(q).add(this.hand.velocity);
      this.casings?.eject(pos, q, vel);
    }
    this.chamber = this.magazine > 0 ? 'live' : 'empty';
    if (this.magazine > 0) this.magazine--;
    this.dispatchEvent({ type: 'lever', rounds: this.rounds });
    return true;
  }

  #fire() {
    if (this.chamber !== 'live') {
      this.sfx.dryFire();
      this.xr.pulse(this.hand, 0.15, 15);
      this.dispatchEvent({ type: 'dryfire' });
      return;
    }
    this.chamber = 'spent';
    this.muzzle.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(this.muzzle.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(this.muzzle.matrixWorld);
    const hit = traceBullet(this.raycaster, this.getColliders(), origin, direction, MUZZLE_VELOCITY, MAX_RANGE);
    if (hit) this.impacts.spawn(hit);
    this.fx?.muzzle(origin, direction);
    this.recoil.angVel += 5.5;
    this.recoil.zVel += 0.5;
    this.sfx.gunshot(origin);
    this.xr.pulse(this.hand, 1, 110);
    if (this.support) this.xr.pulse(this.support, 0.6, 80);
    this.dispatchEvent({ type: 'shot', origin, direction, hit, weapon: 'rifle' });
  }

  #processInput() {
    const hand = this.hand;
    const trig = hand.values[BUTTON.TRIGGER];
    if (trig < TRIGGER_RESET) this.triggerArmed = true;
    if (hand.justPressed[BUTTON.PRIMARY] || hand.justPressed[BUTTON.SECONDARY]) this.workLever();
    if (this.triggerArmed && trig >= SA_BREAK && !this.levering) {
      this.triggerArmed = false;
      this.#fire();
    }
  }

  /** Two-handed: point from the back hand to the front hand. */
  #aimTwoHanded() {
    const grip = this.hand.position;
    const front = this.support.position;
    const fwd = _v.subVectors(front, grip);
    if (fwd.lengthSq() < 1e-4) return;
    fwd.normalize();
    this.hand.controller.updateWorldMatrix(true, false);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.hand.controller.getWorldQuaternion(_q2));
    // Barrel is -Z: Matrix4.lookAt points -Z from eye to target.
    _m.lookAt(new THREE.Vector3(), fwd, up);
    const world = new THREE.Quaternion().setFromRotationMatrix(_m);
    this.hand.grip.getWorldQuaternion(_q).invert();
    this.object.quaternion.copy(_q.multiply(world));
    this.object.position.set(0, 0, 0);
  }

  update(dt) {
    const tw = this.tween;
    if (tw) {
      tw.t = Math.min(tw.dur, tw.t + dt);
      const k = 1 - Math.pow(1 - tw.t / tw.dur, 3);
      this.object.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.object.quaternion.slerpQuaternions(tw.fromQuat, tw.toQuat, k);
      if (tw.t >= tw.dur) {
        this.tween = null;
        tw.onDone?.();
      }
    }
    if (this.isHeld && this.hand) {
      if (this.support && !this.tween) this.#aimTwoHanded();
      this.#processInput();
    }
    // Lever stroke: down and back up.
    if (this.levering) {
      this.leverT = Math.min(1, this.leverT + dt / LEVER_TIME);
      if (this.leverT >= 1) this.levering = false;
    }
    this.lever.rotation.x = -Math.sin(this.leverT * Math.PI) * 0.9;
    // Recoil spring.
    const r = this.recoil;
    const steps = Math.ceil(dt / RECOIL_SUBSTEP);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      r.angVel += (-RECOIL_K * r.ang - RECOIL_C * r.angVel) * h;
      r.ang += r.angVel * h;
      r.zVel += (-RECOIL_K * r.z - RECOIL_C * r.zVel) * h;
      r.z += r.zVel * h;
    }
    this.recoilPivot.rotation.x = r.ang;
    this.recoilPivot.position.z = r.z;
  }
}
