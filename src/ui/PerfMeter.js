import * as THREE from 'three';
import { makeCanvas, canvasToTexture } from '../util/canvasTextures.js';

/**
 * Wrist-mounted performance readout: frames per second, average and worst
 * frame time over the last second, and draw calls. Rides on a controller's
 * grip like a watch; redraws four times a second.
 */
export class PerfMeter {
  constructor(renderer) {
    this.renderer = renderer;
    [this.canvas, this.ctx] = makeCanvas(256, 128);
    this.texture = canvasToTexture(this.canvas, { repeat: false });
    this.object = new THREE.Mesh(
      new THREE.PlaneGeometry(0.11, 0.055),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, depthWrite: false, transparent: true }),
    );
    this.object.name = 'perfMeter';
    this.object.raycast = () => {};
    this.object.visible = false;
    // On the back of the wrist, tilted up toward the eyes.
    this.object.position.set(0, 0.035, 0.07);
    this.object.rotation.set(-Math.PI / 2.6, 0, 0);
    this.samples = [];
    this.timer = 0;
    this.fps = 0;
    this.avgMs = 0;
    this.worstMs = 0;
    this.enabled = false;
    this.hand = null;
  }

  /** Mount on a hand's grip (or detach with null). */
  attach(hand) {
    if (this.hand === hand) return;
    this.object.removeFromParent();
    this.hand = hand;
    if (hand) hand.grip.add(this.object);
  }

  /** @param {number} rawDt un-clamped frame time, seconds */
  update(rawDt) {
    this.object.visible = this.enabled && !!this.hand?.connected;
    this.samples.push(rawDt);
    this.timer += rawDt;
    if (this.timer < 0.25) return;
    this.timer = 0;
    let total = 0;
    let n = 0;
    let worst = 0;
    // Keep about the last second of samples.
    for (let i = this.samples.length - 1; i >= 0 && total < 1; i--) {
      total += this.samples[i];
      worst = Math.max(worst, this.samples[i]);
      n++;
    }
    this.samples.splice(0, this.samples.length - n);
    this.fps = n / Math.max(total, 1e-6);
    this.avgMs = (total / n) * 1000;
    this.worstMs = worst * 1000;
    if (this.enabled) this.#draw();
  }

  #draw() {
    const g = this.ctx;
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = 'rgba(15, 10, 5, 0.85)';
    g.fillRect(0, 0, 256, 128);
    const good = this.fps >= 70;
    const ok = this.fps >= 60;
    g.fillStyle = good ? '#9be37a' : ok ? '#ffd36b' : '#ff6b4a';
    g.font = 'bold 54px monospace';
    g.textBaseline = 'top';
    const fpsText = `${Math.round(this.fps)}`;
    g.fillText(fpsText, 12, 8);
    const fpsW = g.measureText(fpsText).width;
    g.font = '22px monospace';
    g.fillStyle = '#efe3c8';
    g.fillText('fps', 18 + fpsW, 36);
    g.textAlign = 'right';
    g.fillText(`${this.renderer.info.render.calls} dc`, 244, 14);
    g.textAlign = 'left';
    g.fillText(`avg ${this.avgMs.toFixed(1)} ms`, 12, 70);
    g.fillText(`max ${this.worstMs.toFixed(1)} ms`, 12, 96);
    this.texture.needsUpdate = true;
  }
}
