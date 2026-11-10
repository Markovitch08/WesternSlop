import * as THREE from 'three';

/**
 * Single-action six-shooter.
 *
 * Pass 1 provides only the state shape and the update hook main.js calls.
 * Pass 2 adds the model, grip attachment, trigger/hammer animation, raycast
 * firing and haptics; Pass 4 adds cylinder swing-out, ejection and reloading.
 */
export const RevolverState = Object.freeze({
  HOLSTERED: 'holstered',
  HELD_UNCOCKED: 'held_uncocked',
  HELD_COCKED: 'held_cocked',
  CYLINDER_OPEN: 'cylinder_open',
});

export class Revolver {
  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'revolver';
    this.state = RevolverState.HOLSTERED;
    /** Six chambers: 'live' | 'spent' | 'empty'. */
    this.chambers = new Array(6).fill('live');
    this.chamberIndex = 0;
  }

  // eslint-disable-next-line no-unused-vars
  update(dt) {}
}
