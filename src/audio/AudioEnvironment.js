import * as THREE from 'three';

const SPEED_OF_SOUND = 343;
const _head = new THREE.Vector3();

/**
 * The game's audio world.
 *
 *  - A THREE.AudioListener rides on the headset camera; three.js moves the Web
 *    Audio listener with it every frame (XR pose included).
 *  - A layered, non-positional ambient bed: canyon wind (it swells with the
 *    gusts), occasional creaks from the saloon's boards, and dry crickets.
 *  - Echo emitters: one THREE.PositionalAudio per big reflecting surface (the
 *    saloon front, each mesa face). A gunshot sent to `echoInput` comes back
 *    from each of them after its round-trip time, quieter and duller with
 *    distance. These replace any reverb: out here there is no room, only a few
 *    distinct, faint echoes.
 *
 * Browsers only start audio after a user gesture, so nothing is created until
 * unlock() (first click, trigger or grip press, or the XR session starting).
 */
export class AudioEnvironment {
  /**
   * @param {THREE.Camera} camera the player's head
   * @param {THREE.Scene} scene
   * @param {import('./SoundFX.js').SoundFX} sfx
   * @param {{ position: THREE.Vector3, reflectivity: number, name: string }[]} reflectors
   */
  constructor(camera, scene, sfx, reflectors = []) {
    this.camera = camera;
    this.scene = scene;
    this.sfx = sfx;
    this.reflectors = reflectors;
    this.listener = null;
    this.ctx = null;
    this.unlocked = false;
    this.layers = {};
    this.echoes = [];
    this.creakTimer = 3;
    this.wind = null;
    /** Overall echo level (0 mutes them). Kept low: a hint of space, not reverb. */
    this.echoLevel = 0.35;
  }

