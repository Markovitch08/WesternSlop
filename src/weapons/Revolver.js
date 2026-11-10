import * as THREE from 'three';
import { BUTTON } from '../xr/XRManager.js';
import { CANNON } from '../physics/PhysicsWorld.js';

/**
 * Single-action-army-style six-shooter.
 *
 * Coordinate frame of `object` (the grip origin, which sits in the palm):
 *   -Z is the bore direction, +Y is up, and the handle rakes down and back (+Z).
 *
 * Hammer & trigger:
 *   - Cock the hammer with A/B (or X/Y), by pulling the thumbstick back, or by
 *     fanning: swipe the free hand fast across the hammer spur. Cocking
 *     rotates the next chamber under the hammer.
 *   - Cocked: a light trigger pull (SA_BREAK) drops the hammer.
 *   - Uncocked: a full, heavy pull (DA_BREAK) raises the hammer with the
 *     trigger and fires at the break point (double action).
 *   - Fanning with the trigger held fires the moment the hammer is slapped.
 *
 * Holding: the gun stays in your hand only while the grip button is held.
 *   - Let go at the hip and it slides into the holster. Until reloading arrives
 *     in Pass 4, holstering refills the cylinder.
 *   - Let go anywhere else and it becomes a rigid body: it is thrown with your
 *     hand's velocity and spin, falls, clatters off the ground and props, and
 *     can break bottles, ring gongs and knock over duelists. Pick it up again
 *     with the grip button near it.
 *   - Click a thumbstick to recall a dropped gun to the holster. A gun that
 *     leaves the play area returns on its own.
 *
 * Sights: a rear notch on the top strap and a front blade with a brass bead.
 * The sight line sits above the bore and is angled to cross the bullet path at
 * SIGHT_ZERO metres, so a sight picture on the target at that range is a hit
 * on the point of aim (about 2 cm low up close, about 1 cm high at 25 m).
 */
export const RevolverState = Object.freeze({
  HOLSTERED: 'holstered',
  HELD: 'held',
  HOLSTERING: 'holstering',
  DROPPED: 'dropped',
  CYLINDER_OPEN: 'cylinder_open', // Pass 4
});

const GRAB_RADIUS = 0.2; // metres, hand -> grip origin
const SNAP_TIME = 0.08; // seconds to snap into the hand
const HOLSTER_TIME = 0.18; // seconds to slide into the holster
const HOLSTER_RADIUS = 0.22; // release this close to the holster to holster it
const RECALL_TIME = 0.35; // seconds for a recalled gun to fly back
const PLAY_AREA = { minY: -2, radius: 60 }; // outside this a dropped gun returns

// Rigid body. Mass ~1.1 kg; collision shapes approximate frame+barrel and grip.
const GUN_MASS = 1.1;
const CLATTER_MIN_SPEED = 0.5; // m/s impact speed for a clatter sound
const CLATTER_COOLDOWN = 0.08; // s

// Sights (gun-local metres). See the class comment.
const BORE_Y = 0.06;
const SIGHT_ZERO = 15; // metres
const REAR_SIGHT = { y: 0.0815, z: -0.012 }; // bottom of the rear notch
const FRONT_SIGHT_Z = -0.196;
/** Top of the front blade: on the line from the rear notch to the bore at SIGHT_ZERO. */
const FRONT_SIGHT_Y = REAR_SIGHT.y + ((BORE_Y - REAR_SIGHT.y) * (REAR_SIGHT.z - FRONT_SIGHT_Z)) / (REAR_SIGHT.z + SIGHT_ZERO);
const BARREL_R = 0.0085;

const SA_BREAK = 0.55; // trigger value that fires a cocked hammer
const DA_BREAK = 0.97; // trigger value that fires double action
const TRIGGER_RESET = 0.25; // trigger must drop below this to re-arm
const STICK_COCK = 0.7; // thumbstick pull-back that cocks

const HAMMER_COCKED_ANGLE = 0.6; // rad
const TRIGGER_PULL_ANGLE = -0.35; // rad
const CHAMBER_STEP = Math.PI / 3;

