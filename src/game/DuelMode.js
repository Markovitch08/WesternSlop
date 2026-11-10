import * as THREE from 'three';
import { RevolverState } from '../weapons/Revolver.js';

/**
 * Quick-draw duel mode: a ladder of outlaws, each faster than the last.
 *
 * Shoot the black DUEL plate to start. Each round:
 *   holster    the gun must be holstered (and loaded) before the countdown
 *   countdown  3 · 2 · 1, one beat per second
 *   wait       a random pause, so the draw can't be timed off the countdown
 *   draw       "DRAW!" + bell; an outlaw springs up and fires after his draw
 *              time. Hit him first to win the round; your time is from the
 *              signal to the hit.
 *   result     a couple of seconds to read the outcome
 * Touching the gun before "DRAW!" is a foul: the round restarts.
 * Losing a round ends the run; beating all outlaws wins it. Free-range random
 * pop-ups are paused while a duel runs.
 */
export const DuelState = Object.freeze({
  IDLE: 'idle',
  HOLSTER: 'holster',
  COUNTDOWN: 'countdown',
  WAIT: 'wait',
  DRAW: 'draw',
  RESULT: 'result',
  SUMMARY: 'summary',
});

/** Seconds from "DRAW!" until each outlaw fires. */
export const OUTLAW_DRAW_TIMES = [1.5, 1.25, 1.05, 0.9, 0.8];
const OUTLAW_NAMES = ['Dusty Pete', 'One-Eyed Jack', 'Black Bart', 'The Kid', 'Ma Barker'];