  /** Resume (or create) the AudioContext. Safe to call on every gesture. */
  unlock() {
    if (this.unlocked) return;
    if (!this.listener) {
      // A "balanced" output buffer: the default lowest-latency setting
      // underruns (audible hitches) on standalone headsets when the GPU is busy.
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const current = THREE.AudioContext.getContext();
        const offline = typeof OfflineAudioContext !== 'undefined' && current instanceof OfflineAudioContext;
        if (!offline && current.state !== 'running') {
          current.close?.();
          THREE.AudioContext.setContext(new Ctx({ latencyHint: 'balanced' }));
        }
      } catch { /* keep three's default context */ }
      this.listener = new THREE.AudioListener();
      this.camera.add(this.listener);
      this.ctx = this.listener.context;
    }
    const ready = () => {
      if (this.unlocked || this.ctx.state !== 'running') return;
      this.unlocked = true;
      this.#build();
    };
    // (An OfflineAudioContext, used to render and measure the mix, can't be
    // resumed before rendering; it is ready as is.)
    const offline = typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
    if (this.ctx.state === 'running' || offline) {
      this.unlocked = true;
      this.#build();
      return;
    }
    this.ctx.resume().then(ready, () => {});
  }

  /** Hook unlock() to the first user gestures (DOM, XR controller, XR session). */
  installUnlockHandlers(renderer, xr) {
    const once = () => this.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(type, once, { passive: true });
    renderer.xr.addEventListener('sessionstart', once);
    for (const type of ['selectstart', 'squeezestart']) xr.addEventListener(type, once);
  }

  #build() {
    const ctx = this.ctx;
    const out = this.listener.getInput();

    // Effects bus: SoundFX's master feeds the listener.
    this.echoInput = ctx.createGain();
    this.echoInput.gain.value = 1;
    this.sfx.attach(ctx, out, this.echoInput);

    this.#buildEchoes();
    this.#buildAmbience(out);
  }

  // -------------------------------------------------------------------------
  // Echoes
  // -------------------------------------------------------------------------
  #buildEchoes() {
    const ctx = this.ctx;
    // Only the crack and blast carry far enough to come back.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    this.echoInput.connect(hp);
    this.echoMaster = ctx.createGain();
    this.echoMaster.gain.value = this.echoLevel;
    hp.connect(this.echoMaster);

    for (const r of this.reflectors) {
      const delay = ctx.createDelay(4);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      const gain = ctx.createGain();
      this.echoMaster.connect(delay).connect(lp).connect(gain);

      const emitter = new THREE.PositionalAudio(this.listener);
      emitter.setNodeSource(gain);
      // The path loss is applied by hand (below) from the true round trip, so
      // the panner only places it in space.
      emitter.setRolloffFactor(0);
      emitter.panner.panningModel = 'equalpower';
      emitter.position.copy(r.position);
      emitter.name = `echo:${r.name}`;
      this.scene.add(emitter);
      this.echoes.push({ reflector: r, emitter, delay, lp, gain });
    }
    this.#retuneEchoes(true);
  }

  /**
   * Delay, level and air absorption for each echo from where the player
   * stands. Only when the head has moved a fair way: changing a delay line
   * every frame both floods the audio thread with automation events and
   * bends the pitch of anything passing through it.
   */
  #retuneEchoes(force = false) {
    if (!this.echoes.length) return;
    this.camera.getWorldPosition(_head);
    if (!force && this.tunedAt && _head.distanceTo(this.tunedAt) < 0.5) return;
    this.tunedAt = (this.tunedAt ?? new THREE.Vector3()).copy(_head);
    const t = this.ctx.currentTime;
    for (const e of this.echoes) {
      const path = 2 * _head.distanceTo(e.reflector.position); // out and back
      e.path = path;
      e.delay.delayTime.setTargetAtTime(path / SPEED_OF_SOUND, t, 0.05);
      e.gain.gain.setTargetAtTime(e.reflector.reflectivity * Math.min(1, 10 / path), t, 0.05);
      e.lp.frequency.setTargetAtTime(Math.max(500, 7000 * Math.exp(-path / 180)), t, 0.05);
    }
  }

  // -------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------
  #buildAmbience(out) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;

    // Canyon wind: 4 s of brown noise (seamlessly looped), low-passed, its level
    // and brightness following the gusts.
    const windBuf = loopBuffer(ctx, 4, (n) => {
      const d = new Float32Array(n);
      let b = 0;
      for (let i = 0; i < n; i++) {
        b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = b * 3.5;
      }
      return d;
    });
    const wind = new THREE.Audio(this.listener);
    wind.setBuffer(windBuf);
    wind.setLoop(true);
    wind.setVolume(0.35);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 450;
    this.windWhistle = ctx.createBiquadFilter();
    this.windWhistle.type = 'bandpass';
    this.windWhistle.frequency.value = 900;
    this.windWhistle.Q.value = 6;
    wind.setFilters([this.windFilter]);
    wind.play();
    this.layers.wind = wind;

    // A faint whistle through the boards, on the same noise.
    const whistle = new THREE.Audio(this.listener);
    whistle.setBuffer(windBuf);
    whistle.setLoop(true);
    whistle.setVolume(0.05);
    whistle.setFilters([this.windWhistle]);
    whistle.offset = 2.7;
    whistle.play();
    this.layers.whistle = whistle;

    // Crickets: a 6 s loop of chirp trains at a few pitches, panned wide.
    const crickets = new THREE.Audio(this.listener);
    crickets.setBuffer(cricketBuffer(ctx, 6));
    crickets.setLoop(true);
    crickets.setVolume(0.05);
    crickets.play();
    this.layers.crickets = crickets;

    // Creaks are scheduled one-shots (see update), on their own bus.
    this.creakBus = ctx.createGain();
    this.creakBus.gain.value = 0.12;
    this.creakBus.connect(out);
    this.sr = sr;
  }

  /** A dry board creak: a stick-slip buzz with a falling, wobbling pitch. */
  #creak() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.35 + Math.random() * 0.6;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = 140 + Math.random() * 160;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * (0.7 + Math.random() * 0.2), t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 18 + Math.random() * 20;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = f0 * 0.25;
    lfo.connect(lfoGain).connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 800 + Math.random() * 600;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.6, t + 0.05);
    g.gain.setValueAtTime(0.6, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.5;
    o.connect(bp).connect(g).connect(pan).connect(this.creakBus);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
    this.creaks = (this.creaks ?? 0) + 1;
  }

  /** @param {number} dt @param {import('../environment/AtmosphereManager.js').Wind} [wind] */
  update(dt, wind = null) {
    if (!this.unlocked) return;
    const t = this.ctx.currentTime;
    // Ambient parameters change slowly: retune them 10 times a second, not
    // every frame, to keep the audio thread's automation queue short.
    this.paramTimer = (this.paramTimer ?? 0) - dt;
    if (wind && this.paramTimer <= 0) {
      this.paramTimer = 0.1;
      const g = wind.gust;
      this.layers.wind.gain.gain.setTargetAtTime(0.18 + g * 0.45, t, 0.4);
      this.windFilter.frequency.setTargetAtTime(280 + g * 650, t, 0.4);
      this.windWhistle.frequency.setTargetAtTime(700 + g * 600, t, 0.6);
    }
    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.#creak();
      this.creakTimer = 4 + Math.random() * 9;
    }
    this.#retuneEchoes();
  }
}

/** A buffer of `seconds` from gen(n), with the ends cross-faded so it loops seamlessly. */
function loopBuffer(ctx, seconds, gen) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const fade = Math.floor(ctx.sampleRate * 0.25);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const src = gen(n + fade);
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = src[i];
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = src[i] * k + src[n + i] * (1 - k);
    }
  }
  return buf;
}

/** Chirp trains: 3-5 pulses of a ~4.5 kHz tone at ~30 Hz, from a few "crickets". */
function cricketBuffer(ctx, seconds) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const crickets = [
    { f: 4300, pan: -0.7, every: 1.1 },
    { f: 4750, pan: 0.6, every: 1.6 },
    { f: 3900, pan: 0.1, every: 2.3 },
  ];
  for (const c of crickets) {
    const gl = Math.sqrt((1 - c.pan) / 2);
    const gr = Math.sqrt((1 + c.pan) / 2);
    for (let start = Math.random() * c.every; start < seconds - 0.3; start += c.every * (0.8 + Math.random() * 0.4)) {
      const pulses = 3 + Math.floor(Math.random() * 3);
      for (let p = 0; p < pulses; p++) {
        const s0 = Math.floor((start + p * 0.033) * sr);
        const len = Math.floor(0.018 * sr);
        for (let i = 0; i < len && s0 + i < n; i++) {
          const env = Math.sin((Math.PI * i) / len);
          const v = Math.sin((2 * Math.PI * c.f * i) / sr) * env * 0.5;
          L[s0 + i] += v * gl;
          R[s0 + i] += v * gr;
        }
      }
    }
  }
  return buf;
}
