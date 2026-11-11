import * as THREE from 'three';
import { makeCanvas, canvasToTexture } from '../util/canvasTextures.js';

/** The radio's playlist (files in public/music; see public/music/CREDITS.md). */
export const TRACKS = [
  { file: 'spaghetti-western.mp3', title: 'Spaghetti Western', by: 'Spring Spring' },
  { file: 'no-country-for-old-alex.mp3', title: 'No Country For Old Alex', by: 'Pro Sensory' },
  { file: 'showdown.mp3', title: 'Showdown', by: 'el-corleo' },
  { file: 'spaghetti-western-theme.mp3', title: 'Spaghetti Western Theme', by: 'linxiaoma' },
  { file: 'western.mp3', title: 'Western', by: 'shalpin' },
  { file: 'two-guns-one-destiny.mp3', title: 'Two Guns, One Destiny', by: 'Silverman Sound' },
];

const BUTTONS = [
  { action: 'power', label: '⏻', x: -0.075 },
  { action: 'down', label: '−', x: -0.025 },
  { action: 'up', label: '+', x: 0.025 },
  { action: 'next', label: '⏭', x: 0.075 },
];
const _ray = new THREE.Raycaster();

/**
 * An old cathedral radio on the bench that plays the western soundtrack.
 *
 * Point an empty hand at a button on its brass strip and pull the trigger (or
 * click it on desktop): power, volume down / up, next track. It shuffles
 * through the playlist (every track once before any repeats) and moves on
 * when a track ends. Power and volume are saved in the settings.
 *
 * Tracks stream from an <audio> element (no big decoded buffers), through a
 * band-limited "old set" tone with a faint crackle, and sound from the radio's
 * spot in the world.
 */
export class Radio extends THREE.EventDispatcher {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../game/Settings.js').Settings} settings
   * @param {import('./AudioEnvironment.js').AudioEnvironment} audio
   */
  constructor(scene, settings, audio, position = new THREE.Vector3(-0.5, 0.9, -0.82), faceTowards = new THREE.Vector3(0, 1.5, 0.3)) {
    super();
    this.settings = settings;
    this.audio = audio;
    this.base = (import.meta.env?.BASE_URL ?? './').replace(/\/?$/, '/');
    this.order = [];
    this.index = -1;
    this.track = null;
    this.built = false;
    this.played = []; // titles started, in order (tests and debugging)

    this.object = new THREE.Group();
    this.object.name = 'radio';
    this.object.position.copy(position);
    this.object.lookAt(faceTowards.x, position.y, faceTowards.z);
    this.#buildModel();
    scene.add(this.object);
    /** Meshes bullets can hit (wood and cloth). */
    this.colliders = [this.cabinet];

    settings.addEventListener('change', ({ key }) => {
      if (key === 'musicVolume') this.#applyVolume();
      if (key === 'musicOn') this.#applyPower();
      this.draw();
    });
    this.draw();
  }

  get on() {
    return this.settings.get('musicOn');
  }