const FAN_RADIUS = 0.1; // metres, free hand -> hammer spur
const FAN_SPEED = 1.0; // m/s
const FAN_COOLDOWN = 0.15; // s

// Recoil: damped spring on the model inside the grip frame.
const RECOIL_K = 320;
const RECOIL_C = 26;
const RECOIL_KICK_ANG = 9; // rad/s impulse, muzzle up
const RECOIL_KICK_Z = 0.55; // m/s impulse, backwards
const RECOIL_SUBSTEP = 1 / 240;

const MUZZLE_VELOCITY_RANGE = 200; // metres; ballistic drop comes in Pass 4
const FLASH_TIME = 0.05;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class Revolver extends THREE.EventDispatcher {
  /**
   * @param {object} deps
   * @param {import('../xr/XRManager.js').XRManager} deps.xr
   * @param {import('./Holster.js').Holster} deps.holster
   * @param {import('../audio/SoundFX.js').SoundFX} deps.sfx
   * @param {import('../fx/ImpactFX.js').ImpactFX} deps.impacts
   * @param {() => THREE.Object3D[]} deps.getColliders
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} deps.physics
   * @param {THREE.Scene} deps.scene
   */
  constructor({ xr, holster, sfx, impacts, getColliders, physics, scene }) {
    super();
    this.xr = xr;
    this.physics = physics;
    this.scene = scene;
    this.holster = holster;
    this.sfx = sfx;
    this.impacts = impacts;
    this.getColliders = getColliders;
    this.raycaster = new THREE.Raycaster();

    this.object = new THREE.Group();
    this.object.name = 'revolver';
    this.#buildModel();

    this.state = RevolverState.HOLSTERED;
    /** @type {import('../xr/XRManager.js').Hand|null} */
    this.hand = null;

    /** Six chambers: 'live' | 'spent' | 'empty'. */
    this.chambers = new Array(6).fill('live');
    /** Chamber under the hammer. Starts on 5 so the first cock brings up 0. */
    this.chamberIndex = 5;
    this.cocked = false;
    this.triggerArmed = true;

    this.hammerAngle = 0;
    this.cylinderAngle = 0;
    this.cylinderTarget = 0;
    this.recoil = { ang: 0, angVel: 0, z: 0, zVel: 0 };
    this.flashTimer = 0;
    this.fanCooldown = 0;
    this.stickWasBack = false;

    this.tween = null; // { t, dur, toPos, toQuat, onDone }
    this.clatterCooldown = 0;

    this.body = this.#buildBody();

    holster.socket.add(this.object);

    xr.addEventListener('squeezestart', ({ hand }) => this.#onSqueezeStart(hand));
    xr.addEventListener('squeezeend', ({ hand }) => this.#onSqueezeEnd(hand));
  }

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------
  #buildModel() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.85, roughness: 0.35 });
    const caseHard = new THREE.MeshStandardMaterial({ color: 0x5a5048, metalness: 0.8, roughness: 0.4 });
    const walnut = new THREE.MeshStandardMaterial({ color: 0x5a3018, metalness: 0, roughness: 0.6 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x050505 });

    const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // Everything visual hangs off recoilPivot so recoil never moves the grip
    // origin (the hand) itself.
    this.recoilPivot = new THREE.Group();
    this.object.add(this.recoilPivot);
    const root = this.recoilPivot;

    // Frame
    mesh(new THREE.BoxGeometry(0.026, 0.045, 0.085), caseHard, root, 0, 0.045, -0.025);
    // Top strap
    mesh(new THREE.BoxGeometry(0.018, 0.008, 0.06), steel, root, 0, BORE_Y + 0.017, -0.04);

    // Handle (walnut), raked back
    const handle = mesh(new THREE.BoxGeometry(0.028, 0.11, 0.036), walnut, root, 0, -0.025, 0.028);
    handle.rotation.x = -0.32;
    // Butt cap
    const butt = mesh(new THREE.BoxGeometry(0.03, 0.01, 0.04), steel, root, 0, -0.078, 0.045);
    butt.rotation.x = -0.32;

    // Barrel, ejector housing and front sight
    const barrel = mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.14, 14), steel, root, 0, BORE_Y, -0.135);
    barrel.rotation.x = Math.PI / 2;
    const ejector = mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.1, 8), steel, root, 0.007, BORE_Y - 0.014, -0.115);
    ejector.rotation.x = Math.PI / 2;
    // Front sight: blade from the barrel top up to the sight line, with a
    // brass bead on its rear face so it reads clearly in a headset.
    const bladeH = FRONT_SIGHT_Y - (BORE_Y + BARREL_R) + 0.001;
    mesh(new THREE.BoxGeometry(0.0025, bladeH, 0.01), steel, root, 0, FRONT_SIGHT_Y - bladeH / 2, FRONT_SIGHT_Z);
    const brass = new THREE.MeshStandardMaterial({ color: 0xe8c66a, metalness: 0.9, roughness: 0.25, emissive: 0x3a2a08 });
    mesh(new THREE.SphereGeometry(0.0013, 8, 6), brass, root, 0, FRONT_SIGHT_Y - 0.0016, FRONT_SIGHT_Z + 0.0052);
    // Rear sight: a 3 mm notch cut between two ears on the back of the top strap.
    for (const side of [-1, 1]) {
      mesh(new THREE.BoxGeometry(0.004, 0.005, 0.006), steel, root, side * 0.0035, REAR_SIGHT.y + 0.0025, REAR_SIGHT.z);
    }
    mesh(new THREE.BoxGeometry(0.011, 0.002, 0.006), steel, root, 0, REAR_SIGHT.y - 0.001, REAR_SIGHT.z);
    /** Sight reference points: rear notch bottom and front blade top. */
    this.sightRear = new THREE.Object3D();
    this.sightRear.position.set(0, REAR_SIGHT.y, REAR_SIGHT.z);
    this.sightFront = new THREE.Object3D();
    this.sightFront.position.set(0, FRONT_SIGHT_Y, FRONT_SIGHT_Z);
    root.add(this.sightRear, this.sightFront);
    // Bore hole
    const bore = mesh(new THREE.CircleGeometry(0.0045, 10), dark, root, 0, BORE_Y, -0.2055);
    bore.rotation.y = Math.PI;
    bore.castShadow = false;

    // Cylinder: axis sits below the bore so the top chamber lines up with it.
    const CHAMBER_R = 0.012;
    this.cylinder = new THREE.Group();
    this.cylinder.position.set(0, BORE_Y - CHAMBER_R, -0.04);
    root.add(this.cylinder);
    const cyl = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.042, 12), steel, this.cylinder);
    cyl.rotation.x = Math.PI / 2;
    // Flutes / chamber mouths so cylinder rotation is visible.
    this.chamberMarkers = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const mouth = mesh(new THREE.CircleGeometry(0.0045, 8), dark, this.cylinder,
        Math.sin(a) * CHAMBER_R, Math.cos(a) * CHAMBER_R, -0.0215);
      mouth.rotation.y = Math.PI;
      mouth.castShadow = false;
      this.chamberMarkers.push(mouth);
    }

    // Hammer: pivots at the back of the frame; cocking swings the spur back.
    this.hammer = new THREE.Group();
    this.hammer.position.set(0, 0.035, 0.012);
    root.add(this.hammer);
    mesh(new THREE.BoxGeometry(0.008, 0.04, 0.012), caseHard, this.hammer, 0, 0.02, 0);
    this.hammerSpur = mesh(new THREE.BoxGeometry(0.012, 0.008, 0.02), caseHard, this.hammer, 0, 0.04, 0.01);

    // Trigger and guard
    this.trigger = new THREE.Group();
    this.trigger.position.set(0, 0.022, -0.012);
    root.add(this.trigger);
    const blade = mesh(new THREE.BoxGeometry(0.005, 0.026, 0.006), caseHard, this.trigger, 0, -0.013, 0);
    blade.rotation.x = 0.2;
    const guard = mesh(new THREE.TorusGeometry(0.017, 0.0022, 6, 16, Math.PI), caseHard, root, 0, 0.022, -0.012);
    guard.rotation.set(0, Math.PI / 2, Math.PI);

    // Muzzle: shots and flash originate here, pointing down -Z.
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, BORE_Y, -0.207);
    root.add(this.muzzle);

    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffc46a, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.flash = new THREE.Group();
    const petal = new THREE.PlaneGeometry(0.05, 0.12);
    petal.translate(0, 0.06, 0);
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(petal, flashMat);
      p.rotation.set(-Math.PI / 2, 0, 0);
      p.rotation.y = (i * Math.PI) / 2;
      this.flash.add(p);
    }
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), flashMat);
    core.position.z = -0.015;
    this.flash.add(core);
    this.flash.visible = false;
    this.muzzle.add(this.flash);
  }

  // -------------------------------------------------------------------------
  // Grabbing / holstering
  // -------------------------------------------------------------------------
  #buildBody() {
    const body = new CANNON.Body({
      mass: GUN_MASS,
      linearDamping: 0.05,
      angularDamping: 0.15,
      allowSleep: true,
      sleepSpeedLimit: 0.12,
      sleepTimeLimit: 0.5,
    });
    // Frame, cylinder and barrel. Same half-width as the grip box so the side
    // faces are flush and a gun lying on its side rests flat instead of rocking.
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.015, 0.03, 0.125)), new CANNON.Vec3(0, 0.055, -0.08));
    // Raked grip.
    const gripQ = new CANNON.Quaternion();
    gripQ.setFromEuler(-0.32, 0, 0);
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.015, 0.058, 0.02)), new CANNON.Vec3(0, -0.028, 0.03), gripQ);
    body.userData = { name: 'revolver' };
    body.addEventListener('collide', (e) => this.#onCollide(e));
    return body;
  }

  #onCollide(e) {
    const other = e.body;
    const c = e.contact;
    const speed = Math.abs(c.getImpactVelocityAlongNormal());
    // Contact point on the other body, in world space.
    const onOther = c.bi === other ? c.ri : c.rj;
    _v1.set(other.position.x + onOther.x, other.position.y + onOther.y, other.position.z + onOther.z);
    if (speed >= CLATTER_MIN_SPEED && this.clatterCooldown <= 0) {
      this.clatterCooldown = CLATTER_COOLDOWN;
      this.sfx.gunClatter(_v1.clone(), other.userData?.surface ?? 'sand', speed);
    }
    other.userData?.onGunImpact?.(speed, _v1.clone());
    this.dispatchEvent({ type: 'impact', speed, surface: other.userData?.surface, other });
  }

  #onSqueezeStart(hand) {
    if (hand.held || this.hand === hand) return;
    hand.grip.updateWorldMatrix(true, false);
    this.object.getWorldPosition(_v1);
    if (_v1.distanceTo(hand.position) > GRAB_RADIUS) return;
    this.grab(hand);
  }

  #onSqueezeEnd(hand) {
    if (this.hand === hand) this.release();
  }

  /** Snap the grip into `hand`, taking it from the other hand if needed. */
  grab(hand) {
    if (this.hand) this.hand.held = null;
    this.physics.removeBody(this.body);
    this.hand = hand;
    hand.held = this;
    this.state = RevolverState.HELD;
    this.triggerArmed = hand.values[BUTTON.TRIGGER] < TRIGGER_RESET;
    this.stickWasBack = true; // require a fresh pull-back to cock

    // Align the bore with the controller's pointing ray, so the gun aims where
    // the player naturally points on every controller type.
    hand.grip.updateWorldMatrix(true, false);
    hand.controller.updateWorldMatrix(true, false);
    hand.grip.getWorldQuaternion(_q1).invert();
    hand.controller.getWorldQuaternion(_q2);
    const toQuat = _q1.multiply(_q2).clone();

    hand.grip.attach(this.object);
    this.#startTween(new THREE.Vector3(), toQuat, SNAP_TIME);
    this.xr.pulse(hand, 0.3, 30);
    this.dispatchEvent({ type: 'grab', hand });
  }

  /** Let go: holster it if the hand is at the hip, otherwise drop/throw it. */
  release() {
    const hand = this.hand;
    if (hand) hand.held = null;
    this.hand = null;
    this.cocked = false;
    this.object.getWorldPosition(_v1);
    this.holster.socket.getWorldPosition(_v2);
    if (_v1.distanceTo(_v2) <= HOLSTER_RADIUS) {
      this.#holster(HOLSTER_TIME);
    } else {
      this.#drop(hand?.throwVelocity, hand?.angularVelocity);
    }
    this.dispatchEvent({ type: 'release', hand });
  }

  /** Slide (or fly, when recalled) into the holster socket. */
  #holster(duration) {
    this.physics.removeBody(this.body);
    this.state = RevolverState.HOLSTERING;
    this.holster.socket.attach(this.object);
    this.#startTween(new THREE.Vector3(), new THREE.Quaternion(), duration, () => {
      this.state = RevolverState.HOLSTERED;
      this.chambers.fill('live'); // temporary reload until Pass 4
      this.sfx.holster();
      this.dispatchEvent({ type: 'holstered' });
    });
  }

  /** Become a free rigid body with the hand's linear and angular velocity. */
  #drop(velocity, angularVelocity) {
    this.tween = null;
    this.state = RevolverState.DROPPED;
    this.scene.attach(this.object);
    const b = this.body;
    b.position.set(this.object.position.x, this.object.position.y, this.object.position.z);
    b.quaternion.set(this.object.quaternion.x, this.object.quaternion.y, this.object.quaternion.z, this.object.quaternion.w);
    b.velocity.set(velocity?.x ?? 0, velocity?.y ?? 0, velocity?.z ?? 0);
    b.angularVelocity.set(angularVelocity?.x ?? 0, angularVelocity?.y ?? 0, angularVelocity?.z ?? 0);
    b.wakeUp();
    this.physics.addBody(b);
    this.dispatchEvent({ type: 'drop' });
  }

  /** Bring a dropped gun back to the holster (thumbstick click, or out of bounds). */
  recall() {
    if (this.state !== RevolverState.DROPPED) return false;
    this.#holster(RECALL_TIME);
    this.dispatchEvent({ type: 'recall' });
    return true;
  }

  #startTween(toPos, toQuat, dur, onDone = null) {
    this.tween = {
      t: 0, dur,
      fromPos: this.object.position.clone(), toPos,
      fromQuat: this.object.quaternion.clone(), toQuat,
      onDone,
    };
  }

  #updateTween(dt) {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(tw.dur, tw.t + dt);
    const k = 1 - Math.pow(1 - tw.t / tw.dur, 3); // ease-out cubic
    this.object.position.lerpVectors(tw.fromPos, tw.toPos, k);
    this.object.quaternion.slerpQuaternions(tw.fromQuat, tw.toQuat, k);
    if (tw.t >= tw.dur) {
      this.tween = null;
      tw.onDone?.();
    }
  }

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------
  get isHeld() {
    return this.state === RevolverState.HELD;
  }

  /** Cock the hammer: advances the cylinder one chamber. */
  cock() {
    if (this.cocked || !this.isHeld) return false;
    this.cocked = true;
    this.#advanceCylinder();
    this.sfx.hammerCock();
    this.xr.pulse(this.hand, 0.25, 25);
    this.dispatchEvent({ type: 'cock', chamber: this.chamberIndex });
    return true;
  }

  #advanceCylinder() {
    this.chamberIndex = (this.chamberIndex + 1) % 6;
    this.cylinderTarget -= CHAMBER_STEP;
  }

  /** Drop the hammer on the current chamber. */
  #dropHammer() {
    this.cocked = false;
    this.hammerAngle = 0;
    const idx = this.chamberIndex;
    if (this.chambers[idx] === 'live') {
      this.chambers[idx] = 'spent';
      this.#shoot();
    } else {
      this.sfx.dryFire();
      this.xr.pulse(this.hand, 0.15, 15);
      this.dispatchEvent({ type: 'dryfire', chamber: idx });
    }
  }

  #shoot() {
    this.muzzle.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(this.muzzle.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(this.muzzle.matrixWorld);

    this.raycaster.set(origin, direction);
    this.raycaster.far = MUZZLE_VELOCITY_RANGE;
    const hit = this.raycaster.intersectObjects(this.getColliders(), true)[0] ?? null;
    if (hit) this.impacts.spawn(hit);

    // Recoil and flash are applied after the ray, so they never affect aim.
    this.recoil.angVel += RECOIL_KICK_ANG * (0.9 + Math.random() * 0.2);
    this.recoil.zVel += RECOIL_KICK_Z;
    this.flashTimer = FLASH_TIME;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);

    this.sfx.gunshot();
    this.xr.pulse(this.hand, 1.0, 90);
    this.dispatchEvent({ type: 'shot', origin, direction, hit, chamber: this.chamberIndex });
  }

  #processInput(dt) {
    const hand = this.hand;
    const trig = hand.values[BUTTON.TRIGGER];
    if (trig < TRIGGER_RESET) this.triggerArmed = true;

    // Cock: face button or thumbstick pulled back (axes y > 0 = towards player).
    const stickBack = hand.thumbstick.y > STICK_COCK;
    if (hand.justPressed[BUTTON.PRIMARY] || hand.justPressed[BUTTON.SECONDARY] || (stickBack && !this.stickWasBack)) {
      this.cock();
    }
    this.stickWasBack = stickBack;

    // Fanning: the free hand swipes fast across the hammer spur.
    this.fanCooldown = Math.max(0, this.fanCooldown - dt);
    if (!this.cocked && this.fanCooldown === 0) {
      const other = this.xr.hands.find((h) => h !== hand && h.connected && h.held === null);
      if (other && other.velocity.length() > FAN_SPEED) {
        this.hammerSpur.getWorldPosition(_v1);
        if (_v1.distanceTo(other.position) < FAN_RADIUS) {
          this.fanCooldown = FAN_COOLDOWN;
          this.xr.pulse(other, 0.35, 20);
          this.cock();
          if (trig > SA_BREAK) {
            this.triggerArmed = false;
            this.#dropHammer();
          }
          return;
        }
      }
    }

    if (!this.triggerArmed) return;
    if (this.cocked && trig >= SA_BREAK) {
      this.triggerArmed = false;
      this.#dropHammer();
    } else if (!this.cocked && trig >= DA_BREAK) {
      // Double action: the trigger cycles the cylinder and drops the hammer.
      this.triggerArmed = false;
      this.#advanceCylinder();
      this.#dropHammer();
    }
  }

  #updateDropped() {
    const b = this.body;
    this.object.position.set(b.position.x, b.position.y, b.position.z);
    this.object.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    const p = this.object.position;
    const lost = !Number.isFinite(p.x + p.y + p.z) || p.y < PLAY_AREA.minY || Math.hypot(p.x, p.z) > PLAY_AREA.radius;
    const recallPressed = this.xr.hands.some((h) => h.connected && h.justPressed[BUTTON.THUMBSTICK]);
    if (lost || recallPressed) this.recall();
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------
  update(dt) {
    this.#updateTween(dt);
    this.clatterCooldown = Math.max(0, this.clatterCooldown - dt);
    if (this.isHeld && this.hand) this.#processInput(dt);
    if (this.state === RevolverState.DROPPED) this.#updateDropped();

    const trig = this.isHeld && this.hand ? this.hand.values[BUTTON.TRIGGER] : 0;

    // Trigger follows the finger.
    this.trigger.rotation.x = TRIGGER_PULL_ANGLE * trig;

    // Hammer: cocked, or rising with a double-action pull, else at rest.
    let hammerTarget = 0;
    if (this.cocked) hammerTarget = HAMMER_COCKED_ANGLE;
    else if (this.triggerArmed && this.isHeld) {
      hammerTarget = HAMMER_COCKED_ANGLE * THREE.MathUtils.smoothstep(trig, 0.15, DA_BREAK);
    }
    this.hammerAngle += (hammerTarget - this.hammerAngle) * Math.min(1, dt * 40);
    this.hammer.rotation.x = this.hammerAngle;

    // Cylinder indexes quickly to its detent.
    this.cylinderAngle += (this.cylinderTarget - this.cylinderAngle) * Math.min(1, dt * 30);
    this.cylinder.rotation.z = this.cylinderAngle;

    // Recoil spring: semi-implicit Euler in fixed substeps, so the kick feels
    // identical at 72, 90 and 120 Hz and on a hitched frame.
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

    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flash.visible = this.flashTimer > 0;
  }
}
