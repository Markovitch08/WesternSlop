import * as THREE from 'three';
import { dustSprite } from '../util/canvasTextures.js';

const _c = new THREE.Color();

/**
 * Pooled CPU particles drawn as one THREE.Points (one draw call). Each
 * particle has its own size, alpha and colour; the built-in PointsMaterial is
 * patched to read per-vertex size and alpha, so size attenuation still works
 * in XR.
 */
export class ParticleSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {{ max?: number, additive?: boolean, name?: string }} opts
   */
  constructor(scene, { max = 256, additive = false, name = 'particles' } = {}) {
    this.max = max;
    this.next = 0;
    this.p = Array.from({ length: max }, () => ({
      alive: false, age: 0, life: 1,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      size0: 0.1, size1: 0.1, alpha0: 1, drag: 0, gravity: 0, buoyancy: 0, wind: 0,
    }));

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.alphas = new Float32Array(max);
    this.colors = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.PointsMaterial({
      size: 1, map: dustSprite(), vertexColors: true, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSize;\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vAlpha;');
    };
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = name;
    this.points.raycast = () => {};
    scene.add(this.points);
  }

  get activeCount() {
    let n = 0;
    for (const p of this.p) if (p.alive) n++;
    return n;
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} vel
   * @param {object} o life (s), size0/size1 (m), alpha0, color (hex), drag (1/s),
   *   gravity (m/s², down), buoyancy (m/s², up), wind (0..1 how much wind carries it)
   */
  emit(pos, vel, o = {}) {
    const p = this.p[this.next];
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    p.alive = true;
    p.age = 0;
    p.life = o.life ?? 1;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.size0 = o.size0 ?? 0.1;
    p.size1 = o.size1 ?? p.size0;
    p.alpha0 = o.alpha0 ?? 1;
    p.drag = o.drag ?? 0;
    p.gravity = o.gravity ?? 0;
    p.buoyancy = o.buoyancy ?? 0;
    p.wind = o.wind ?? 0;
    _c.set(o.color ?? 0xffffff);
    this.colors[i * 3] = _c.r;
    this.colors[i * 3 + 1] = _c.g;
    this.colors[i * 3 + 2] = _c.b;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  /** @param {number} dt @param {THREE.Vector3} [wind] m/s */
  update(dt, wind = null) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      const p = this.p[i];
      if (!p.alive) continue;
      any = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vel.multiplyScalar(k);
      p.vel.y += (p.buoyancy - p.gravity) * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (wind && p.wind) p.pos.addScaledVector(wind, p.wind * dt);
      const t = p.age / p.life;
      this.positions[i * 3] = p.pos.x;
      this.positions[i * 3 + 1] = p.pos.y;
      this.positions[i * 3 + 2] = p.pos.z;
      this.sizes[i] = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      // Quick fade-in, long fade-out.
      this.alphas[i] = p.alpha0 * Math.min(1, t * 12) * (1 - t) * (1 - t);
    }
    if (any) {
      const a = this.points.geometry.attributes;
      a.position.needsUpdate = true;
      a.aSize.needsUpdate = true;
      a.aAlpha.needsUpdate = true;
    }
  }
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const rand = (s = 1) => (Math.random() * 2 - 1) * s;

/**
 * Gun and impact effects: black-powder muzzle smoke and sparks, dust puffs
 * on sand and wood, sparks off steel.
 */
export class ParticleFX {
  constructor(scene) {
    this.smoke = new ParticleSystem(scene, { max: 320, name: 'smoke' });
    this.sparks = new ParticleSystem(scene, { max: 160, additive: true, name: 'sparks' });
    this.wind = new THREE.Vector3(0.55, 0.05, -0.18); // matches the dust motes
  }

  /** Big white black-powder cloud plus a spray of burning grains. */
  muzzle(origin, dir) {
    for (let i = 0; i < 14; i++) {
      const speed = 1 + Math.random() * 5;
      _v.copy(dir).multiplyScalar(speed).add(_n.set(rand(0.6), rand(0.6) + 0.2, rand(0.6)));
      this.smoke.emit(origin, _v, {
        life: 2.2 + Math.random() * 1.6, size0: 0.05, size1: 0.45 + Math.random() * 0.35,
        alpha0: 0.38, color: 0xdedad2, drag: 3.2, buoyancy: 0.12, wind: 0.8,
      });
    }
    for (let i = 0; i < 10; i++) {
      _v.copy(dir).multiplyScalar(10 + Math.random() * 10).add(_n.set(rand(2), rand(2), rand(2)));
      this.sparks.emit(origin, _v, {
        life: 0.08 + Math.random() * 0.12, size0: 0.025, size1: 0.01,
        alpha0: 1, color: Math.random() < 0.5 ? 0xffc060 : 0xff8a30, drag: 4, gravity: 9.81,
      });
    }
  }

  /**
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal surface normal (world)
   * @param {string} surface
   * @param {THREE.Vector3} [dir] bullet direction
   */
  impact(point, normal, surface, dir = null) {
    if (surface === 'steel') {
      // Ricochet sparks reflect off the plate.
      const refl = dir ? _n.copy(dir).reflect(normal) : _n.copy(normal);
      for (let i = 0; i < 14; i++) {
        _v.copy(refl).multiplyScalar(3 + Math.random() * 6).add(new THREE.Vector3(rand(2.5), rand(2.5), rand(2.5)));
        this.sparks.emit(point, _v, {
          life: 0.15 + Math.random() * 0.25, size0: 0.02, size1: 0.008,
          alpha0: 1, color: Math.random() < 0.5 ? 0xffe0a0 : 0xffa040, drag: 2, gravity: 9.81,
        });
      }
      for (let i = 0; i < 3; i++) {
        _v.copy(normal).multiplyScalar(0.4).add(new THREE.Vector3(rand(0.2), rand(0.2), rand(0.2)));
        this.smoke.emit(point, _v, { life: 0.9, size0: 0.03, size1: 0.16, alpha0: 0.3, color: 0x9a9894, drag: 3, wind: 0.6 });
      }
      return;
    }
    const sand = surface === 'sand';
    const count = sand ? 9 : 5;
    const color = sand ? 0xc49a6a : surface === 'plant' ? 0x6f8a4a : 0x8f6c4c;
    for (let i = 0; i < count; i++) {
      _v.copy(normal).multiplyScalar(0.8 + Math.random() * 1.8).add(new THREE.Vector3(rand(0.7), rand(0.4), rand(0.7)));
      this.smoke.emit(point, _v, {
        life: 0.9 + Math.random() * 0.8, size0: 0.04, size1: sand ? 0.32 : 0.18,
        alpha0: 0.55, color, drag: 3.5, gravity: sand ? 1.2 : 0.4, wind: 0.6,
      });
    }
  }

  update(dt) {
    this.smoke.update(dt, this.wind);
    this.sparks.update(dt);
  }
}