  get playing() {
    return !!this.el && !this.el.paused;
  }

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------
  #buildModel() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b3f1f, roughness: 0.55, metalness: 0.05 });
    // Cathedral cabinet: a box topped with a half-round arch.
    const W = 0.26, H = 0.2, D = 0.14;
    const shape = new THREE.Shape();
    shape.moveTo(-W / 2, 0);
    shape.lineTo(W / 2, 0);
    shape.lineTo(W / 2, H);
    shape.absarc(0, H, W / 2, 0, Math.PI, false);
    shape.lineTo(-W / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, curveSegments: 16 });
    geo.translate(0, 0, -D / 2);
    this.cabinet = new THREE.Mesh(geo, wood);
    this.cabinet.castShadow = this.cabinet.receiveShadow = true;
    this.cabinet.userData.surface = 'wood';
    this.cabinet.name = 'radioCabinet';
    this.object.add(this.cabinet);

    // Speaker cloth in the arch, with a gothic fretwork of dark bars.
    const cloth = new THREE.Shape();
    cloth.moveTo(-0.09, 0.12);
    cloth.lineTo(0.09, 0.12);
    cloth.lineTo(0.09, H);
    cloth.absarc(0, H, 0.09, 0, Math.PI, false);
    cloth.lineTo(-0.09, 0.12);
    const clothMesh = new THREE.Mesh(new THREE.ShapeGeometry(cloth, 12), new THREE.MeshStandardMaterial({ color: 0xb79a6a, roughness: 1 }));
    clothMesh.position.z = D / 2 + 0.009;
    this.object.add(clothMesh);
    const barMat = new THREE.MeshStandardMaterial({ color: 0x3a2210, roughness: 0.6 });
    for (const x of [-0.045, 0, 0.045]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.16, 0.006), barMat);
      bar.position.set(x, 0.2, D / 2 + 0.012);
      this.object.add(bar);
    }

    // Dial window showing the station (track) name.
    [this.canvas, this.ctx] = makeCanvas(512, 128);
    this.texture = canvasToTexture(this.canvas, { repeat: false });
    const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.05), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    dial.position.set(0, 0.092, D / 2 + 0.009);
    this.object.add(dial);
    this.dialMat = dial.material;

    // Brass button strip along the bottom.
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.85, roughness: 0.3 });
    this.buttons = BUTTONS.map((b) => {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 16).rotateX(Math.PI / 2), brass);
      knob.position.set(b.x, 0.046, D / 2 + 0.014);
      knob.userData = { radioAction: b.action };
      knob.name = `radio:${b.action}`;
      this.object.add(knob);
      return knob;
    });
    // Labels engraved under the knobs (on the dial texture's lower strip is too
    // small; draw them on a separate little plate).
    const [lc, lg] = makeCanvas(512, 64);
    lg.fillStyle = '#2a1708';
    lg.fillRect(0, 0, 512, 64);
    lg.fillStyle = '#e9cf8f';
    lg.font = 'bold 44px Georgia, serif';
    lg.textAlign = 'center';
    lg.textBaseline = 'middle';
    BUTTONS.forEach((b, i) => lg.fillText(b.label, 64 + i * 128, 34));
    const labels = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.025), new THREE.MeshBasicMaterial({ map: canvasToTexture(lc, { repeat: false }), toneMapped: false }));
    labels.position.set(0, 0.018, D / 2 + 0.009);
    this.object.add(labels);
  }

  draw() {
    const g = this.ctx;
    const on = this.on;
    g.fillStyle = on ? '#3b2a12' : '#1c140a';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#c9a14a';
    g.lineWidth = 6;
    g.strokeRect(4, 4, 504, 120);
    // Tuning scale
    g.strokeStyle = on ? 'rgba(255,214,140,0.6)' : 'rgba(150,120,80,0.4)';
    g.lineWidth = 2;
    for (let i = 0; i < 25; i++) {
      const x = 30 + i * 19;
      g.beginPath();
      g.moveTo(x, 100);
      g.lineTo(x, i % 5 === 0 ? 82 : 90);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = on ? '#ffd890' : '#6b5a40';
    g.font = 'bold 40px Georgia, serif';
    const title = !on ? 'OFF' : this.track ? this.track.title : 'tuning in…';
    g.fillText(title, 256, 40, 480);
    if (on) {
      g.font = '22px Georgia, serif';
      g.fillText(`volume ${Math.round(this.settings.get('musicVolume') * 100)}%`, 256, 108);
    }
    this.texture.needsUpdate = true;
    if (this.dialMat) this.dialMat.color.setScalar(on ? 1 : 0.6);
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  /** Build the audio chain once the AudioContext is running. */
  #build() {
    const ctx = this.audio.ctx;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.addEventListener('ended', () => this.next());
    this.el = el;
    const src = ctx.createMediaElementSource(el);
    // Old-set tone: no deep bass, no sparkle, a little mid presence.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 140;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1500;
    mid.gain.value = 3;
    this.gain = ctx.createGain();
    src.connect(hp).connect(lp).connect(mid).connect(this.gain);

    // Faint crackle while it's on.
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() < 0.0008 ? (Math.random() * 2 - 1) : (Math.random() * 2 - 1) * 0.02;
    this.crackle = ctx.createBufferSource();
    this.crackle.buffer = buf;
    this.crackle.loop = true;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    this.crackle.connect(this.crackleGain).connect(this.gain);
    this.crackle.start();

    // Sounds from the radio, wherever you stand.
    this.speaker = new THREE.PositionalAudio(this.audio.listener);
    this.speaker.setNodeSource(this.gain);
    this.speaker.setRefDistance(1.2);
    this.speaker.setRolloffFactor(1);
    this.speaker.panner.panningModel = 'equalpower';
    this.speaker.position.set(0, 0.2, 0.08);
    this.object.add(this.speaker);
    this.built = true;
    this.#applyVolume();
    this.#applyPower();
  }

  #applyVolume() {
    if (!this.built) return;
    this.gain.gain.value = 0.8 * this.settings.get('musicVolume');
  }

  #applyPower() {
    if (!this.built) return;
    if (this.on) {
      this.crackleGain.gain.value = 1;
      if (!this.track) this.next();
      else this.el.play().catch(() => {});
    } else {
      this.crackleGain.gain.value = 0;
      this.el.pause();
    }
    this.draw();
  }

  /** Next track in the shuffle (reshuffling once every track has played). */
  next() {
    if (!this.built) return;
    this.index++;
    if (this.index >= this.order.length) {
      const last = this.track;
      this.order = TRACKS.map((_, i) => i);
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
      // Don't play the same track twice in a row across a reshuffle.
      if (last && TRACKS[this.order[0]] === last) this.order.push(this.order.shift());
      this.index = 0;
    }
    this.track = TRACKS[this.order[this.index]];
    this.el.src = `${this.base}music/${this.track.file}`;
    this.played.push(this.track.title);
    if (this.on) this.el.play().catch(() => {});
    this.draw();
    this.dispatchEvent({ type: 'track', track: this.track });
  }

  /** @param {'power'|'up'|'down'|'next'} action */
  press(action) {
    const s = this.settings;
    if (action === 'power') s.set('musicOn', !s.get('musicOn'));
    else if (action === 'up') s.step('musicVolume', 1);
    else if (action === 'down') s.step('musicVolume', -1);
    else if (action === 'next' && this.on) this.next();
    this.dispatchEvent({ type: 'press', action });
  }

  /** Raycast against the knobs; press the first hit. */
  pressRay(origin, direction) {
    _ray.set(origin, direction);
    _ray.far = 6;
    const hit = _ray.intersectObjects(this.buttons, false)[0];
    if (!hit) return false;
    this.press(hit.object.userData.radioAction);
    return true;
  }

  pressWithHand(hand) {
    hand.controller.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(hand.controller.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(hand.controller.matrixWorld);
    return this.pressRay(origin, dir);
  }

  update() {
    if (!this.built && this.audio.unlocked) this.#build();
  }
}
