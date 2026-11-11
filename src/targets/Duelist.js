import * as THREE from 'three';
import { makeCanvas, canvasToTexture, plankTexture } from '../util/canvasTextures.js';
import { worldBox } from '../util/geometry.js';

/** Silhouette geometry in metres, hinge (bottom edge) at y = 0. */
const HEAD = { x: 0, y: 1.56, r: 0.125 };
const HEART = { x: 0, y: 1.1 };
const HEART_R = 0.08;
const CHEST_R = 0.18;
const HAT_Y = 1.62;
const BOUNDS = { minX: -0.28, maxX: 0.28, minY: 0, maxY: 1.79 };

const DOWN_ANGLE = -Math.PI / 2 + 0.06; // lying back, propped on the stand
const RISE_TIME = 0.22;
export const UP_WINDOW = 2.6; // seconds the duelist stays up before "too slow"

let sharedGeometry = null;
let sharedMaterial = null;

export function silhouetteGeometry() {
  if (sharedGeometry) return sharedGeometry;
  const body = new THREE.Shape();
  body.moveTo(-0.24, 0);
  body.lineTo(-0.24, 0.85);
  body.lineTo(-0.28, 1.25);
  body.quadraticCurveTo(-0.28, 1.36, -0.16, 1.38);
  body.lineTo(-0.06, 1.4);
  body.lineTo(-0.06, 1.46);
  body.lineTo(0.06, 1.46);
  body.lineTo(0.06, 1.4);
  body.lineTo(0.16, 1.38);
  body.quadraticCurveTo(0.28, 1.36, 0.28, 1.25);
  body.lineTo(0.24, 0.85);
  body.lineTo(0.24, 0);
  body.closePath();

  const head = new THREE.Shape();
  head.absarc(HEAD.x, HEAD.y, HEAD.r, 0, Math.PI * 2, false);

  const hat = new THREE.Shape();
  hat.moveTo(-0.21, 1.63);
  hat.lineTo(0.21, 1.63);
  hat.lineTo(0.21, 1.67);
  hat.lineTo(0.1, 1.67);
  hat.lineTo(0.09, 1.79);
  hat.lineTo(-0.09, 1.79);
  hat.lineTo(-0.1, 1.67);
  hat.lineTo(-0.21, 1.67);
  hat.closePath();

  sharedGeometry = new THREE.ExtrudeGeometry([body, head, hat], { depth: 0.02, bevelEnabled: false, curveSegments: 18 });
  return sharedGeometry;
}