const COUNTDOWN_BEAT = 1.0; // s per number
const RESULT_TIME = 2.6; // s to read a round's outcome
const SUMMARY_TIME = 4.5; // s to read the final result
const OUTLAW_STANDS = 0.6; // s the outlaw stays up after firing

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class DuelMode extends THREE.EventDispatcher {
  /**
   * @param {object} deps
   * @param {import('../targets/TargetManager.js').TargetManager} deps.targets
   * @param {import('../weapons/Revolver.js').Revolver} deps.revolver
   * @param {import('../audio/SoundFX.js').SoundFX} deps.sfx
   * @param {import('../xr/XRManager.js').XRManager} deps.xr
   * @param {import('../ui/DuelHUD.js').DuelHUD} deps.hud
   * @param {import('../fx/ParticleFX.js').ParticleFX} [deps.fx]
   * @param {THREE.Camera} deps.camera
   */
  constructor({ targets, revolver, sfx, xr, hud, fx = null, camera }) {
    super();
    Object.assign(this, { targets, revolver, sfx, xr, hud, fx, camera });
    this.state = DuelState.IDLE;
    this.timer = 0;
    this.round = 0;
    this.results = []; // { won, time, outlawTime, zone }
    this.fouls = 0;
    this.best = null;
    /** Random pause between "1" and "DRAW!", seconds. */
    this.waitRange = [0.6, 2.2];
    this.opponent = null;
    this.drawTime = 0; // time since "DRAW!"
    this.outlawFired = false;
    this.lastBeat = 0;
    this.freeRangeWasEnabled = true;

    this.pendingWin = false;
    targets.addEventListener('duelStart', () => this.start());
    // TargetManager reports 'duelResolved' (which duelist, how) before the
    // scored 'hit' report (zone, reaction time) for the same bullet.
    targets.addEventListener('duelResolved', ({ duelist, outcome }) => this.#onResolved(duelist, outcome));
    targets.addEventListener('hit', ({ report }) => this.#onHit(report));
    revolver.addEventListener('grab', () => this.#onGrab());
  }

  get active() {
    return this.state !== DuelState.IDLE;
  }

  get outlawTime() {
    return OUTLAW_DRAW_TIMES[Math.min(this.round, OUTLAW_DRAW_TIMES.length - 1)];
  }

  start() {
    if (this.active) return;
    this.freeRangeWasEnabled = this.targets.duelEnabled;
    this.targets.duelEnabled = false;
    this.round = 0;
    this.results = [];
    this.fouls = 0;
    this.#enter(DuelState.HOLSTER);
    this.dispatchEvent({ type: 'start' });
  }

  /** Abort and return to free play. */
  stop() {
    if (!this.active) return;
    this.opponent?.retire();
    this.opponent = null;
    this.state = DuelState.IDLE;
    this.hud.hide();
    this.targets.duelEnabled = this.freeRangeWasEnabled;
    this.dispatchEvent({ type: 'end', results: this.results });
  }

  #enter(state) {
    this.state = state;
    this.timer = 0;
    const n = this.round + 1;
    const name = OUTLAW_NAMES[this.round % OUTLAW_NAMES.length];
    if (state === DuelState.HOLSTER) this.#promptHolster(n, name);
    else if (state === DuelState.COUNTDOWN) {
      this.lastBeat = 0;
      this.#beat(3);
    } else if (state === DuelState.WAIT) {
      this.waitFor = this.waitRange[0] + Math.random() * (this.waitRange[1] - this.waitRange[0]);
      this.hud.show('…', `${name} is waiting`, '#ffe7b0');
    } else if (state === DuelState.DRAW) this.#signalDraw();
  }

  #promptHolster(n, name) {
    const loaded = this.revolver.chambers.some((c) => c === 'live');
    const who = `vs ${name} · draws in ${this.outlawTime.toFixed(2)} s`;
    if (!loaded) this.hud.show('LOAD UP', `Round ${n}: load your gun, then holster it\n${who}`, '#ffd36b');
    else this.hud.show(`ROUND ${n}`, `Holster your gun\n${who}`, '#ffd36b');
  }

  #beat(number) {
    this.hud.show(String(number), '', '#fff2d8', true);
    this.sfx.countdownTick(number === 1);
  }

  #signalDraw() {
    const free = this.targets.duelists.filter((d) => d.state === 'down');
    const pool = free.length ? free : this.targets.duelists;
    this.opponent = pool[Math.floor(Math.random() * pool.length)];
    const i = this.targets.duelists.indexOf(this.opponent);
    this.targets.forcePopup(i);
    this.drawTime = 0;
    this.outlawFired = false;
    this.pendingWin = false;
    this.hud.show('DRAW!', '', '#ff6b4a', true);
    this.sfx.bell(this.opponent.object.position);
    this.dispatchEvent({ type: 'draw', round: this.round, opponent: i });
  }

  #onGrab() {
    if (this.state !== DuelState.COUNTDOWN && this.state !== DuelState.WAIT) return;
    this.fouls++;
    this.hud.show('JUMPED THE GUN', 'Wait for "DRAW!"\nHolster to restart the round', '#ff8a6b');
    this.sfx.dryFire();
    this.state = DuelState.HOLSTER; // keep the foul message up until re-holstered
    this.timer = 0;
    this.dispatchEvent({ type: 'foul' });
  }

  #onResolved(duelist, outcome) {
    if (this.state !== DuelState.DRAW || this.outlawFired || duelist !== this.opponent) return;
    if (outcome === 'hit') this.pendingWin = true; // the scored report follows
    else if (outcome === 'knocked') this.#win(this.drawTime, 'KNOCKED OUT', null); // a thrown gun
  }

  #onHit(report) {
    if (!this.pendingWin || report.type !== 'duelist') return;
    this.pendingWin = false;
    this.#win(report.reaction, report.label, report.zone);
  }

  #win(time, label, zone) {
    this.results.push({ won: true, time, outlawTime: this.outlawTime, zone });
    this.best = Math.min(this.best ?? Infinity, time);
    const margin = this.outlawTime - time;
    this.hud.show(`${time.toFixed(2)} s`, `${label} · beat him by ${margin.toFixed(2)} s`, '#9be37a');
    this.opponent = null;
    this.round++;
    this.#enter(DuelState.RESULT);
    this.dispatchEvent({ type: 'roundWon', time, round: this.round });
  }

  #outlawFires() {
    this.outlawFired = true;
    const d = this.opponent;
    // His gun hand: right of his chest, firing at the player's head.
    d.board.localToWorld(_v.set(0.24, 1.05, 0.08));
    const head = this.camera.getWorldPosition(new THREE.Vector3());
    this.sfx.outlawShot(_v.clone());
    this.fx?.muzzle(_v.clone(), head.clone().sub(_v).normalize());
    this.hud.hurt();
    for (const h of this.xr.hands) if (h.connected) this.xr.pulse(h, 1.0, 220);
    this.results.push({ won: false, time: null, outlawTime: this.outlawTime, zone: null });
    this.hud.show("YOU'RE DEAD", `${OUTLAW_NAMES[this.round % OUTLAW_NAMES.length]} drew in ${this.outlawTime.toFixed(2)} s`, '#ff5a3c');
    this.#enter(DuelState.RESULT);
    this.dispatchEvent({ type: 'roundLost', round: this.round });
  }

  update(dt) {
    if (this.active) this.#step(dt);
    // After the state machine, so a flash or pop starts on the frame it happens.
    this.hud.update(dt);
  }

  #step(dt) {
    this.timer += dt;
    const rev = this.revolver;
    const holstered = rev.state === RevolverState.HOLSTERED;

    switch (this.state) {
      case DuelState.HOLSTER:
        if (holstered && rev.chambers.some((c) => c === 'live')) this.#enter(DuelState.COUNTDOWN);
        else if (this.timer > 0.5 && !this.hud.text.startsWith('JUMPED')) {
          this.timer = 0;
          this.#promptHolster(this.round + 1, OUTLAW_NAMES[this.round % OUTLAW_NAMES.length]);
        }
        break;

      case DuelState.COUNTDOWN: {
        const beat = Math.floor(this.timer / COUNTDOWN_BEAT);
        if (beat !== this.lastBeat) {
          this.lastBeat = beat;
          if (beat < 3) this.#beat(3 - beat);
          else this.#enter(DuelState.WAIT);
        }
        break;
      }

      case DuelState.WAIT:
        if (this.timer >= this.waitFor) this.#enter(DuelState.DRAW);
        break;

      case DuelState.DRAW:
        this.drawTime += dt;
        if (this.drawTime >= this.outlawTime && this.opponent?.isLive) this.#outlawFires();
        break;

      case DuelState.RESULT: {
        if (this.opponent && this.outlawFired && this.timer > OUTLAW_STANDS) {
          this.opponent.retire();
          this.opponent = null;
        }
        if (this.timer < RESULT_TIME) break;
        const lost = this.results.at(-1)?.won === false;
        if (lost || this.round >= OUTLAW_DRAW_TIMES.length) this.#summary();
        else this.#enter(DuelState.HOLSTER);
        break;
      }

      case DuelState.SUMMARY:
        if (this.timer >= SUMMARY_TIME) this.stop();
        break;
    }
  }

  #summary() {
    const wins = this.results.filter((r) => r.won).length;
    const champion = wins >= OUTLAW_DRAW_TIMES.length;
    const best = this.best != null ? `best draw ${this.best.toFixed(2)} s` : 'no hits';
    this.hud.show(
      champion ? 'FASTEST GUN' : `${wins} / ${OUTLAW_DRAW_TIMES.length}`,
      champion ? `in the West · ${best}` : `outlaws beaten · ${best} · shoot DUEL to go again`,
      champion ? '#ffd36b' : '#ffe7b0',
    );
    this.state = DuelState.SUMMARY;
    this.timer = 0;
    this.dispatchEvent({ type: 'summary', wins, champion });
  }
}
