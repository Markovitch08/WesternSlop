import * as THREE from 'three';

const _head = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _v = new THREE.Vector3();

const GRAB_RADIUS = 0.16; // metres, hand -> pouch mouth
const MAX_IN_HAND = 6;

const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.9, roughness: 0.3 });
const lead = new THREE.MeshStandardMaterial({ color: 0x77736c, metalness: 0.4, roughness: 0.6 });
let roundGeo = null;
let tipGeo = null;

/** One .45 cartridge (case + lead bullet), long axis along -Z (bullet forward). */
export function makeRound() {
  roundGeo ??= new THREE.CylinderGeometry(0.0058, 0.0058, 0.032, 10).rotateX(Math.PI / 2);
  tipGeo ??= new THREE.ConeGeometry(0.0057, 0.012, 10).rotateX(-Math.PI / 2).translate(0, 0, -0.022);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(roundGeo, brass), new THREE.Mesh(tipGeo, lead));
  g.traverse((o) => { o.raycast = () => {}; });
  return g;
}

/**
 * Leather cartridge pouch on the left hip (follows body yaw like the holster).
 * Squeeze grip with a free hand at the pouch to take a palmful of rounds (as
 * many as the open cylinder has empty chambers, at least one). The rounds ride
 * in the hand until they're fed into the cylinder; letting go of grip puts any
 * leftovers back.
 */
export class AmmoPouch {
  /**
   * @param {THREE.Object3D} parent
   * @param {import('../xr/XRManager.js').XRManager} xr
   * @param {import('../audio/SoundFX.js').SoundFX} sfx
   * @param {() => number} roundsWanted how many rounds the gun can take right now
   * @param {'left'|'right'} side
   */
  constructor(parent, xr, sfx, roundsWanted, side = 'left') {
    this.xr = xr;
    this.sfx = sfx;
    this.roundsWanted = roundsWanted;
    this.side = side;
    this.bodyYaw = 0;
    this.object = new THREE.Group();
    this.object.name = 'ammoPouch';

    const leather = new THREE.MeshStandardMaterial({ color: 0x5e3a1e, roughness: 0.85 });
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.05), leather);
    pouch.position.y = -0.04;
    pouch.castShadow = true;
    this.object.add(pouch);
    // A row of cartridge tips peeking out of the top.
    for (let i = 0; i < 5; i++) {
      const r = makeRound();
      r.rotation.x = -Math.PI / 2; // bullet up
      r.position.set(-0.03 + i * 0.015, 0.008, 0);
      this.object.add(r);
    }
    parent.add(this.object);

    /** @type {Map<import('../xr/XRManager.js').Hand, { count: number, group: THREE.Group, rounds: THREE.Object3D[] }>} */
    this.inHand = new Map();

    xr.addEventListener('squeezestart', ({ hand }) => this.#onSqueezeStart(hand));
    xr.addEventListener('squeezeend', ({ hand }) => this.#onSqueezeEnd(hand));
  }

  /** Move the pouch to the other hip (handedness setting). */
  setSide(side) {
    this.side = side;
  }

  get #sign() {
    return this.side === 'right' ? 1 : -1;
  }

  #onSqueezeStart(hand) {
    if (hand.held) return; // holding the gun (or already holding rounds)
    this.object.getWorldPosition(_v);
    if (_v.distanceTo(hand.position) > GRAB_RADIUS) return;
    this.take(hand, Math.min(MAX_IN_HAND, Math.max(1, this.roundsWanted())));
  }

  #onSqueezeEnd(hand) {
    if (this.inHand.has(hand)) this.putBack(hand);
  }

  /** Put `count` rounds in `hand`. */
  take(hand, count) {
    const group = new THREE.Group();
    group.name = 'roundsInHand';
    const rounds = [];
    for (let i = 0; i < count; i++) {
      const r = makeRound();
      // Fanned between the fingers, bullets pointing forward.
      r.position.set((i - (count - 1) / 2) * 0.013, -0.012, -0.03 - Math.abs(i - (count - 1) / 2) * 0.004);
      group.add(r);
      rounds.push(r);
    }
    hand.grip.add(group);
    const held = { type: 'rounds', count, group, rounds };
    this.inHand.set(hand, held);
    hand.held = held;
    this.sfx.pouch();
    this.xr.pulse(hand, 0.2, 20);
    return held;
  }

  /** Remove one round from `hand` (it went into the cylinder). */
  consume(hand) {
    const held = this.inHand.get(hand);
    if (!held) return;
    held.count--;
    const r = held.rounds.pop();
    if (r) held.group.remove(r);
    if (held.count <= 0) this.putBack(hand);
  }

  /** Empty the hand (leftover rounds go back in the pouch). */
  putBack(hand) {
    const held = this.inHand.get(hand);
    if (!held) return;
    hand.grip.remove(held.group);
    this.inHand.delete(hand);
    if (hand.held === held) hand.held = null;
  }

  update(camera, dt) {
    camera.getWorldPosition(_head);
    camera.getWorldQuaternion(_headQuat);
    _fwd.set(0, 0, -1).applyQuaternion(_headQuat);
    const headYaw = Math.atan2(-_fwd.x, -_fwd.z);
    let diff = headYaw - this.bodyYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.bodyYaw += diff * Math.min(1, dt * 3);
    _offset.set(0.17 * this.#sign, 0, -0.02).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.bodyYaw);
    this.object.position.set(_head.x + _offset.x, Math.max(0.6, _head.y - 0.62), _head.z + _offset.z);
    this.object.rotation.set(0, this.bodyYaw, 0);
  }
}
