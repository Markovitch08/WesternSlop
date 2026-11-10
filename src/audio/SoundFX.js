import * as THREE from 'three';

const SPEED_OF_SOUND = 343; // m/s
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Synthesised sound effects (Web Audio, no asset files).
 *
 * The AudioContext can only start after a user gesture, so call unlock() from
 * a click / XR session start. Every play method is a no-op until then.
 *
 * Impact sounds are positional (equal-power panning, distance roll-off) and
 * arrive late by distance / speed of sound: a steel gong at 25 m rings ~70 ms
 * after the shot, like on a real range.
 */
export class SoundFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.outdoor = null;
    this.listenerPos = new THREE.Vector3();
    /** Counts of each sound played; handy for tests and debugging. */
    this.played = {};
  }

  #count(name) {
    this.played[name] = (this.played[name] ?? 0) + 1;
  }

  /** Keep the Web Audio listener on the player's head. Call once per frame. */
  updateListener(camera) {
    camera.getWorldPosition(_pos);
    this.listenerPos.copy(_pos);
    if (!this.ctx) return;
    camera.getWorldQuaternion(_quat);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(_pos.x, t);
      l.positionY.setValueAtTime(_pos.y, t);
      l.positionZ.setValueAtTime(_pos.z, t);
      l.forwardX.setValueAtTime(_fwd.x, t);
      l.forwardY.setValueAtTime(_fwd.y, t);
      l.forwardZ.setValueAtTime(_fwd.z, t);
      l.upX.setValueAtTime(_up.x, t);
      l.upY.setValueAtTime(_up.y, t);
      l.upZ.setValueAtTime(_up.z, t);
    } else {
      l.setPosition(_pos.x, _pos.y, _pos.z);
      l.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  /**
   * A panner at `position` feeding the master bus, plus the start time
   * delayed by the sound's travel time to the listener.
   */
  #spatial(position, gain = 1) {
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower'; // HRTF is too heavy for standalone headsets
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.rolloffFactor = 0.7;
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
    return { dest: g, t: ctx.currentTime + delay };
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.#build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
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
    this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);

    // Two seconds of white noise, reused by every effect.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Outdoor acoustics for the gunshot. There's no room out here: what you
    // hear after the bang is a handful of distinct, smeared, high-cut echoes
    // off the saloon and the distant mesas, and a low rolling tail. All of it
    // lives in one convolution impulse response (no feedback loops, so nothing
    // repeats at a fixed interval).
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this.#outdoorResponse();
    // High-pass the send: the sub-bass boom stays dry and close; only the
    // crack and blast carry far enough to come back as echoes.
    const sendHp = ctx.createBiquadFilter();
    sendHp.type = 'highpass';
    sendHp.frequency.value = 250;
    sendHp.Q.value = 0.7;
    const outdoorOut = ctx.createGain();
    outdoorOut.gain.value = 0.5;
    sendHp.connect(conv).connect(outdoorOut).connect(this.master);
    this.outdoor = sendHp;
    /** Level of the echoes (0 = dry gunshot). */
    this.outdoorLevel = outdoorOut.gain;

    // Soft clipper for the gunshot bus: adds weight and punch to the boom.
    const shaper = ctx.createWaveShaper();
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 2.2;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.shotShaper = shaper;
  }

  /**
   * Stereo impulse response of the open range (no direct sound):
   *  - saloon facade, 32 m away: a fairly bright echo at ~0.19 s
   *  - a gully to the left at ~95 m: faint echo at ~0.55 s
   *  - mesas at 200–230 m, left and right: dark, smeared echoes at ~1.15–1.35 s
   *  - a low "rolling thunder" wash underneath
   * Each echo is band-limited noise with a short rise and exponential decay,
   * scaled so its energy equals gain² (the convolver doesn't normalise).
   */
  #outdoorResponse() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 3.2);
    const buf = ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    const addBurst = (t0, gain, cutoff, rise, decay, pan) => {
      const start = Math.floor(t0 * sr);
      const n = Math.min(len - start, Math.floor((rise + decay * 5) * sr));
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      for (const [ch, chGain] of [[L, Math.sqrt((1 - pan) / 2)], [R, Math.sqrt((1 + pan) / 2)]]) {
        const tmp = new Float32Array(n);
        let s1 = 0;
        let s2 = 0;
        let energy = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const env = t < rise ? t / rise : Math.exp(-(t - rise) / decay);
          s1 += a * ((Math.random() * 2 - 1) - s1); // two one-pole low-passes
          s2 += a * (s1 - s2);
          tmp[i] = s2 * env;
          energy += tmp[i] * tmp[i];
        }
        const k = (gain * chGain * Math.SQRT2) / Math.sqrt(energy || 1);
        for (let i = 0; i < n; i++) ch[start + i] += tmp[i] * k;
      }
    };

    addBurst(0.187, 0.3, 2600, 0.008, 0.045, 0.15); // saloon
    addBurst(0.55, 0.1, 1500, 0.02, 0.1, -0.4); // gully
    addBurst(1.16, 0.18, 900, 0.05, 0.18, -0.65); // mesa left
    addBurst(1.34, 0.13, 750, 0.06, 0.22, 0.6); // mesa right
    addBurst(0.08, 0.16, 380, 0.3, 0.9, 0); // rolling tail
    return buf;
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
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /**
   * Black-powder revolver report: a supersonic crack, a long dark blast, a
   * sub-bass boom you feel in the chest, soft-clipped for weight, then the
   * desert answers: an echo off the saloon and late, dark ones off the mesas.
   */
  gunshot() {
    this.#count('gunshot');
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 1.1;
    const post = ctx.createGain();
    post.gain.value = 0.85;
    bus.connect(this.shotShaper).connect(post).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    post.connect(send).connect(this.outdoor);

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
    const { dest, t } = this.#spatial(position, 1.2);
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

  /** Empty brass case hitting something: short bright ring. */
  brassTink(position, speed = 1) {
    this.#count('brass');
    if (!this.ctx) return;
    const { dest, t } = this.#spatial(position, Math.min(0.9, 0.25 + speed * 0.25));
    const f = 3400 + Math.random() * 1600;
    this.#tone(t, 0.22, 'sine', f, f, 0.3, dest);
    this.#tone(t, 0.14, 'sine', f * 1.51, f * 1.5, 0.15, dest);
    this.#tone(t, 0.08, 'sine', f * 2.37, f * 2.35, 0.08, dest);
  }

  /** Fingers in the leather cartridge pouch. */
  pouch() {
    this.#count('pouch');
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.09, 'bandpass', 1200, 700, 0.25);
    this.#noiseBurst(t + 0.05, 0.03, 'highpass', 4000, 3500, 0.15);
  }
}
