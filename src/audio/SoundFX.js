/**
 * Synthesised sound effects (Web Audio, no asset files).
 *
 * The AudioContext can only start after a user gesture, so call unlock() from
 * a click / XR session start. Every play method is a no-op until then.
 */
export class SoundFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.echo = null;
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
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);

    // One second of white noise, reused by every effect.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Desert slap-back echo for gunshots: delay -> low-pass -> feedback.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.32;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    delay.connect(lp).connect(fb).connect(delay);
    lp.connect(this.master);
    this.echo = delay;
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

  /** Black-powder revolver report: sharp crack, body thump, echo tail. */
  gunshot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);
    bus.connect(this.echo);
    this.#noiseBurst(t, 0.05, 'highpass', 2500, 1500, 1.0, bus); // crack
    this.#noiseBurst(t, 0.45, 'lowpass', 5000, 250, 0.9, bus); // blast body
    this.#tone(t, 0.18, 'sine', 140, 38, 0.9, bus); // chest thump
  }

  /** Metallic click: hammer cock, dry fire, cylinder detent. */
  click(pitch = 1, gain = 0.35) {
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
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.#noiseBurst(t, 0.08, 'lowpass', 900, 200, 0.4);
  }
}
