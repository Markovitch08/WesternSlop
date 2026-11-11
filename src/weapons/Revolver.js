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
 * Reloading (no holster needed):
 *   - B/Y swings the cylinder out on its crane; spent casings fall out as
 *     physics objects.
 *   - Grab cartridges from the pouch on the left hip with the free hand and
 *     hold them at the open cylinder: they feed into the empty chambers one
 *     at a time, in firing order.
 *   - B/Y again closes it, or push it back into the frame with the empty free
 *     hand, or flick the wrist (fast roll) to snap it shut with a free spin; after a spin the chamber that ends up under the hammer is
 *     wherever the cylinder stopped.
 *
 * Holding: the gun stays in your hand only while the grip button is held.
 *   - Let go at the hip and it slides into the holster.
 *   - Let go anywhere else and it becomes a rigid body: it is thrown with your
 *     hand's velocity and spin, falls, clatters off the ground and props, and
 *     can break bottles, ring gongs and knock over duelists. Pick it up again
 *     with the grip button near it.
 *   - Click a thumbstick to recall a dropped gun to the holster. A gun that
 *     leaves the play area returns on its own.
 *
 * Ballistics: the bullet leaves at MUZZLE_VELOCITY and drops under gravity;
 * its path is traced in short straight segments, each one raycast.
 *
 * Sights: a rear notch on the top strap and a front blade with a brass bead.
 * The sight line sits above the bore and is angled to meet the bullet's
 * (dropping) path at SIGHT_ZERO metres, so a sight picture on a target at that
 * range is a hit on the point of aim (about 2 cm low up close, about 1.5 cm
 * low at 25 m as the drop catches up).
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

// Ballistics (.45 Colt black powder, roughly).
export const MUZZLE_VELOCITY = 260; // m/s
const GRAVITY = 9.81;
const MAX_RANGE = 150; // metres traced
const SEGMENT_TIME = 1 / 120; // s per traced segment (~2.2 m)

// Sights (gun-local metres). See the class comment.
const BORE_Y = 0.06;
const SIGHT_ZERO = 15; // metres
const REAR_SIGHT = { y: 0.0815, z: -0.012 }; // bottom of the rear notch
const FRONT_SIGHT_Z = -0.196;
/** How far the bullet has dropped below the bore line after `range` metres (gun level). */
export const bulletDrop = (range) => 0.5 * GRAVITY * (range / MUZZLE_VELOCITY) ** 2;
/** Where the bullet is at SIGHT_ZERO (gun-local y): the sight line must pass through it. */
const ZERO_Y = BORE_Y - bulletDrop(SIGHT_ZERO);
/** Top of the front blade: on the line from the rear notch to the bullet at SIGHT_ZERO. */
const FRONT_SIGHT_Y = REAR_SIGHT.y + ((ZERO_Y - REAR_SIGHT.y) * (REAR_SIGHT.z - FRONT_SIGHT_Z)) / (REAR_SIGHT.z + SIGHT_ZERO);
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

const FLASH_TIME = 0.05;
const RECOIL_KICK_YAW = 2.5; // rad/s, random sideways

