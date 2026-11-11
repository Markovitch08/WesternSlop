import * as THREE from 'three';

const KEY = 'westernslop.records.v1';

const EMPTY = { duelBestDraw: null, duelBestRounds: 0, duelChampion: false, popupBest: 0 };

/**
 * Best results, kept between sessions in localStorage: fastest duel draw,
 * furthest duel ladder run (and whether you've beaten all five), best pop-up
 * score. Dispatches { type: 'record', key, value } when one is beaten.
 */
export class Records extends THREE.EventDispatcher {
  constructor() {
    super();
    this.values = { ...EMPTY };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (saved && typeof saved === 'object') Object.assign(this.values, saved);
    } catch { /* storage blocked */ }
  }

  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch { /* storage blocked */ }
  }

  #beat(key, value) {
    this.values[key] = value;
    this.#save();
    this.dispatchEvent({ type: 'record', key, value });
    return true;
  }

  /** @returns {boolean} true if it's a new record */
  duelDraw(time) {
    const best = this.values.duelBestDraw;
    return best == null || time < best ? this.#beat('duelBestDraw', time) : false;
  }

  duelRun(rounds, champion) {
    let beat = false;
    if (champion && !this.values.duelChampion) beat = this.#beat('duelChampion', true) || beat;
    if (rounds > this.values.duelBestRounds) beat = this.#beat('duelBestRounds', rounds) || beat;
    return beat;
  }

  popupScore(points) {
    return points > this.values.popupBest ? this.#beat('popupBest', points) : false;
  }

  /** One line for the scoreboard. */
  summary() {
    const v = this.values;
    const draw = v.duelBestDraw != null ? `${v.duelBestDraw.toFixed(2)} s` : '—';
    const ladder = v.duelChampion ? '5/5 ★' : `${v.duelBestRounds}/5`;
    return `Records · draw ${draw} · ladder ${ladder} · pop-ups ${v.popupBest || '—'}`;
  }

  /** Wire to the game modes. */
  watch(duel, popups, hud) {
    duel.addEventListener('roundWon', ({ time }) => {
      if (this.duelDraw(time)) hud.show(hud.text, `${hud.sub.split('\n')[0]}\nNEW RECORD DRAW!`, '#9be37a');
    });
    duel.addEventListener('summary', ({ wins, champion }) => {
      if (this.duelRun(wins, champion)) hud.show(hud.text, `${hud.sub.split('\n')[0]}\nNEW RECORD!`, '#ffd36b');
    });
    popups.addEventListener('summary', ({ score }) => {
      if (this.popupScore(score.points)) hud.show(hud.text, `${hud.sub.split('\n')[0]}\nNEW HIGH SCORE!`, '#ffd36b');
    });
  }
}
