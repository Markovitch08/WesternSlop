import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

/**
 * xr-standard gamepad mapping (Meta Quest Touch controllers):
 *   buttons[0] trigger, [1] squeeze/grip, [3] thumbstick press,
 *   [4] A / X, [5] B / Y;  axes[2], axes[3] thumbstick x / y.
 */
export const BUTTON = Object.freeze({
  TRIGGER: 0,
  SQUEEZE: 1,
  THUMBSTICK: 3,
  PRIMARY: 4, // A (right) / X (left)
  SECONDARY: 5, // B (right) / Y (left)
});

const BUTTON_COUNT = 6;
const THROW_WINDOW = 5; // frames averaged for throw velocity (~70 ms at 72 Hz)
const _tmpMatrix = new THREE.Matrix4();
const _tmpScale = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpVec = new THREE.Vector3();
const _dq = new THREE.Quaternion();

/**
 * Per-hand state: the three.js controller spaces, the WebXR input source,
 * and edge-detected button state polled once per frame.
 */
class Hand {
  constructor(index, controller, grip) {
    this.index = index;
    this.controller = controller; // target-ray space (pointing)
    this.grip = grip; // grip space (where the hand holds things)
    this.inputSource = null;
    this.handedness = 'none';
    this.connected = false;

    this.pressed = new Array(BUTTON_COUNT).fill(false);
    this.justPressed = new Array(BUTTON_COUNT).fill(false);
    this.justReleased = new Array(BUTTON_COUNT).fill(false);
    this.values = new Array(BUTTON_COUNT).fill(0);
    this.thumbstick = new THREE.Vector2();

    /** Object currently held by this hand (e.g. the Revolver), or null. */
    this.held = null;
    /** Controller model shown in the grip space; hidden while holding. */
    this.model = null;

    /** Grip-space world position and velocity (m/s), updated every frame. */
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this._prevPosition = new THREE.Vector3();
    this._hasPrev = false;
    /**
     * Mean grip velocity over the last THROW_WINDOW frames: what a released
     * object is thrown with. A fixed window (not exponential smoothing) means a
     * hand held still for a few frames throws with exactly zero velocity.
     */
    this.throwVelocity = new THREE.Vector3();
    /** Grip angular velocity, rad/s (axis * speed), averaged the same way. */
    this.angularVelocity = new THREE.Vector3();
    this._velHistory = Array.from({ length: THROW_WINDOW }, () => new THREE.Vector3());
    this._angHistory = Array.from({ length: THROW_WINDOW }, () => new THREE.Vector3());
    this._histIndex = 0;
    this.quaternion = new THREE.Quaternion();
    this._prevQuaternion = new THREE.Quaternion();
  }

  get gamepad() {
    return this.inputSource?.gamepad ?? null;
  }

  poll() {
    const gp = this.gamepad;
    for (let i = 0; i < BUTTON_COUNT; i++) {
      const btn = gp?.buttons[i];
      const now = !!btn?.pressed;
      this.justPressed[i] = now && !this.pressed[i];
      this.justReleased[i] = !now && this.pressed[i];
      this.pressed[i] = now;
      this.values[i] = btn?.value ?? 0;
    }
    if (gp && gp.axes.length >= 4) this.thumbstick.set(gp.axes[2], gp.axes[3]);
    else this.thumbstick.set(0, 0);
  }

  reset() {
    this.pressed.fill(false);
    this.justPressed.fill(false);
    this.justReleased.fill(false);
    this.values.fill(0);
    this.thumbstick.set(0, 0);
  }
}

/**
 * Owns WebXR controller tracking, controller visualisation, pointer rays,
 * per-frame button polling and haptics. Grabbing is layered on top by the
 * objects that listen to the squeeze events and fill the `held` slot.
 */
