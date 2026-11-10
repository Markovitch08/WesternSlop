import * as THREE from 'three';
import { makeCanvas, canvasToTexture } from '../util/canvasTextures.js';

const LIFETIME = 1.8;
const _cam = new THREE.Vector3();

/**
 * Pool of score pop-ups ("+180 / HEADSHOT / 12.4 m · 0.48 s") that rise from
 * the hit point and fade. Each is a flat panel turned to face the player once,
 * when it appears, and then fixed in the world (a billboard that follows your
 * head is uncomfortable in VR). Sized by distance so it reads at 25 m.
 */
export class FloatingText {
  constructor(scene, count = 6) {
    this.items = [];
    this.next = 0;
    for (let i = 0; i < count; i++) {
      const [canvas, ctx] = makeCanvas(512, 256);
      const texture = canvasToTexture(canvas, { repeat: false });
      const sprite = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), new THREE.MeshBasicMaterial({
        map: texture, transparent: true, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
      }));
      sprite.renderOrder = 10;
      sprite.visible = false;
      sprite.name = 'floatingText';
      sprite.raycast = () => {};
      scene.add(sprite);
      this.items.push({ sprite, canvas, ctx, texture, age: 0, alive: false });
    }
  }

  /**
   * @param {THREE.Vector3} position
   * @param {string[]} lines first line is drawn large
   * @param {string} color CSS colour of the first line
   */
  spawn(position, lines, color = '#ffd36b') {
    const item = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    const { ctx, canvas } = item;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    lines.forEach((text, i) => {
      const big = i === 0;
      ctx.font = big ? 'bold 96px Georgia, serif' : 'bold 44px Georgia, serif';
      const y = big ? 70 : 150 + (i - 1) * 54;
      ctx.lineWidth = big ? 12 : 8;
      ctx.strokeStyle = 'rgba(30, 15, 5, 0.9)';
      ctx.strokeText(text, 256, y);
      ctx.fillStyle = big ? color : '#fff2d8';
      ctx.fillText(text, 256, y);
    });
    item.texture.needsUpdate = true;
    item.sprite.position.copy(position);
    item.sprite.position.y += 0.25;
    // Face the player once (yaw only), then stay fixed in the world.
    if (this.camera) {
      this.camera.getWorldPosition(_cam);
      item.sprite.lookAt(_cam.x, item.sprite.position.y, _cam.z);
      const w = Math.max(0.5, item.sprite.position.distanceTo(_cam) * 0.14);
      item.sprite.scale.set(w, w, 1);
    }
    item.sprite.visible = true;
    item.sprite.material.opacity = 1;
    item.age = 0;
    item.alive = true;
    return item.sprite;
  }

  update(dt, camera) {
    this.camera = camera;
    for (const item of this.items) {
      if (!item.alive) continue;
      item.age += dt;
      const s = item.sprite;
      if (item.age >= LIFETIME) {
        item.alive = false;
        s.visible = false;
        continue;
      }
      s.position.y += dt * 0.35;
      s.material.opacity = 1 - THREE.MathUtils.smoothstep(item.age, LIFETIME * 0.6, LIFETIME);
    }
  }
}
