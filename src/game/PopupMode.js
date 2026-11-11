import * as THREE from 'three';

/**
 * Pop-up outlaws, as its own timed game mode (home is static practice).
 *
 * Shoot the orange POP-UP plate: 3 · 2 · 1 · GO, then for `duration` seconds
 * cardboard outlaws spring up at random and you shoot as many as you can, as
 * fast as you can. The sign shows the time left and your score; at the end it
 * shows the totals, then the outlaws pack away and the range goes back home.
 */
export const PopupState = Object.freeze({
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  PLAY: 'play',
  SUMMARY: 'summary',
});

const SUMMARY_TIME = 5;
const COUNTDOWN_BEAT = 1;

export class PopupMode extends THREE.EventDispatcher {
  /**
   * @param {object} deps
   * @param {import('../targets/TargetManager.js').TargetManager} deps.targets
   * @param {import('../weapons/Revolver.js').Revolver} deps.revolver
   * @param {import('../audio/SoundFX.js').SoundFX} deps.sfx
   * @param {import('../ui/DuelHUD.js').DuelHUD} deps.hud shared sign over the range
   * @param {{ current: object|null }} deps.modes one game mode at a time
   */
  constructor({ targets, revolver, guns = null, sfx, hud, modes }) {
    super();
    Object.assign(this, { targets, revolver, sfx, hud, modes });
    this.guns = guns ?? [revolver];
    this.state = PopupState.IDLE;
    this.duration = 45; // seconds of play
    this.gap = [0.6, 1.8]; // pause between pop-ups during the mode
    this.timer = 0;
    this.lastShown = '';
    this.#reset();

    targets.addEventListener('popupStart', () => this.start());
    targets.addEventListener('hit', ({ report }) => {
      if (this.state !== PopupState.PLAY || report.type !== 'duelist') return;
      this.score.points += report.points;
      this.score.hits++;
      this.score.reactions.push(report.reaction);
    });
    targets.addEventListener('duelResolved', ({ outcome }) => {
      if (this.state === PopupState.PLAY && outcome === 'timeout') this.score.missed++;
    });
    for (const gun of this.guns) {
      gun.addEventListener('shot', () => {
        if (this.state === PopupState.PLAY) this.score.shots++;
      });
    }
  }

  #reset() {
    this.score = { points: 0, hits: 0, missed: 0, shots: 0, reactions: [] };
  }

  get active() {
    return this.state !== PopupState.IDLE;
  }

  get timeLeft() {
    return this.state === PopupState.PLAY ? Math.max(0, this.duration - this.timer) : 0;
  }

  start() {
    if (this.active || this.modes.current) return;
    this.modes.current = this;
    this.#reset();
    this.targets.setDuelistsActive(true);
    this.targets.duelEnabled = false;
    this.state = PopupState.COUNTDOWN;
    this.timer = 0;
    this.beat = 0;
    this.hud.show('3', 'Pop-up outlaws · get ready', '#fff2d8', true);
    this.sfx.countdownTick(false);
    this.dispatchEvent({ type: 'start' });
  }

  /** End early or after the summary: pack the outlaws away, back to home. */
  stop() {
    if (!this.active) return;
    this.targets.duelEnabled = false;
    this.targets.setDuelistsActive(false);
    this.state = PopupState.IDLE;
    this.hud.hide();
    if (this.modes.current === this) this.modes.current = null;
    this.dispatchEvent({ type: 'end', score: this.score });
  }

  #play() {
    this.state = PopupState.PLAY;
    this.timer = 0;
    this.savedGap = this.targets.popupGap;
    this.targets.popupGap = this.gap;
    this.targets.duel.timer = 0.4;
    this.targets.duelEnabled = true;
    this.hud.show('GO!', '', '#9be37a', true);
    this.sfx.bell(new THREE.Vector3(0, 1, -0.8));
  }

  #finish() {
    this.targets.duelEnabled = false;
    this.targets.popupGap = this.savedGap ?? this.targets.popupGap;
    for (const d of this.targets.duelists) d.retire();
    const s = this.score;
    const avg = s.reactions.length ? s.reactions.reduce((a, b) => a + b, 0) / s.reactions.length : null;
    const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
    this.hud.show(`${s.points} pts`, `${s.hits} hit · ${s.missed} got away · ${acc}% accuracy\n${avg != null ? `average ${avg.toFixed(2)} s` : 'no hits'} · shoot POP-UP to go again`, '#ffd36b');
    this.sfx.bell(new THREE.Vector3(0, 1, -0.8));
    this.state = PopupState.SUMMARY;
    this.timer = 0;
    this.dispatchEvent({ type: 'summary', score: s });
  }

  update(dt) {
    if (!this.active) return;
    this.timer += dt;
    if (this.state === PopupState.COUNTDOWN) {
      const beat = Math.floor(this.timer / COUNTDOWN_BEAT);
      if (beat !== this.beat) {
        this.beat = beat;
        if (beat < 3) {
          this.hud.show(String(3 - beat), 'Pop-up outlaws · get ready', '#fff2d8', true);
          this.sfx.countdownTick(beat === 2);
        } else this.#play();
      }
    } else if (this.state === PopupState.PLAY) {
      // Refresh the sign a few times a second (not every frame).
      const left = Math.ceil(this.timeLeft);
      const text = `0:${String(left).padStart(2, '0')}`;
      const sub = `${this.score.points} pts · ${this.score.hits} hit · ${this.score.missed} got away`;
      if (this.timer > 0.8 && text + sub !== this.lastShown) {
        this.lastShown = text + sub;
        this.hud.show(text, sub, left <= 5 ? '#ff8a6b' : '#ffe7b0');
      }
      if (this.timer >= this.duration) this.#finish();
    } else if (this.state === PopupState.SUMMARY && this.timer >= SUMMARY_TIME) {
      this.stop();
    }
  }
}