// Cylinder crane and reloading.
const CRANE_OPEN_ANGLE = 1.6; // rad, swung out to the left
const EJECT_DELAY = 0.12; // s after opening before casings drop out
const FEED_INTERVAL = 0.07; // s per round fed from the hand (six in ~0.4 s)
const FEED_RADIUS = 0.12; // metres, hand -> open cylinder
const PUSH_RADIUS = 0.1; // metres, empty free hand -> open cylinder to push it shut
const PUSH_SPEED = 0.35; // m/s toward the frame that counts as a push
const FLICK_ROLL_RATE = 9; // rad/s of wrist roll that snaps the cylinder shut
const SPIN_START = 26; // rad/s free spin after a flick close
const CHAMBER_R = 0.012;

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
  constructor({ xr, holster, sfx, impacts, getColliders, physics, scene, fx, casings }) {
    super();
    this.fx = fx;
    this.casings = casings;
    /** Set after construction: the AmmoPouch the free hand reloads from. */
    this.pouch = null;
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
    /** A disabled gun (the optional second gun, switched off) is hidden and can't be grabbed. */
    this.enabled = true;
    /** @type {import('../xr/XRManager.js').Hand|null} */
    this.hand = null;

    /** Six chambers: 'live' | 'spent' | 'empty'. */
    this.chambers = new Array(6).fill('live');
    /** Chamber under the hammer. Starts on 5 so the first cock brings up 0. */
    this.chamberIndex = 5;
    this.cocked = false;
    this.triggerArmed = true;

    this.hammerAngle = 0;
    // Chamber i sits at angle -i*STEP on the cylinder, so the chamber under the
    // hammer (top) is the one whose angle matches -cylinderAngle.
    this.cylinderAngle = -this.chamberIndex * CHAMBER_STEP;
    this.cylinderTarget = this.cylinderAngle;
    this.cylinderSpin = 0; // rad/s free spin after a flick close
    this.cylinderOpen = false;
    this.craneAngle = 0;
    this.openTime = 0;
    this.ejectTimer = -1;
    this.feedTimer = 0;
    this.recoil = { ang: 0, angVel: 0, z: 0, zVel: 0, yaw: 0, yawVel: 0 };
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

    // Cylinder on a crane: the crane hinges on an axis parallel to the bore,
    // below and left of the cylinder, and swings it out to the left for loading.
    // The cylinder axis sits below the bore so the top chamber lines up with it.
    const cylY = BORE_Y - CHAMBER_R;
    this.crane = new THREE.Group();
    this.crane.position.set(-0.02, cylY - 0.018, -0.04);
    root.add(this.crane);
    mesh(new THREE.BoxGeometry(0.02, 0.004, 0.006), steel, this.crane, 0.01, 0.009, 0.018); // crane arm
    this.cylinder = new THREE.Group();
    this.cylinder.position.set(0.02, 0.018, 0);
    this.crane.add(this.cylinder);
    const cyl = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.042, 12), steel, this.cylinder);
    cyl.rotation.x = Math.PI / 2;
    // Chamber mouths (front) and cartridge heads (rear) so you can see what's loaded.
    this.chamberMarkers = [];
    this.caseHeads = [];
    const headGeo = new THREE.CircleGeometry(0.0057, 12);
    const primerGeo = new THREE.CircleGeometry(0.0018, 8);
    this.caseMaterials = {
      live: new THREE.MeshStandardMaterial({ color: 0xd4ab52, metalness: 0.9, roughness: 0.28 }),
      spent: new THREE.MeshStandardMaterial({ color: 0x7e6232, metalness: 0.7, roughness: 0.55 }),
      primerLive: new THREE.MeshStandardMaterial({ color: 0xc8c2b4, metalness: 0.8, roughness: 0.3 }),
      primerSpent: new THREE.MeshStandardMaterial({ color: 0x3a3632, metalness: 0.5, roughness: 0.6 }),
    };
    for (let i = 0; i < 6; i++) {
      const a = -i * CHAMBER_STEP;
      const x = Math.sin(a) * CHAMBER_R;
      const y = Math.cos(a) * CHAMBER_R;
      const mouth = mesh(new THREE.CircleGeometry(0.0045, 8), dark, this.cylinder, x, y, -0.0215);
      mouth.rotation.y = Math.PI;
      mouth.castShadow = false;
      this.chamberMarkers.push(mouth);
      const head = mesh(headGeo, this.caseMaterials.live, this.cylinder, x, y, 0.0216);
      head.castShadow = false;
      const primer = mesh(primerGeo, this.caseMaterials.primerLive, head, 0, 0, 0.0002);
      primer.castShadow = false;
      this.caseHeads.push({ head, primer });
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
    if (!this.enabled || hand.held || this.hand === hand) return;
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
    if (this.cylinderOpen) this.closeCylinder(false);
    this.#startTween(new THREE.Vector3(), new THREE.Quaternion(), duration, () => {
      this.state = RevolverState.HOLSTERED;
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
  /** Put the gun straight into its holster, wherever it is (no animation). */
  stow() {
    if (this.hand) this.hand.held = null;
    this.hand = null;
    this.cocked = false;
    if (this.cylinderOpen) this.closeCylinder(false);
    this.physics.removeBody(this.body);
    this.tween = null;
    this.holster.socket.add(this.object);
    this.object.position.set(0, 0, 0);
    this.object.quaternion.identity();
    this.state = RevolverState.HOLSTERED;
  }

  /** Switch the gun (and its holster) on or off. */
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stow();
    this.object.visible = on;
    this.holster.object.visible = on;
  }

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
    if (this.cocked || !this.isHeld || this.cylinderOpen) return false;
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

  /**
   * Trace the bullet: constant-gravity flight in SEGMENT_TIME steps, each
   * segment raycast against the colliders. Returns the first hit (with
   * `distance` measured along the path) or null.
   */
  traceBullet(origin, direction) {
    const colliders = this.getColliders();
    const pos = origin.clone();
    const vel = direction.clone().multiplyScalar(MUZZLE_VELOCITY);
    const next = new THREE.Vector3();
    const seg = new THREE.Vector3();
    const t = SEGMENT_TIME;
    let travelled = 0;
    while (travelled < MAX_RANGE) {
      next.copy(pos).addScaledVector(vel, t);
      next.y -= 0.5 * GRAVITY * t * t;
      vel.y -= GRAVITY * t;
      seg.subVectors(next, pos);
      const len = seg.length();
      this.raycaster.set(pos, seg.divideScalar(len));
      this.raycaster.far = len;
      const hit = this.raycaster.intersectObjects(colliders, true)[0];
      if (hit) {
        hit.distance += travelled;
        return hit;
      }
      travelled += len;
      pos.copy(next);
    }
    return null;
  }

  #shoot() {
    this.muzzle.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(this.muzzle.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(this.muzzle.matrixWorld);

    const hit = this.traceBullet(origin, direction);
    if (hit) this.impacts.spawn(hit);
    this.fx?.muzzle(origin, direction);

    // Recoil and flash are applied after the trace, so they never affect aim.
    this.recoil.angVel += RECOIL_KICK_ANG * (0.9 + Math.random() * 0.2);
    this.recoil.zVel += RECOIL_KICK_Z;
    this.recoil.yawVel += (Math.random() * 2 - 1) * RECOIL_KICK_YAW;
    this.flashTimer = FLASH_TIME;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);

    this.sfx.gunshot(origin);
    this.xr.pulse(this.hand, 1.0, 90);
    this.dispatchEvent({ type: 'shot', origin, direction, hit, chamber: this.chamberIndex });
  }

  #processInput(dt) {
    const hand = this.hand;
    const trig = hand.values[BUTTON.TRIGGER];
    if (trig < TRIGGER_RESET) this.triggerArmed = true;

    // B/Y: swing the cylinder out / in.
    if (hand.justPressed[BUTTON.SECONDARY]) {
      if (this.cylinderOpen) this.closeCylinder(false);
      else this.openCylinder();
    }

    // Cock: A/X or thumbstick pulled back (axes y > 0 = towards player).
    const stickBack = hand.thumbstick.y > STICK_COCK;
    if (hand.justPressed[BUTTON.PRIMARY] || (stickBack && !this.stickWasBack)) {
      this.cock();
    }
    this.stickWasBack = stickBack;

    if (this.cylinderOpen) {
      this.#updateReload(dt);
      return; // nothing fires with the cylinder out
    }

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

  // -------------------------------------------------------------------------
  // Cylinder & reloading
  // -------------------------------------------------------------------------

  /** Chambers that can take a round now (after ejecting spent cases). */
  get roundsWanted() {
    return this.chambers.filter((c) => c !== 'live').length;
  }

  openCylinder() {
    if (this.cylinderOpen || !this.isHeld) return false;
    this.cylinderOpen = true;
    this.cocked = false;
    this.openTime = 0;
    this.ejectTimer = EJECT_DELAY;
    this.cylinderSpin = 0;
    this.cylinderAngle = this.cylinderTarget;
    this.sfx.cylinderOpen();
    this.xr.pulse(this.hand, 0.3, 25);
    this.dispatchEvent({ type: 'cylinderOpen' });
    return true;
  }

  /** @param {boolean} spin true for a wrist-flick close: the cylinder spins free */
  closeCylinder(spin) {
    if (!this.cylinderOpen) return false;
    this.cylinderOpen = false;
    this.ejectTimer = -1;
    if (spin) this.cylinderSpin = SPIN_START * (0.85 + Math.random() * 0.3);
    this.sfx.cylinderClose();
    if (this.hand) this.xr.pulse(this.hand, 0.45, 30);
    this.dispatchEvent({ type: 'cylinderClose', spin });
    return true;
  }

  /** Spent cases fall out of the swung-out cylinder. */
  #ejectSpent() {
    this.cylinder.updateWorldMatrix(true, true);
    const q = this.cylinder.getWorldQuaternion(new THREE.Quaternion());
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    let n = 0;
    this.chambers.forEach((c, i) => {
      if (c !== 'spent') return;
      this.chambers[i] = 'empty';
      n++;
      const pos = this.caseHeads[i].head.getWorldPosition(new THREE.Vector3());
      const vel = back.clone().multiplyScalar(0.6 + Math.random() * 0.5)
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.4, -0.3 - Math.random() * 0.3, (Math.random() - 0.5) * 0.4));
      if (this.hand) vel.add(this.hand.velocity);
      this.casings?.eject(pos, q, vel);
    });
    if (n) {
      this.sfx.ejectorRod();
      this.dispatchEvent({ type: 'eject', count: n });
    }
  }

  /** Next empty chamber in firing order (the one after the hammer first). */
  #nextEmptyChamber() {
    for (let k = 1; k <= 6; k++) {
      const i = (this.chamberIndex + k) % 6;
      if (this.chambers[i] === 'empty') return i;
    }
    return -1;
  }

  #updateReload(dt) {
    this.openTime += dt;
    if (this.ejectTimer >= 0) {
      this.ejectTimer -= dt;
      if (this.ejectTimer < 0) this.#ejectSpent();
    }

    // Feed rounds from a free hand held at the cylinder.
    this.feedTimer = Math.max(0, this.feedTimer - dt);
    if (this.feedTimer === 0 && this.ejectTimer < 0 && this.pouch) {
      this.cylinder.getWorldPosition(_v1);
      const loader = this.xr.hands.find((h) => h !== this.hand && h.held?.type === 'rounds' && h.position.distanceTo(_v1) < FEED_RADIUS);
      const i = this.#nextEmptyChamber();
      if (loader && i >= 0) {
        this.chambers[i] = 'live';
        this.pouch.consume(loader);
        this.feedTimer = FEED_INTERVAL;
        this.sfx.roundInsert();
        this.xr.pulse(this.hand, 0.12, 15);
        this.xr.pulse(loader, 0.18, 15);
        this.dispatchEvent({ type: 'load', chamber: i });
      }
    }

    // The empty free hand pushes the cylinder back into the frame. Uses this
    // frame's hand velocity (not the throw average) so a hand that has just
    // arrived from the pouch doesn't count as a push.
    if (this.openTime > 0.25 && this.cylinderOpen) {
      const pusher = this.xr.hands.find((h) => h !== this.hand && h.connected && h.held === null);
      if (pusher) {
        this.cylinder.getWorldPosition(_v1);
        if (pusher.position.distanceTo(_v1) < PUSH_RADIUS) {
          const toFrame = this.#closedCylinderWorld(_v2).sub(_v1).normalize();
          if (pusher.velocity.dot(toFrame) > PUSH_SPEED) {
            this.closeCylinder(false);
            this.xr.pulse(pusher, 0.4, 25);
            this.dispatchEvent({ type: 'cylinderPushed' });
            return;
          }
        }
      }
    }

    // A sharp roll of the wrist snaps the cylinder shut.
    if (this.openTime > 0.25) {
      this.object.getWorldQuaternion(_q1);
      const axis = _v2.set(0, 0, -1).applyQuaternion(_q1);
      if (Math.abs(this.hand.angularVelocity.dot(axis)) > FLICK_ROLL_RATE) this.closeCylinder(true);
    }
  }

  /** Where the cylinder sits when closed (crane swung in), in world space. */
  #closedCylinderWorld(target) {
    target.copy(this.crane.position).add(this.cylinder.position);
    this.recoilPivot.updateWorldMatrix(true, false);
    return this.recoilPivot.localToWorld(target);
  }

  /** Free spin after a flick close: ratchets past each chamber, then settles. */
  #updateSpin(dt) {
    const before = Math.floor(this.cylinderAngle / CHAMBER_STEP);
    this.cylinderAngle -= this.cylinderSpin * dt;
    this.cylinderSpin *= Math.exp(-2.6 * dt);
    if (Math.floor(this.cylinderAngle / CHAMBER_STEP) !== before) {
      this.sfx.click(1.3, 0.12);
      if (this.hand) this.xr.pulse(this.hand, 0.1, 10); // light "cylinder spin" rumble
    }
    if (this.cylinderSpin < 2.5) {
      // Settle into the nearest detent; that chamber is now under the hammer.
      const k = Math.round(-this.cylinderAngle / CHAMBER_STEP);
      this.cylinderSpin = 0;
      this.cylinderTarget = -k * CHAMBER_STEP;
      this.chamberIndex = ((k % 6) + 6) % 6;
      this.sfx.click(1.0, 0.25);
      this.dispatchEvent({ type: 'spinStop', chamber: this.chamberIndex });
    }
  }

  #updateCaseHeads() {
    const m = this.caseMaterials;
    this.chambers.forEach((c, i) => {
      const { head, primer } = this.caseHeads[i];
      head.visible = c !== 'empty';
      head.material = c === 'live' ? m.live : m.spent;
      primer.material = c === 'live' ? m.primerLive : m.primerSpent;
    });
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
    else if (this.triggerArmed && this.isHeld && !this.cylinderOpen) {
      hammerTarget = HAMMER_COCKED_ANGLE * THREE.MathUtils.smoothstep(trig, 0.15, DA_BREAK);
    }
    this.hammerAngle += (hammerTarget - this.hammerAngle) * Math.min(1, dt * 40);
    this.hammer.rotation.x = this.hammerAngle;

    // Cylinder: free spin after a flick, else index quickly to its detent.
    if (this.cylinderSpin > 0) this.#updateSpin(dt);
    else this.cylinderAngle += (this.cylinderTarget - this.cylinderAngle) * Math.min(1, dt * 30);
    this.cylinder.rotation.z = this.cylinderAngle;

    // Crane swings the cylinder out / in.
    const craneTarget = this.cylinderOpen ? CRANE_OPEN_ANGLE : 0;
    this.craneAngle += (craneTarget - this.craneAngle) * Math.min(1, dt * 22);
    this.crane.rotation.z = this.craneAngle;
    this.#updateCaseHeads();

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
      r.yawVel += (-RECOIL_K * r.yaw - RECOIL_C * r.yawVel) * h;
      r.yaw += r.yawVel * h;
    }
    this.recoilPivot.rotation.x = r.ang;
    this.recoilPivot.rotation.y = r.yaw;
    this.recoilPivot.position.z = r.z;

    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flash.visible = this.flashTimer > 0;
  }
}
