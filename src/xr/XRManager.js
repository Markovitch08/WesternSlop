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
const _tmpMatrix = new THREE.Matrix4();

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

    /** Object currently held by this hand (set by grab logic in Pass 2). */
    this.held = null;
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
 * per-frame button polling and haptics. Grabbing/holstering is layered on top
 * in Pass 2 via the `held` slot and the emitted events.
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
      grip.add(modelFactory.createControllerModel(grip));
      controller.add(this.#createPointerRay());

      const hand = new Hand(i, controller, grip);
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
  update() {
    for (const hand of this.hands) {
      if (hand.connected) hand.poll();
      // Hide the pointer ray while something is held.
      const pointer = hand.controller.getObjectByName('pointer');
      if (pointer) pointer.visible = hand.held === null;
    }
  }

  /**
   * Fire a ray from the hand's target-ray space and intersect `objects`.
   * @returns {THREE.Intersection[]}
   */
  raycastFrom(hand, objects, far = 100) {
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
