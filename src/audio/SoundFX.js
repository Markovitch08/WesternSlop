import * as THREE from 'three';

const SPEED_OF_SOUND = 343; // m/s
const _pos = new THREE.Vector3();

/**
 * Synthesised sound effects (Web Audio, no asset files).
 *
 * AudioEnvironment owns the AudioContext and the THREE.AudioListener on the
 * headset; once audio is unlocked it calls attach() and every effect plays
 * into the listener. Until then every play method is a no-op (but is still
 * counted in `played`, which tests use).
 *
 * Impact sounds are positional (equal-power panning) and arrive late by
 * distance / speed of sound: a steel gong at 25 m rings ~70 ms after the shot.
 * Gongs fade with exponential distance decay; most else with inverse roll-off.
 * The gunshot's snap is placed at the muzzle; its echoes come back from the
 * terrain via AudioEnvironment's echo emitters.
 */
export class SoundFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.echoSend = null;
    this.listenerPos = new THREE.Vector3();
    /** Last panner created (debugging and tests). */
    this.lastPanner = null;
    /**
     * Per-sound nodes waiting to be disconnected: [{ nodes, until }]. Every
     * sound builds a short-lived chain into the shared bus; leaving those
     * chains connected makes the graph grow for as long as you play.
     */
    this.pending = [];
    /** Effects volume 0..1 (settings). */
    this.volume = 1;
    /** Chains disconnected so far (tests and debugging). */
    this.disposed = 0;
    /** Counts of each sound played; handy for tests and debugging. */
    this.played = {};
  }

  #count(name) {
    this.played[name] = (this.played[name] ?? 0) + 1;
  }

  /**
   * Track the player's head for travel-time delays. (The Web Audio listener
   * itself is moved by the THREE.AudioListener on the camera.)
   */
  updateListener(camera) {
    camera.getWorldPosition(_pos);
    this.listenerPos.copy(_pos);
    this.sweep();
  }

  /** Effects volume, 0..1. */
  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = 0.9 * v; // a 10% step: no ramp needed
  }

  /** Disconnect per-sound nodes whose sound has finished (by the audio clock). */
  sweep() {
    if (!this.ctx || !this.pending.length) return;
    const now = this.ctx.currentTime;
    let keep = 0;
    for (const item of this.pending) {
      if (item.until <= now) {
        for (const n of item.nodes) n.disconnect();
        this.disposed++;
      } else {
        this.pending[keep++] = item;
      }
    }
    this.pending.length = keep;
  }

  /** Disconnect `nodes` once a sound starting at `t` is surely over. */
  #disposeLater(nodes, t, length = 4) {
    this.pending.push({ nodes, until: t + length });
  }

  /**
   * A panner at `position` feeding the master bus, plus the start time
   * delayed by the sound's travel time to the listener.
   */
  #spatial(position, gain = 1, { model = 'inverse', ref = 3, rolloff = 0.7 } = {}) {
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower'; // HRTF is too heavy for standalone headsets
    p.distanceModel = model;
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    this.lastPanner = p;
    if (p.positionX) {
      p.positionX.value = position.x;
      p.positionY.value = position.y;
      p.positionZ.value = position.z;
    } else {
      p.setPosition(position.x, position.y, position.z);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    g.connect(p).connect(this.master);
    const delay = position.distanceTo(this.listenerPos) / SPEED_OF_SOUND;
    const t = ctx.currentTime + delay;
    this.#disposeLater([g, p], t);
    return { dest: g, t };
  }

  /**
   * Start playing into `output` (the listener's input) on `ctx`.
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} output
   * @param {AudioNode} [echoSend] where gunshots send their echo feed
   */
  attach(ctx, output, echoSend = null) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.output = output;
    this.echoSend = echoSend;
    this.#build();
  }

  #build() {
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9 * this.volume;
    this.master.connect(comp).connect(this.output);

    // Two seconds of white noise, reused by every effect.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Soft clipper for the gunshot bus: adds weight and punch to the boom.
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 2.2;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    // Only the curve is shared: each shot gets its own shaper node (a shared
    // node would gain one more output chain per shot and never lose it).
    this.shotCurve = curve;
  }

  #noiseBurst(t, dur, filterType, freqStart, freqEnd, gain, dest = this.master) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freqStart, t);
    f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  #tone(t, dur, type, freqStart, freqEnd, gain, dest = this.master) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freqStart, t);
    o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.onended = () => { o.disconnect(); g.disconnect(); };
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /**
   * Black-powder revolver report: a supersonic crack, a long dark blast, a
   * sub-bass boom you feel in the chest, soft-clipped for weight. It sounds
   * from the muzzle (`position`); faint echoes come back off the terrain via
   * the echo send.
   * @param {THREE.Vector3} [position] muzzle, world space
   */
  gunshot(position = null) {
    this.#count('gunshot');
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 1.1;
    const post = ctx.createGain();
    post.gain.value = 0.85;
    // At arm's length: barely any distance loss, just placement.
    const out = position ? this.#spatial(position, 1, { ref: 1, rolloff: 0.05 }).dest : this.master;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.shotCurve;
    shaper.oversample = '2x';
    bus.connect(shaper).connect(post).connect(out);
    if (this.echoSend) post.connect(this.echoSend);
    this.#disposeLater([bus, shaper, post], t);

    this.#noiseBurst(t, 0.04, 'highpass', 3000, 1800, 0.9, bus); // crack
    this.#noiseBurst(t, 0.22, 'bandpass', 900, 220, 1.0, bus); // mid punch
    this.#noiseBurst(t, 0.9, 'lowpass', 3500, 90, 1.2, bus); // long blast body
    this.#tone(t, 0.6, 'sine', 95, 32, 1.4, bus); // sub boom
    this.#tone(t, 1.0, 'sine', 58, 26, 1.0, bus); // low rumble
    this.#tone(t, 0.12, 'triangle', 180, 60, 0.6, bus); // chest thump attack
  }

  /** Revolver landing on something: steel clank plus the surface's own thud. */
  gunClatter(position, surface, speed) {
    this.#count('clatter');
    if (!this.ctx) return;
    const level = Math.min(1, speed / 4);
    const { dest, t } = this.#spatial(position, 0.4 + level * 0.8);
    const f = 900 + Math.random() * 300;
    this.#tone(t, 0.18, 'triangle', f, f * 0.97, 0.35, dest);
    this.#tone(t, 0.12, 'sine', f * 2.7, f * 2.6, 0.18, dest);
    this.#noiseBurst(t, 0.04, 'highpass', 3500, 2500, 0.4, dest);
    if (surface === 'sand') this.#noiseBurst(t, 0.12, 'lowpass', 500, 120, 0.6, dest);
    else if (surface === 'wood') this.#noiseBurst(t, 0.08, 'bandpass', 900, 400, 0.6, dest);
  }

  /** Metallic click: hammer cock, dry fire, cylinder detent. */
  click(pitch = 1, gain = 0.35) {
    this.#count('click');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.025, 'highpass', 3500 * pitch, 2500 * pitch, gain);
    this.#tone(t, 0.03, 'triangle', 2600 * pitch, 1800 * pitch, gain * 0.4);
  }

  /** Two-stage hammer cock: sear click then cylinder bolt. */
  hammerCock() {
    if (!this.ctx) return;
    this.click(0.9, 0.3);
    setTimeout(() => this.click(1.2, 0.25), 45);
  }

  dryFire() {
    this.click(0.7, 0.45);
  }

  /** Leather thud when the gun drops into the holster. */
  holster() {
    this.#count('holster');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.08, 'lowpass', 900, 200, 0.4);
  }

  // -------------------------------------------------------------------------
  // Positional impacts
  // -------------------------------------------------------------------------

  /** Ringing steel plate. Smaller plates ring higher. */
  steelPing(position, radius = 0.2) {
    this.#count('steel');
    if (!this.ctx) return;
    // Exponential distance decay: (d / 2 m) ^ -0.9.
    const { dest, t } = this.#spatial(position, 1.5, { model: 'exponential', ref: 2, rolloff: 0.9 });
    const f = 170 / radius;
    // Inharmonic partials of a free circular plate.
    const partials = [[1, 0.5, 1.8], [2.32, 0.28, 1.1], [4.25, 0.16, 0.7], [6.63, 0.08, 0.45]];
    for (const [ratio, gain, decay] of partials) this.#tone(t, decay, 'sine', f * ratio, f * ratio * 0.995, gain, dest);
    this.#noiseBurst(t, 0.03, 'highpass', 4000, 3000, 0.6, dest);
  }

  /** Bullet into wood: dull knock plus splinter crackle. */
  woodHit(position) {
    this.#count('wood');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 1.1);
    this.#noiseBurst(t, 0.12, 'bandpass', 1100, 400, 0.9, dest);
    this.#tone(t, 0.09, 'triangle', 220, 90, 0.5, dest);
    for (let i = 0; i < 5; i++) this.#noiseBurst(t + Math.random() * 0.09, 0.012, 'highpass', 5000, 3500, 0.3, dest);
  }

  /** Bottle bursting: a cluster of bright shards and tinkles. */
  glassShatter(position) {
    this.#count('glass');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 1.3);
    this.#noiseBurst(t, 0.06, 'highpass', 6000, 3000, 0.9, dest);
    for (let i = 0; i < 16; i++) {
      const dt = Math.pow(Math.random(), 1.6) * 0.4;
      const f = 3000 + Math.random() * 6000;
      this.#noiseBurst(t + dt, 0.02 + Math.random() * 0.04, 'bandpass', f, f * 0.9, 0.5 * (1 - dt), dest);
    }
    for (let i = 0; i < 5; i++) {
      const f = 3500 + Math.random() * 3000;
      this.#tone(t + 0.05 + Math.random() * 0.35, 0.15, 'sine', f, f, 0.12, dest);
    }
  }

  /** Bullet into sand or dirt. */
  sandHit(position) {
    this.#count('sand');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 0.8);
    this.#noiseBurst(t, 0.16, 'lowpass', 700, 150, 0.7, dest);
  }

  /** Bullet into a cactus: soft wet thwack. */
  plantHit(position) {
    this.#count('plant');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 0.9);
    this.#noiseBurst(t, 0.08, 'bandpass', 800, 300, 0.7, dest);
  }

  /** Surface impact by `userData.surface` tag. */
  surfaceHit(surface, position) {
    if (surface === 'wood') this.woodHit(position);
    else if (surface === 'steel') this.steelPing(position, 0.3);
    else if (surface === 'plant') this.plantHit(position);
    else this.sandHit(position);
  }

  /** Range bell: the duel cue. */
  bell(position) {
    this.#count('bell');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 0.8);
    for (const [ratio, gain, decay] of [[1, 0.5, 1.4], [2.0, 0.25, 0.9], [3.01, 0.12, 0.6], [4.1, 0.06, 0.4]]) {
      this.#tone(t, decay, 'sine', 1040 * ratio, 1040 * ratio, gain, dest);
    }
  }

  /** Spring-loaded target slapping upright. */
  clack(position) {
    this.#count('clack');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 0.9);
    this.#noiseBurst(t, 0.06, 'bandpass', 1400, 700, 0.7, dest);
    this.#tone(t, 0.06, 'square', 160, 90, 0.15, dest);
  }

  // -------------------------------------------------------------------------
  // Reloading
  // -------------------------------------------------------------------------

  /** Crane unlatches and the cylinder swings out. */
  cylinderOpen() {
    this.#count('cylinderOpen');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.03, 'highpass', 3000, 2200, 0.4);
    this.#tone(t + 0.02, 0.08, 'triangle', 700, 500, 0.25);
  }

  /** Cylinder snapping shut into the frame. */
  cylinderClose() {
    this.#count('cylinderClose');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.04, 'bandpass', 2400, 1600, 0.6);
    this.#tone(t, 0.06, 'triangle', 520, 380, 0.35);
  }

  /** Ejector rod stroke as the spent cases drop out. */
  ejectorRod() {
    this.#count('ejector');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.07, 'bandpass', 1800, 1200, 0.3);
  }

  /** A cartridge sliding home in a chamber. */
  roundInsert() {
    this.#count('insert');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.05, 'bandpass', 2600, 3400, 0.25);
    this.#tone(t + 0.04, 0.03, 'triangle', 2200, 1700, 0.2);
  }

  /**
   * Empty brass case landing. On dirt it's a dull tick with almost no ring
   * (the sand swallows it); on floorboards a hollow knock and a short ring; on
   * steel or another case a bright, longer ring.
   * @param {'sand'|'wood'|'steel'|string} surface
   */
  brassTink(position, speed = 1, surface = 'sand') {
    this.#count('brass');
    this.#count(`brass:${surface}`);
    if (!this.ctx) return;
    const level = Math.min(0.9, 0.25 + speed * 0.25);
    const { dest, t } = this.#spatial(position, level, { ref: 1.5, rolloff: 1 });
    const f = 3400 + Math.random() * 1600;
    if (surface === 'sand') {
      this.#noiseBurst(t, 0.03, 'lowpass', 1800, 600, 0.5, dest);
      this.#tone(t, 0.05, 'sine', f, f, 0.06, dest);
    } else if (surface === 'wood') {
      this.#noiseBurst(t, 0.05, 'bandpass', 900, 500, 0.6, dest);
      this.#tone(t, 0.04, 'triangle', 320, 240, 0.25, dest);
      this.#tone(t, 0.12, 'sine', f, f, 0.18, dest);
    } else {
      this.#tone(t, 0.3, 'sine', f, f, 0.3, dest);
      this.#tone(t, 0.18, 'sine', f * 1.51, f * 1.5, 0.15, dest);
      this.#tone(t, 0.1, 'sine', f * 2.37, f * 2.35, 0.08, dest);
    }
  }

  /** Fingers in the leather cartridge pouch. */
  pouch() {
    this.#count('pouch');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.09, 'bandpass', 1200, 700, 0.25);
    this.#noiseBurst(t + 0.05, 0.03, 'highpass', 4000, 3500, 0.15);
  }

  // -------------------------------------------------------------------------
  // Duel mode
  // -------------------------------------------------------------------------

  /** Countdown beat: a dry wooden knock (lower and longer on the last beat). */
  countdownTick(last = false) {
    this.#count('tick');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = last ? 420 : 620;
    this.#tone(t, last ? 0.18 : 0.1, 'triangle', f, f * 0.8, 0.45);
    this.#noiseBurst(t, 0.03, 'bandpass', 1800, 1200, 0.35);
  }

  /** The outlaw firing back from downrange: a positional, more distant report. */
  outlawShot(position) {
    this.#count('outlawShot');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, 1.6);
    this.#noiseBurst(t, 0.04, 'highpass', 2600, 1600, 0.9, dest);
    this.#noiseBurst(t, 0.6, 'lowpass', 2800, 120, 1.0, dest);
    this.#tone(t, 0.4, 'sine', 80, 32, 0.8, dest);
    if (this.echoSend) {
      const send = this.ctx.createGain();
      send.gain.value = 0.5;
      dest.connect(send).connect(this.echoSend);
      this.#disposeLater([send], t);
    }
  }

  /** A revolver whirling round the trigger finger: a soft whoosh. */
  twirl() {
    this.#count('twirl');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.14, 'bandpass', 700, 1600, 0.18);
  }
}
