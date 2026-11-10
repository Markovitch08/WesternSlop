import * as THREE from 'three';
import { makeCanvas, canvasToTexture } from '../util/canvasTextures.js';

/**
 * Big sign fixed in the world over the range, used by the game modes: round
 * numbers, prompts, the 3-2-1 countdown, "DRAW!", timers and results. It is a
 * flat panel facing the firing line (not a billboard sprite), so in VR it
 * stays put while you look around. Also owns the red "you've been shot" flash
 * around the player's head.
 */
export class DuelHUD {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(scene, camera, position = new THREE.Vector3(0, 3.6, -9), faceTowards = new THREE.Vector3(0, 1.6, 0)) {
    [this.canvas, this.ctx] = makeCanvas(1024, 448);
    this.texture = canvasToTexture(this.canvas, { repeat: false });
    this.sprite = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, fog: false, toneMapped: false }),
    );
    this.sprite.position.copy(position);
    this.sprite.lookAt(faceTowards); // fixed orientation, chosen once
    this.baseScale = new THREE.Vector2(4.4, 1.925);
    this.sprite.scale.set(this.baseScale.x, this.baseScale.y, 1);
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
    this.sprite.name = 'duelHUD';
    this.sprite.raycast = () => {};
    scene.add(this.sprite);

    // Red flash: an inside-out sphere around the head, faded out over ~0.8 s.
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xb01010, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false }),
    );
    this.flash.renderOrder = 20;
    this.flash.visible = false;
    this.flash.raycast = () => {};
    camera.add(this.flash);

    this.pulse = 0;
    this.flashLevel = 0;
    /** Last message shown, for tests and debugging. */
    this.text = '';
    this.sub = '';
  }

  /**
   * @param {string} text big line
   * @param {string} [sub] small line(s) under it ('\n' for two lines)
   * @param {string} [color]
   * @param {boolean} [pop] scale-pop animation (countdown numbers)
   */
  show(text, sub = '', color = '#ffe7b0', pop = false) {
    this.text = text;
    this.sub = sub;
    const g = this.ctx;
    const { width: W, height: H } = this.canvas;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(30, 16, 6, 0.55)';
    const r = 40;
    g.beginPath();
    g.roundRect(20, 20, W - 40, H - 40, r);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    // Shrink each line until it fits inside the panel.
    const fit = (str, start, min) => {
      let size = start;
      do {
        g.font = `bold ${size}px Georgia, serif`;
        size -= 4;
      } while (size > min && g.measureText(str).width > W - 110);
    };
    fit(text, text.length <= 3 ? 230 : 150, 40);
    g.lineWidth = 14;
    g.strokeStyle = 'rgba(25, 10, 2, 0.95)';
    const subLines = sub ? sub.split('\n') : [];
    const y = subLines.length > 1 ? 165 : sub ? 190 : H / 2;
    g.strokeText(text, W / 2, y);
    g.fillStyle = color;
    g.fillText(text, W / 2, y);
    subLines.forEach((line, i) => {
      const ly = subLines.length > 1 ? 300 + i * 66 : 350;
      fit(line, 58, 20);
      g.lineWidth = 9;
      g.strokeText(line, W / 2, ly);
      g.fillStyle = '#fff2d8';
      g.fillText(line, W / 2, ly);
    });
    this.texture.needsUpdate = true;
    this.sprite.visible = true;
    if (pop) this.pulse = 1;
  }

  hide() {
    this.sprite.visible = false;
    this.text = '';
    this.sub = '';
  }

  /** Red flash around the player's head. */
  hurt() {
    this.flashLevel = 1;
  }

  update(dt) {
    this.pulse = Math.max(0, this.pulse - dt * 3);
    const k = 1 + this.pulse * 0.35;
    this.sprite.scale.set(this.baseScale.x * k, this.baseScale.y * k, 1);
    this.flashLevel = Math.max(0, this.flashLevel - dt * 1.25);
    this.flash.visible = this.flashLevel > 0;
    this.flash.material.opacity = this.flashLevel * 0.55;
  }
}
