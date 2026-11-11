import * as THREE from 'three';
import { makeCanvas, canvasToTexture, plankTexture } from '../util/canvasTextures.js';
import { worldBox } from '../util/geometry.js';

/**
 * Chalkboard on a post beside the firing line. Redraws its canvas only when
 * the stats change (never per frame).
 */
export class Scoreboard {
  constructor(scene, position = new THREE.Vector3(-1.45, 0, -1.7), yaw = 0.6) {
    this.object = new THREE.Group();
    this.object.name = 'scoreboard';
    this.object.position.copy(position);
    this.object.rotation.y = yaw;

    const wood = new THREE.MeshStandardMaterial({ map: plankTexture('#5e3d24', 6), roughness: 0.85 });
    const post = new THREE.Mesh(worldBox(0.1, 1.4, 0.1), wood);
    post.position.y = 0.7;
    const frame = new THREE.Mesh(worldBox(1.08, 0.78, 0.05), wood);
    frame.position.set(0, 1.62, 0);
    for (const m of [post, frame]) {
      m.castShadow = m.receiveShadow = true;
      m.userData.surface = 'wood';
    }

    [this.canvas, this.ctx] = makeCanvas(1024, 704);
    this.texture = canvasToTexture(this.canvas, { repeat: false });
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 0.7),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    board.position.set(0, 1.62, 0.027);
    board.userData.surface = 'wood';
    this.object.add(post, frame, board);
    scene.add(this.object);

    /** Meshes bullets can hit (they just thunk: it's a wooden board). */
    this.colliders = [post, frame, board];
    this.redraws = 0;
  }

  /** @param {object} stats see TargetManager.stats */
  /** @param {object} stats see TargetManager.stats (records come from `this.records`, if set) */
  draw(stats) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#1f2a24';
    g.fillRect(0, 0, W, H);
    // Chalk smudges
    g.globalAlpha = 0.05;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 12; i++) g.fillRect((i * 97) % W, (i * 53) % H, 200, 40);
    g.globalAlpha = 1;

    const chalk = '#efe8d6';
    const accent = '#ffd36b';
    g.fillStyle = chalk;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center';
    g.font = 'bold 50px Georgia, serif';
    g.fillText('WESTERN SLOP RANGE', W / 2, 70);

    g.fillStyle = accent;
    g.font = 'bold 120px Georgia, serif';
    g.fillText(String(stats.points), W / 2, 200);

    const acc = stats.shots ? Math.round((stats.hits / stats.shots) * 100) : 0;
    const fmt = (s) => (s == null ? '—' : `${s.toFixed(2)} s`);
    const rows = [
      ['Shots', stats.shots, 'Hits', stats.hits],
      ['Accuracy', `${acc}%`, 'Headshots', stats.headshots],
      ['Duels won', stats.duelsWon, 'Too slow', stats.duelsMissed],
      ['Best draw', fmt(stats.bestReaction), 'Avg draw', fmt(stats.avgReaction)],
    ];
    g.font = '40px Georgia, serif';
    rows.forEach(([l1, v1, l2, v2], i) => {
      const y = 280 + i * 56;
      g.textAlign = 'left';
      g.fillStyle = chalk;
      g.fillText(l1, 60, y);
      g.fillText(l2, 540, y);
      g.textAlign = 'right';
      g.fillStyle = accent;
      g.fillText(String(v1), 470, y);
      g.fillText(String(v2), 960, y);
    });

    g.strokeStyle = 'rgba(239,232,214,0.4)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(60, 520);
    g.lineTo(W - 60, 520);
    g.stroke();

    g.textAlign = 'left';
    g.fillStyle = chalk;
    g.font = '36px Georgia, serif';
    const r = stats.last;
    const lastLine = r
      ? `Last: ${r.label} · ${r.distance.toFixed(1)} m · ${Math.round(r.precision * 100)}%` +
        (r.reaction != null ? ` · ${r.reaction.toFixed(2)} s` : '') + ` · +${r.points}`
      : 'Last: —';
    g.fillText(lastLine, 60, 568);
    // Saved best results (kept between sessions).
    this.recordsLine = this.records ? this.records.summary() : '';
    if (this.recordsLine) {
      g.fillStyle = '#ffd36b';
      g.font = '32px Georgia, serif';
      g.fillText(this.recordsLine, 60, 618);
    }
    g.fillStyle = 'rgba(239,232,214,0.6)';
    g.font = 'italic 28px Georgia, serif';
    g.fillText('Plates: red resets · black DUEL · orange POP-UPS · yellow TOSS', 60, 668);

    this.texture.needsUpdate = true;
    this.redraws++;
  }
}
