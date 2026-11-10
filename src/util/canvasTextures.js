import * as THREE from 'three';

/** Procedural canvas textures, so the game ships with no image assets. */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function finish(canvas, { repeat = true, srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const shade = (hex, amt) => {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amt);
  return `#${c.getHexString()}`;
};

/** Vertical weathered planks. One texture tile is roughly 2 m wide. */
export function plankTexture(base = '#8a5a32', boards = 10) {
  const [c, g] = makeCanvas(256, 256);
  const bw = c.width / boards;
  for (let i = 0; i < boards; i++) {
    g.fillStyle = shade(base, (Math.random() - 0.5) * 0.08);
    g.fillRect(i * bw, 0, bw, c.height);
    // Grain
    g.strokeStyle = shade(base, -0.06);
    g.globalAlpha = 0.35;
    for (let k = 0; k < 6; k++) {
      const x = i * bw + Math.random() * bw;
      g.beginPath();
      g.moveTo(x, 0);
      g.bezierCurveTo(x + 3, 80, x - 3, 170, x + 2, 256);
      g.stroke();
    }
    g.globalAlpha = 1;
    // Gap between boards
    g.fillStyle = shade(base, -0.22);
    g.fillRect(i * bw, 0, 2, c.height);
    // Nail heads
    g.fillStyle = '#2a2420';
    for (const y of [20, 236]) g.fillRect(i * bw + bw / 2 - 1, y, 3, 3);
  }
  return finish(c);
}

/** Sand with speckles and soft wind ripples. */
export function sandTexture() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#c99c64';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 6) {
    g.strokeStyle = 'rgba(120, 80, 40, 0.06)';
    g.beginPath();
    for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + y) * 2);
    g.stroke();
  }
  for (let i = 0; i < 2200; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? 'rgba(90,60,30,0.18)' : 'rgba(255,240,210,0.18)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
  }
  return finish(c);
}

/** Soft round sprite for dust particles (white, tinted by material colour). */
export function dustSprite() {
  const [c, g] = makeCanvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return finish(c, { repeat: false });
}

/** Painted sign board with centred text. */
export function signTexture(text, { w = 512, h = 128, bg = '#3b2414', fg = '#f1d9a6', font = 'bold 72px Georgia, serif' } = {}) {
  const [c, g] = makeCanvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = fg;
  g.lineWidth = 6;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.fillStyle = fg;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  return finish(c, { repeat: false });
}

export { makeCanvas, finish as canvasToTexture };