export class XRManager extends THREE.EventDispatcher {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Object3D} parent  object controllers are attached to (the player rig)
   */
  constructor(renderer, parent) {
    super();
    this.renderer = renderer;
    this.parent = parent;
    this.hands = [];
    this.raycaster = new THREE.Raycaster();

    const modelFactory = new XRControllerModelFactory();

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const model = modelFactory.createControllerModel(grip);
      grip.add(model);
      controller.add(this.#createPointerRay());

      const hand = new Hand(i, controller, grip);
      hand.model = model;
      this.hands.push(hand);

      controller.addEventListener('connected', (e) => {
        hand.inputSource = e.data;
        hand.handedness = e.data.handedness;
        hand.connected = true;
        controller.userData.handedness = hand.handedness;
        this.dispatchEvent({ type: 'connected', hand });
      });
      controller.addEventListener('disconnected', () => {
        hand.connected = false;
        hand.inputSource = null;
        hand._hasPrev = false;
        for (const v of [...hand._velHistory, ...hand._angHistory]) v.set(0, 0, 0);
        hand.reset();
        this.dispatchEvent({ type: 'disconnected', hand });
      });

      // Forward the native select/squeeze events with the Hand attached.
      for (const type of ['selectstart', 'selectend', 'squeezestart', 'squeezeend']) {
        controller.addEventListener(type, () => this.dispatchEvent({ type, hand }));
      }

      parent.add(controller, grip);
    }
  }

  #createPointerRay() {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.6 }),
    );
    line.name = 'pointer';
    line.scale.z = 3;
    return line;
  }

  /** @param {'left'|'right'} handedness */
  getHand(handedness) {
    return this.hands.find((h) => h.handedness === handedness) ?? null;
  }

  /** Call once per frame before gameplay logic. */
  update(dt) {
    for (const hand of this.hands) {
      if (hand.connected) {
        hand.poll();
        hand.grip.updateWorldMatrix(true, false);
        hand.grip.matrixWorld.decompose(hand.position, hand.quaternion, _tmpScale);
        if (hand._hasPrev && dt > 0) {
          hand.velocity.subVectors(hand.position, hand._prevPosition).divideScalar(dt);
          // Angular velocity from the frame-to-frame rotation delta.
          _dq.copy(hand.quaternion).multiply(_tmpQuat.copy(hand._prevQuaternion).invert());
          if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
          const angle = 2 * Math.acos(Math.min(1, _dq.w));
          const sinHalf = Math.sqrt(Math.max(0, 1 - _dq.w * _dq.w));
          if (sinHalf > 1e-6) _tmpVec.set(_dq.x / sinHalf, _dq.y / sinHalf, _dq.z / sinHalf).multiplyScalar(angle / dt);
          else _tmpVec.set(0, 0, 0);
        } else {
          hand.velocity.set(0, 0, 0);
          _tmpVec.set(0, 0, 0);
        }
        hand._velHistory[hand._histIndex].copy(hand.velocity);
        hand._angHistory[hand._histIndex].copy(_tmpVec);
        hand._histIndex = (hand._histIndex + 1) % THROW_WINDOW;
        hand.throwVelocity.set(0, 0, 0);
        hand.angularVelocity.set(0, 0, 0);
        for (let k = 0; k < THROW_WINDOW; k++) {
          hand.throwVelocity.add(hand._velHistory[k]);
          hand.angularVelocity.add(hand._angHistory[k]);
        }
        hand.throwVelocity.divideScalar(THROW_WINDOW);
        hand.angularVelocity.divideScalar(THROW_WINDOW);
        hand._prevPosition.copy(hand.position);
        hand._prevQuaternion.copy(hand.quaternion);
        hand._hasPrev = true;
      }
      // Hide the pointer ray and controller model while something is held.
      const empty = hand.held === null;
      const pointer = hand.controller.getObjectByName('pointer');
      if (pointer) pointer.visible = empty;
      if (hand.model) hand.model.visible = empty;
    }
  }

  /**
   * Fire a ray from the hand's target-ray space and intersect `objects`.
   * @returns {THREE.Intersection[]}
   */
  raycastFrom(hand, objects, far = 100) {
    hand.controller.updateWorldMatrix(true, false);
    _tmpMatrix.identity().extractRotation(hand.controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(hand.controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_tmpMatrix);
    this.raycaster.far = far;
    return this.raycaster.intersectObjects(objects, true);
  }

  /**
   * Haptic pulse. Supports the GamepadHapticActuator.pulse() path used by the
   * Quest browser and the newer vibrationEffect.playEffect() path.
   * @param {Hand} hand
   * @param {number} intensity 0..1
   * @param {number} durationMs
   */
  pulse(hand, intensity, durationMs) {
    const gp = hand?.gamepad;
    if (!gp) return;
    const strength = THREE.MathUtils.clamp(intensity, 0, 1);
    const actuator = gp.hapticActuators?.[0];
    if (actuator?.pulse) {
      actuator.pulse(strength, durationMs).catch(() => {});
    } else if (gp.vibrationEffect?.playEffect) {
      gp.vibrationEffect
        .playEffect('dual-rumble', {
          duration: durationMs,
          strongMagnitude: strength,
          weakMagnitude: strength,
        })
        .catch(() => {});
    }
  }
}
