import * as THREE from 'three';
import { makeCanvas, canvasToTexture, plankTexture } from '../util/canvasTextures.js';
import { worldBox } from '../util/geometry.js';
import { SETTINGS } from '../game/Settings.js';

const W = 1024;
const ROW_H = 96;
const TOP = 120;
const BOARD_W = 0.9; // metres
const _ray = new THREE.Raycaster();
const _m = new THREE.Matrix4();

/**
 * A painted settings board beside the bench. Point an empty hand at a row's
 * ◀ / ▶ and pull the trigger (or click it on desktop) to change it.
 */
export class SettingsBoard {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../game/Settings.js').Settings} settings
   * @param {string[]} keys rows to show, top to bottom
   */
  constructor(scene, settings, keys, position = new THREE.Vector3(2.3, 0, -0.1), faceTowards = new THREE.Vector3(0, 1.4, 0.3)) {
    this.settings = settings;
    this.keys = keys;
    const H = TOP + keys.length * ROW_H + 40;
    this.boardH = (BOARD_W * H) / W;
    this.object = new THREE.Group();
    this.object.name = 'settingsBoard';
    this.object.position.copy(position);
    this.object.lookAt(faceTowards.x, position.y, faceTowards.z);

    const wood = new THREE.MeshStandardMaterial({ map: plankTexture('#5e3d24', 6), roughness: 0.85 });
    const top = 1.0 + this.boardH;
    const post = new THREE.Mesh(worldBox(0.08, top, 0.08), wood);
    post.position.set(0, top / 2, -0.1); // behind the frame, not through the face
    const frame = new THREE.Mesh(worldBox(BOARD_W + 0.06, this.boardH + 0.06, 0.04), wood);
    frame.position.set(0, 1.0 + this.boardH / 2, -0.03);
    for (const m of [post, frame]) {
      m.castShadow = m.receiveShadow = true;
      m.userData.surface = 'wood';
    }
    [this.canvas, this.ctx] = makeCanvas(W, H);
    this.texture = canvasToTexture(this.canvas, { repeat: false });
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, this.boardH), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.face.position.set(0, 1.0 + this.boardH / 2, 0);
    this.face.userData.surface = 'wood';
    this.object.add(post, frame, this.face);

    // Invisible hit areas for each row's ◀ and ▶.
    this.buttons = [];
    const bw = (140 / W) * BOARD_W;
    const bh = ((ROW_H - 16) / W) * BOARD_W;
    keys.forEach((key, r) => {
      const yPx = TOP + r * ROW_H + ROW_H / 2;
      const y = 1.0 + this.boardH / 2 - ((yPx - H / 2) / W) * BOARD_W;
      for (const [dir, xPx] of [[-1, 620], [1, 940]]) {
        const btn = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), new THREE.MeshBasicMaterial({ visible: false }));
        btn.position.set(((xPx - W / 2) / W) * BOARD_W, y, 0.006);
        btn.userData = { key, dir, settingsButton: true };
        btn.name = `settings:${key}:${dir > 0 ? 'next' : 'prev'}`;
        this.object.add(btn);
        this.buttons.push(btn);
      }
    });
    scene.add(this.object);
    /** Static meshes bullets can hit (it's a wooden board). */
    this.colliders = [post, frame, this.face];
    this.flash = null;
    settings.addEventListener('change', () => this.draw());
    this.draw();
  }

  /** Raycast `ray` (origin, direction) against the buttons; press the first hit. */
  pressRay(origin, direction) {
    _ray.set(origin, direction);
    _ray.far = 6;
    const hit = _ray.intersectObjects(this.buttons, false)[0];
    if (!hit) return false;
    const { key, dir } = hit.object.userData;
    this.settings.step(key, dir);
    this.flash = { key, dir, until: performance.now() + 180 };
    this.draw();
    return true;
  }

  /** Press with an XR hand's pointing ray. */
  pressWithHand(hand) {
    hand.controller.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(hand.controller.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(_m.copy(hand.controller.matrixWorld));
    return this.pressRay(origin, dir);
  }

  draw() {
    const g = this.ctx;
    const H = this.canvas.height;
    g.fillStyle = '#2b1d12';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#c9a36a';
    g.lineWidth = 6;
    g.strokeRect(12, 12, W - 24, H - 24);
    g.fillStyle = '#f1d9a6';
    g.font = 'bold 60px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('SETTINGS', W / 2, 66);
    g.font = 'italic 26px Georgia, serif';
    g.fillStyle = 'rgba(241,217,166,0.7)';
    g.fillText('point an empty hand · pull the trigger', W / 2, 104);
    this.keys.forEach((key, r) => {
      const y = TOP + r * ROW_H + ROW_H / 2;
      g.textAlign = 'left';
      g.fillStyle = '#efe3c8';
      g.font = '40px Georgia, serif';
      g.fillText(SETTINGS[key].label, 50, y);
      g.textAlign = 'center';
      g.fillStyle = '#ffd36b';
      g.font = 'bold 40px Georgia, serif';
      g.fillText(this.settings.display(key), 780, y);
      for (const [dir, x] of [[-1, 620], [1, 940]]) {
        const lit = this.flash && this.flash.key === key && this.flash.dir === dir && performance.now() < this.flash.until;
        g.fillStyle = lit ? '#ffd36b' : '#5a3c22';
        g.fillRect(x - 60, y - 34, 120, 68);
        g.fillStyle = lit ? '#2b1d12' : '#f1d9a6';
        g.font = 'bold 44px Georgia, serif';
        g.fillText(dir < 0 ? '◀' : '▶', x, y + 2);
      }
    });
    this.texture.needsUpdate = true;
  }
}