/** Black-painted outlaw with white scoring rings, mapped to shape coordinates. */
export function silhouetteMaterial() {
  if (sharedMaterial) return sharedMaterial;
  const w = BOUNDS.maxX - BOUNDS.minX;
  const h = BOUNDS.maxY - BOUNDS.minY;
  const [c, g] = makeCanvas(256, 820);
  const px = (x) => ((x - BOUNDS.minX) / w) * c.width;
  const py = (y) => c.height - ((y - BOUNDS.minY) / h) * c.height;
  const pr = (r) => (r / w) * c.width;

  g.fillStyle = '#26211d';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 6);
  }
  g.strokeStyle = '#efe6d2';
  g.lineWidth = 4;
  for (const r of [HEART_R, CHEST_R]) {
    g.beginPath();
    g.arc(px(HEART.x), py(HEART.y), pr(r), 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#efe6d2';
  g.beginPath();
  g.arc(px(HEART.x), py(HEART.y), pr(0.015), 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 0.5;
  g.beginPath();
  g.arc(px(HEAD.x), py(HEAD.y), pr(0.06), 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
  // Hat band
  g.fillStyle = '#7a2a1c';
  g.fillRect(px(-0.1), py(1.7), pr(0.2), pr(0.025));

  const tex = canvasToTexture(c, { repeat: false });
  // ExtrudeGeometry cap UVs are raw shape coordinates; map them onto the canvas.
  tex.repeat.set(1 / w, 1 / h);
  tex.offset.set(-BOUNDS.minX / w, -BOUNDS.minY / h);
  sharedMaterial = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  return sharedMaterial;
}

/**
 * Score a hit on the outlaw silhouette from its point in board coordinates:
 * head / hat / heart ring / chest ring / body, with base points and precision.
 */
export function silhouetteZone(p) {
  const dHead = Math.hypot(p.x - HEAD.x, p.y - HEAD.y);
  const dHeart = Math.hypot(p.x - HEART.x, p.y - HEART.y);
  if (dHead <= HEAD.r) return { zone: 'head', label: 'HEADSHOT', base: 100, precision: 1 - 0.3 * (dHead / HEAD.r) };
  if (p.y >= HAT_Y) return { zone: 'hat', label: 'HAT SHOT', base: 20, precision: 0.3 };
  if (dHeart <= HEART_R) return { zone: 'heart', label: 'BULLSEYE', base: 100, precision: 1 - 0.2 * (dHeart / HEART_R) };
  if (dHeart <= CHEST_R) {
    return { zone: 'chest', label: 'CHEST', base: 70, precision: 0.8 - 0.3 * ((dHeart - HEART_R) / (CHEST_R - HEART_R)) };
  }
  return { zone: 'body', label: 'BODY', base: 40, precision: Math.max(0.1, 0.5 - (dHeart - CHEST_R) * 0.6) };
}

let standMaterial = null;
let armGeometry = null;
let glintTexture = null;
const armMaterial = new THREE.MeshStandardMaterial({ color: 0x26211d, roughness: 0.8 });

// Gun arm: hinged at the right shoulder; hangs at his side, swings up and
// toward the player to shoot (duel mode only).
const SHOULDER = new THREE.Vector3(0.22, 1.33, 0.03);
const ARM_REST = { z: -1.35, y: 0 };
const ARM_AIM = { z: 0.12, y: -0.75 };
const ARM_SPEED = 3.2; // aim level per second (~0.3 s to raise)
const MUZZLE = new THREE.Vector3(0.47, 0.035, 0.012);

/** A cardboard sleeve with a revolver at the end, along +X from the shoulder. */
function gunArmGeometry() {
  if (armGeometry) return armGeometry;
  const s = new THREE.Shape();
  s.moveTo(0, -0.04);
  s.lineTo(0.3, -0.035); // sleeve
  s.lineTo(0.31, -0.06); // grip
  s.lineTo(0.35, -0.06);
  s.lineTo(0.345, 0.0);
  s.lineTo(0.47, 0.012); // barrel
  s.lineTo(0.47, 0.045);
  s.lineTo(0.33, 0.045); // hammer
  s.lineTo(0.32, 0.06);
  s.lineTo(0.3, 0.035);
  s.lineTo(0, 0.04);
  s.closePath();
  armGeometry = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false });
  return armGeometry;
}

/** A four-pointed sun glint, for the flash on his gun as he takes aim. */
function glintSprite() {
  glintTexture ??= (() => {
    const [c, g] = makeCanvas(128, 128);
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,240,200,0.8)');
    grad.addColorStop(1, 'rgba(255,220,150,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.moveTo(64, 0); g.lineTo(70, 64); g.lineTo(64, 128); g.lineTo(58, 64); g.fill();
    g.beginPath(); g.moveTo(0, 64); g.lineTo(64, 58); g.lineTo(128, 64); g.lineTo(64, 70); g.fill();
    return canvasToTexture(c, { repeat: false });
  })();
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glintTexture, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  sprite.visible = false;
  sprite.raycast = () => {};
  return sprite;
}

/**
 * Spring-loaded pop-up outlaw for quick-draw duels. Rises on a hinge, scores by
 * zone (head / heart ring / chest ring / body / hat) and reaction time, then
 * gets knocked flat by the hit.
 */
export class Duelist {
  /**
   * @param {THREE.Vector3} position base of the stand
   * @param {THREE.Vector3} faceTowards the firing line
   */
  constructor(position, faceTowards) {
    this.type = 'duelist';
    this.object = new THREE.Group();
    this.object.name = 'duelist';
    this.object.position.copy(position);
    this.object.rotation.y = Math.atan2(faceTowards.x - position.x, faceTowards.z - position.z);

    standMaterial ??= new THREE.MeshStandardMaterial({ map: plankTexture('#5e3d24', 6), roughness: 0.85 });
    const stand = new THREE.Mesh(worldBox(0.7, 0.15, 0.3), standMaterial);
    stand.position.y = 0.075;
    stand.castShadow = stand.receiveShadow = true;
    stand.userData.surface = 'wood';
    this.object.add(stand);

    this.hinge = new THREE.Group();
    this.hinge.position.y = 0.15;
    this.object.add(this.hinge);

    this.board = new THREE.Mesh(silhouetteGeometry(), silhouetteMaterial());
    this.board.position.z = -0.01;
    this.board.castShadow = this.board.receiveShadow = true;
    this.board.userData.surface = 'wood';
    this.board.userData.target = this;
    this.board.name = 'duelistBoard';
    this.hinge.add(this.board);

    this.shoulder = new THREE.Group();
    this.shoulder.position.copy(SHOULDER);
    this.board.add(this.shoulder);
    this.arm = new THREE.Mesh(gunArmGeometry(), armMaterial); // too thin to need a shadow
    this.arm.raycast = () => {}; // the arm is decoration; the body is the target
    this.shoulder.add(this.arm);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.copy(MUZZLE);
    this.shoulder.add(this.muzzle);
    this.glint = glintSprite();
    this.muzzle.add(this.glint);
    /** 0 = arm hanging at his side, 1 = aimed at the player. */
    this.aimLevel = 0;
    this.aimTarget = 0;
    this.glintTime = 0;
    this.flashTime = 0;
    this.#poseArm();

    this.stand = stand;
    this.staticColliders = [];
    /** Shown and shootable only while a game mode uses the duelists. */
    this.active = true;
    /** Physics bodies (stand, board) — removed from the world while inactive. */
    this.bodies = [];
    this.physics = null;
    this.state = 'down'; // down | rising | up | falling
    this.angle = DOWN_ANGLE;
    this.angVel = 0;
    this.stateTime = 0;
    this.popTime = 0;
    /** Called with (duelist, 'hit' | 'timeout') when a pop-up resolves. */
    this.onResolved = null;
    this.hinge.rotation.x = this.angle;
  }

  activeColliders() {
    return this.active ? [this.board, this.stand] : [];
  }

  /** Show (active) or hide the duelist, its stand and its physics bodies. */
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.object.visible = active;
    if (!active) {
      this.state = 'down';
      this.angle = DOWN_ANGLE;
      this.angVel = 0;
      this.hinge.rotation.x = this.angle;
    }
    for (const b of this.bodies) {
      if (active) this.physics?.addBody(b);
      else this.physics?.removeBody(b);
    }
  }

  /** World position of the head centre (for UI pop-ups). */
  headPosition(target = new THREE.Vector3()) {
    return this.board.localToWorld(target.set(HEAD.x, HEAD.y, 0.02));
  }

  get isLive() {
    return this.state === 'rising' || this.state === 'up';
  }

  popUp(now) {
    if (this.state !== 'down' || !this.active) return false;
    this.state = 'rising';
    this.stateTime = 0;
    this.popTime = now;
    return true;
  }

  /** Knocked over by something other than a bullet (a thrown revolver). */
  knock() {
    if (!this.isLive) return false;
    this.state = 'falling';
    this.angVel = -3;
    this.onResolved?.(this, 'knocked');
    return true;
  }

  /** Drop back down without a result (the duel mode's outlaw after he fires). */
  /** Raise (1) or lower (0) the gun arm; it moves there at ARM_SPEED. */
  aim(target) {
    this.aimTarget = target;
  }

  /** The glint on his gun as he takes aim (the dodge cue). */
  glintNow() {
    this.glintTime = 0.3;
  }

  /** Muzzle flash on the cardboard gun, and the arm kicks up with the recoil. */
  fireFlash() {
    this.flashTime = 0.1;
    this.aimLevel = Math.max(0, this.aimLevel - 0.35);
  }

  /** World position of the gun's muzzle. */
  muzzleWorld(target = new THREE.Vector3()) {
    this.muzzle.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  #poseArm() {
    const k = THREE.MathUtils.smoothstep(this.aimLevel, 0, 1);
    this.shoulder.rotation.set(0, ARM_REST.y + (ARM_AIM.y - ARM_REST.y) * k, ARM_REST.z + (ARM_AIM.z - ARM_REST.z) * k, 'YZX');
  }

  retire() {
    if (!this.isLive) return false;
    this.state = 'falling';
    this.angVel = -1;
    this.onResolved?.(this, 'retired');
    return true;
  }

  /** @returns {object|null} scoring result, or null if not a live target */
  onHit(hit, shot, now) {
    if (!this.isLive) return null;
    const { zone, label, base, precision } = silhouetteZone(this.board.worldToLocal(hit.point.clone()));

    // Knocked backwards, harder for a centred hit.
    this.state = 'falling';
    this.angVel = -4 - precision * 3;
    this.onResolved?.(this, 'hit');
    return { type: 'duelist', zone, label, base, precision, reaction: now - this.popTime };
  }

  update(dt) {
    this.stateTime += dt;
    if (this.state === 'rising') {
      const t = Math.min(1, this.stateTime / RISE_TIME);
      // Ease-out-back: slight overshoot like a spring-loaded arm.
      const c1 = 1.70158;
      const e = 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      this.angle = DOWN_ANGLE * (1 - e);
      if (t >= 1) {
        this.state = 'up';
        this.stateTime = 0;
        this.angle = 0;
      }
    } else if (this.state === 'up') {
      if (this.stateTime >= UP_WINDOW) {
        this.state = 'falling';
        this.angVel = -0.5;
        this.onResolved?.(this, 'timeout');
      }
    } else if (this.state === 'falling') {
      this.angVel -= 18 * dt;
      this.angle += this.angVel * dt;
      if (this.angle <= DOWN_ANGLE) {
        this.angle = DOWN_ANGLE;
        if (Math.abs(this.angVel) > 1.5) {
          this.angVel = -this.angVel * 0.25; // bounce off the stand
        } else {
          this.angVel = 0;
          this.state = 'down';
          this.stateTime = 0;
        }
      }
    }
    this.hinge.rotation.x = this.angle;

    // Gun arm and its flashes.
    if (this.state === 'down' || this.state === 'falling') this.aimTarget = 0;
    const step = ARM_SPEED * dt;
    this.aimLevel += THREE.MathUtils.clamp(this.aimTarget - this.aimLevel, -step, step);
    this.#poseArm();
    this.glintTime = Math.max(0, this.glintTime - dt);
    this.flashTime = Math.max(0, this.flashTime - dt);
    const g = this.glint;
    if (this.flashTime > 0) {
      g.visible = true;
      g.material.color.setHex(0xffa040);
      g.scale.setScalar(0.9);
    } else if (this.glintTime > 0) {
      g.visible = true;
      g.material.color.setHex(0xffffff);
      // Big enough to catch the eye at 15 m: the dodge cue.
      g.scale.setScalar(0.4 + 0.3 * Math.sin((0.3 - this.glintTime) * 40) ** 2);
    } else {
      g.visible = false;
    }
  }
}
