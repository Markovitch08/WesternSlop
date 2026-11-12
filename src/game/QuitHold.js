import { BUTTON } from '../xr/XRManager.js';

/** Seconds B / Y must be held to leave a game mode. */
export const QUIT_HOLD = 1.0;
export const QUIT_HINT = 'hold B / Y on a free hand to quit';

/**
 * Leave whatever game mode is running (duel, pop-ups) by holding B or Y on a
 * hand that isn't holding anything. Guns use B / Y for their own actions, so
 * only an empty hand counts. A tick on the press, a thump when it quits.
 */
export class QuitHold {
  /**
   * @param {object} deps
   * @param {import('../xr/XRManager.js').XRManager} deps.xr
   * @param {{current: {stop(): void} | null}} deps.modes
   */
  constructor({ xr, modes }) {
    this.xr = xr;
    this.modes = modes;
    this.held = 0;
    this.quits = 0;
  }

  update(dt) {
    const mode = this.modes.current;
    const hand = mode && this.xr.hands.find((h) => h.connected && !h.held && h.pressed[BUTTON.SECONDARY]);
    if (!hand) {
      this.held = 0;
      return;
    }
    if (this.held === 0) this.xr.pulse(hand, 0.2, 30);
    this.held += dt;
    if (this.held < QUIT_HOLD) return;
    this.held = 0;
    this.quits++;
    this.xr.pulse(hand, 0.8, 120);
    mode.stop();
  }
}
