import * as THREE from 'three';
import { dustSprite } from '../util/canvasTextures.js';
import { worldBox, place, merge } from '../util/geometry.js';

/** Golden-hour palette. */
const SUN_COLOR = 0xffb56b;
const SUN_INTENSITY = 2.5;
const AMBIENT_COLOR = 0x332244; // cool fill: shadows read blue-violet against warm light
const AMBIENT_INTENSITY = 1.6;
const FOG_COLOR = 0xc29b6c;
const FOG_DENSITY = 0.015;

const DUST_COUNT = 800;
const DUST_BOX = { halfX: 14, height: 5, halfZ: 16 }; // around the player
const TUMBLEWEED_COUNT = 2;
const TUMBLE_RADIUS = 0.32;
const TUMBLE_AREA = 34; // |x| or |z| beyond this and it respawns upwind

const SUNSET_RED = new THREE.Color(0xff8a52);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Global wind: a prevailing breeze plus slow gusts and veer, as a shared
 * Vector3 (m/s) that dust, smoke, tumbleweeds, lanterns and the wind audio all
 * read. `gust` is 0..1, how hard it is blowing right now.
 */
export class Wind {
  constructor(base = new THREE.Vector3(1.1, 0, -0.35)) {
    this.base = base.clone();
    this.vector = base.clone();
    this.gust = 0;
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    // Sum of slow sines: gusts every ~6-15 s, a gentle veer over ~40 s.
    const g = 0.5 + 0.3 * Math.sin(t * 0.41) + 0.15 * Math.sin(t * 1.07 + 1.3) + 0.05 * Math.sin(t * 2.9);
    this.gust = THREE.MathUtils.clamp(g, 0, 1);
    const veer = 0.35 * Math.sin(t * 0.15);
    this.vector.copy(this.base).applyAxisAngle(THREE.Object3D.DEFAULT_UP, veer).multiplyScalar(0.4 + this.gust * 1.4);
    return this.vector;
  }
}

/**
 * Light and air for the range: golden-hour sun with soft shadows, a cool
 * ambient fill, image-based lighting for metals, exponential dust-haze fog,
 * a sky dome that melts into it, wind, floating dust, rolling tumbleweeds and
 * two hanging oil lanterns with flickering lights.
 */
export class AtmosphereManager {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ groundColliders: THREE.Object3D[], physics?: import('../physics/PhysicsWorld.js').PhysicsWorld }} opts
   *   groundColliders: what tumbleweeds raycast down onto
   */
  constructor(scene, renderer, { groundColliders, physics = null }) {
    this.scene = scene;
    this.time = 0;
    this.wind = new Wind();
    /** Meshes bullets can hit (lantern posts and lanterns, tumbleweeds). */
    this.colliders = [];
    this.groundColliders = groundColliders;
    this.raycaster = new THREE.Raycaster();

    this.#buildSkyAndFog(renderer);
    this.#buildLights();
    this.dust = this.#buildDust();
    this.tumbleweeds = Array.from({ length: TUMBLEWEED_COUNT }, (_, i) => this.#buildTumbleweed(i));
    this.lanterns = [
      this.#buildLantern(new THREE.Vector3(1.6, 0, -0.9), -1, true, physics),
      this.#buildLantern(new THREE.Vector3(-2.45, 0, -4.0), 1, false, physics),
    ];
    this.update(0);
  }

  // -------------------------------------------------------------------------
  // Sky, fog, light
  // -------------------------------------------------------------------------
  #buildSkyAndFog(renderer) {
    const fog = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.FogExp2(fog, FOG_DENSITY);
    this.scene.background = fog;
    this.scene.environment = createGoldenEnvMap(renderer);
    this.scene.environmentIntensity = 0.55; // keep the IBL from washing out the contrast
    this.sky = createSkyDome(fog);
    this.scene.add(this.sky);
  }

  #buildLights() {
    this.ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
    this.scene.add(this.ambient);

    // Low golden-hour sun: long, soft shadows across the range.
    const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -18; sc.right = 18; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 110;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    sun.target.position.set(0, 0, -14);
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.sunDir = new THREE.Vector3();
  }

  // -------------------------------------------------------------------------
  // Dust
  // -------------------------------------------------------------------------
  #buildDust() {
    const n = DUST_COUNT;
    const positions = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = (Math.random() * 2 - 1) * DUST_BOX.halfX;
      positions[i * 3 + 1] = Math.random() * DUST_BOX.height;
      positions[i * 3 + 2] = (Math.random() * 2 - 1) * DUST_BOX.halfZ;
      seeds[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.04, map: dustSprite(), color: 0xf3d6a8, transparent: true, opacity: 0.55,
      depthWrite: false, sizeAttenuation: true,
    }));
    points.frustumCulled = false;
    points.name = 'dust';
    points.raycast = () => {};
    this.scene.add(points);
    return { points, positions, seeds, count: n, center: new THREE.Vector3() };
  }

  #updateDust(dt, center) {
    const d = this.dust;
    const { positions: p, seeds } = d;
    const w = this.wind.vector;
    const t = this.time;
    d.center.copy(center);
    for (let i = 0; i < d.count; i++) {
      const s = seeds[i];
      const ix = i * 3;
      // Wind carries it; turbulence swirls it; a slight lift keeps it airborne.
      p[ix] += (w.x * 0.8 + Math.sin(t * 0.9 + s) * 0.25) * dt;
      p[ix + 1] += (0.03 + Math.sin(t * 0.7 + s * 1.7) * 0.06) * dt;
      p[ix + 2] += (w.z * 0.8 + Math.cos(t * 0.6 + s * 0.7) * 0.25) * dt;
      // Keep the cloud wrapped around the player.
      const rx = p[ix] - center.x;
      const rz = p[ix + 2] - center.z;
      if (rx > DUST_BOX.halfX) p[ix] -= 2 * DUST_BOX.halfX;
      else if (rx < -DUST_BOX.halfX) p[ix] += 2 * DUST_BOX.halfX;
      if (rz > DUST_BOX.halfZ) p[ix + 2] -= 2 * DUST_BOX.halfZ;
      else if (rz < -DUST_BOX.halfZ) p[ix + 2] += 2 * DUST_BOX.halfZ;
      if (p[ix + 1] > DUST_BOX.height) p[ix + 1] = 0.05;
      else if (p[ix + 1] < 0.05) p[ix + 1] = DUST_BOX.height;
    }
    d.points.geometry.attributes.position.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Tumbleweeds
  // -------------------------------------------------------------------------
  #buildTumbleweed(i) {
    // A lumpy low-poly ball of twigs: jittered icosahedron + its edges as sticks.
    const geo = new THREE.IcosahedronGeometry(TUMBLE_RADIUS, 1);
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      _v.fromBufferAttribute(pos, k).multiplyScalar(0.8 + Math.random() * 0.35);
      pos.setXYZ(k, _v.x, _v.y, _v.z);
    }
    geo.computeVertexNormals();
    const group = new THREE.Group();
    group.name = 'tumbleweed';
    const ball = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x8f7044, roughness: 1, flatShading: true, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    ball.castShadow = true;
    ball.userData.surface = 'plant';
    ball.userData.noDecal = true;
    ball.name = 'tumbleweedBall';
    const twigs = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), new THREE.LineBasicMaterial({ color: 0x5e4526 }));
    twigs.raycast = () => {};
    const spin = new THREE.Group();
    spin.add(ball, twigs);
    group.add(spin);
    this.scene.add(group);

    const tw = { group, spin, ball, vel: new THREE.Vector3(), grounded: false, hopTimer: 1 + Math.random() * 2 };
    ball.userData.onBulletHit = (hit, shot) => {
      // A bullet knocks it along and up.
      tw.vel.addScaledVector(shot.direction, 3).add(_v.set(0, 2.5, 0));
    };
    this.colliders.push(ball);
    this.#respawnTumbleweed(tw, i * 14);
    return tw;
  }

  /** Put a tumbleweed back on the upwind edge of the range. */
  #respawnTumbleweed(tw, offset = 0) {
    const w = _v2.copy(this.wind.base).normalize();
    const side = new THREE.Vector3(-w.z, 0, w.x);
    tw.group.position.set(0, TUMBLE_RADIUS, -12)
      .addScaledVector(w, -TUMBLE_AREA + 2 + offset)
      .addScaledVector(side, (Math.random() * 2 - 1) * 12);
    tw.vel.set(0, 0, 0);
  }

  /** Ground height under `pos` (raycast down onto the ground colliders). */
  groundHeight(pos) {
    this.raycaster.set(_v.set(pos.x, pos.y + 1.5, pos.z), _down);
    this.raycaster.far = 6;
    const hit = this.raycaster.intersectObjects(this.groundColliders, false)[0];
    return hit ? hit.point.y : 0;
  }

  #updateTumbleweed(tw, dt) {
    const p = tw.group.position;
    const w = this.wind.vector;
    // Drag couples it to the wind (it's mostly air); gravity pulls it down.
    tw.vel.x += (w.x * 1.6 - tw.vel.x) * Math.min(1, dt * 1.2);
    tw.vel.z += (w.z * 1.6 - tw.vel.z) * Math.min(1, dt * 1.2);
    tw.vel.y -= 9.81 * dt;
    p.addScaledVector(tw.vel, dt);

    // Sphere-on-ground contact from a downward raycast.
    const floor = this.groundHeight(p) + TUMBLE_RADIUS;
    tw.grounded = p.y <= floor + 0.005;
    if (p.y < floor) {
      p.y = floor;
      if (tw.vel.y < -0.6) tw.vel.y *= -0.35; // bounce
      else tw.vel.y = 0;
      tw.hopTimer -= dt;
      if (tw.hopTimer <= 0) {
        // Gusts and bumps send it skipping.
        tw.vel.y = 1.2 + this.wind.gust * 2.2 * Math.random();
        tw.hopTimer = 0.6 + Math.random() * 2;
      }
    }

    // Roll: rotate about the axis perpendicular to the ground velocity.
    const speed = Math.hypot(tw.vel.x, tw.vel.z);
    if (speed > 1e-3) {
      _axis.set(tw.vel.z, 0, -tw.vel.x).normalize();
      _q.setFromAxisAngle(_axis, (speed * dt) / TUMBLE_RADIUS);
      tw.spin.quaternion.premultiply(_q);
    }

    if (Math.abs(p.x) > TUMBLE_AREA || Math.abs(p.z + 12) > TUMBLE_AREA) this.#respawnTumbleweed(tw);
  }

  // -------------------------------------------------------------------------
  // Lanterns
  // -------------------------------------------------------------------------
  /**
   * Oil lantern hanging from a gallows post. One lantern casts shadows from a
   * small, short-range cube map (cheap enough for Quest).
   * @param {THREE.Vector3} base post position
   * @param {number} armDir which way the arm reaches (+1 / -1 along x)
   */
  #buildLantern(base, armDir, castShadow, physics) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.9 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x2a2826, metalness: 0.7, roughness: 0.5 });
    const H = 2.3;
    const ARM = 0.42;
    const post = new THREE.Mesh(merge([
      place(worldBox(0.08, H, 0.08), 0, H / 2, 0),
      place(worldBox(ARM + 0.08, 0.06, 0.06), (armDir * ARM) / 2, H - 0.06, 0),
    ]), wood);
    post.position.copy(base);
    post.castShadow = post.receiveShadow = true;
    post.userData.surface = 'wood';
    post.name = 'lanternPost';
    this.scene.add(post);
    this.colliders.push(post);
    if (physics) {
      physics.addStaticBox(base.clone().setY(H / 2), new THREE.Vector3(0.04, H / 2, 0.04));
    }

    // The lantern swings on a short chain from the end of the arm.
    const pivot = new THREE.Group();
    pivot.position.set(base.x + armDir * ARM, H - 0.08, base.z);
    this.scene.add(pivot);
    const body = new THREE.Group();
    body.position.y = -0.26;
    pivot.add(body);
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.14, 4), iron);
    chain.position.y = -0.07;
    chain.raycast = () => {};
    pivot.add(chain);

    const frame = new THREE.Mesh(merge([
      place(new THREE.CylinderGeometry(0.06, 0.075, 0.03, 8), 0, 0.12, 0), // cap
      place(new THREE.CylinderGeometry(0.07, 0.07, 0.025, 8), 0, -0.09, 0), // base
      place(new THREE.TorusGeometry(0.035, 0.005, 4, 10), 0, 0.15, 0, Math.PI / 2), // handle
      ...[0, 1, 2, 3].map((k) => place(new THREE.BoxGeometry(0.006, 0.2, 0.006), Math.cos(k * Math.PI / 2 + 0.78) * 0.062, 0.015, Math.sin(k * Math.PI / 2 + 0.78) * 0.062)),
    ]), iron);
    frame.castShadow = true;
    frame.userData.surface = 'steel';
    frame.name = 'lantern';
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.18, 10, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xffc070, emissive: 0xff9a40, emissiveIntensity: 1.2, transparent: true, opacity: 0.55, roughness: 0.2 }),
    );
    glass.position.y = 0.015;
    glass.raycast = () => {};
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe0a0 }),
    );
    flame.scale.y = 1.8;
    flame.raycast = () => {};
    body.add(frame, glass, flame);
    this.colliders.push(frame);

    // Reach 5 m; three.js also uses `distance` as the shadow camera's far
    // plane, which keeps the cube-map shadow pass to nearby objects.
    const light = new THREE.PointLight(0xffa04a, 3.5, 5, 2);
    light.position.y = 0.01;
    light.castShadow = castShadow;
    if (castShadow) {
      light.shadow.mapSize.set(256, 256);
      light.shadow.camera.near = 0.08;
      light.shadow.bias = -0.002;
      light.shadow.radius = 2;
    }
    body.add(light);

    return {
      post, pivot, body, light, glass, flame, shadowCapable: castShadow,
      base: light.intensity, phase: Math.random() * 100,
      swing: 0, swingVel: 0, roll: 0, rollVel: 0,
    };
  }

  #updateLantern(l, dt) {
    const t = this.time + l.phase;
    // Flame flicker: layered sines plus a little jitter, with an occasional gutter.
    const gutter = Math.max(0, Math.sin(t * 0.37) - 0.92) * 4;
    const f = 0.82 + 0.09 * Math.sin(t * 11.3) + 0.06 * Math.sin(t * 23.7 + 1.1) + 0.05 * (Math.random() - 0.5) - gutter * 0.3;
    l.light.intensity = l.base * f;
    l.glass.material.emissiveIntensity = 0.7 + f * 0.7;
    l.flame.scale.set(1 + 0.15 * Math.sin(t * 17), 1.6 + 0.4 * Math.sin(t * 13 + 2), 1);
    l.flame.position.x = 0.004 * Math.sin(t * 9);

    // The wind swings it on its chain (damped pendulum, ~0.34 m long): the
    // light and its shadows move with it.
    const w = this.wind.vector;
    const push = 0.08 * this.wind.gust;
    l.swingVel += (-(9.81 / 0.34) * Math.sin(l.swing) - 1.2 * l.swingVel + w.z * push * 8) * dt;
    l.swing += l.swingVel * dt;
    l.rollVel += (-(9.81 / 0.34) * Math.sin(l.roll) - 1.2 * l.rollVel - w.x * push * 8) * dt;
    l.roll += l.rollVel * dt;
    l.pivot.rotation.set(l.swing, 0, l.roll);
  }

  /**
   * Quality preset: shadow map size and softness, lantern shadows, dust count.
   * @param {'high'|'medium'|'low'} q
   */
  setQuality(q, renderer) {
    const p = {
      high: { map: 2048, soft: true, lantern: true, dust: DUST_COUNT },
      medium: { map: 1024, soft: false, lantern: false, dust: 500 },
      low: { map: 512, soft: false, lantern: false, dust: 250 },
    }[q];
    this.quality = q;
    if (this.sun.shadow.mapSize.x !== p.map) {
      this.sun.shadow.mapSize.set(p.map, p.map);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    for (const l of this.lanterns) {
      if (l.shadowCapable) l.light.castShadow = p.lantern;
    }
    this.dust.points.geometry.setDrawRange(0, p.dust);
    const type = p.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (renderer.shadowMap.type !== type) {
      renderer.shadowMap.type = type;
      this.scene.traverse((o) => {
        if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------
  update(dt, camera = null) {
    this.time += dt;
    this.wind.update(dt);

    // Golden hour: a low sun drifting slowly; it reddens as it sinks.
    const t = this.time;
    const azimuth = 2.35 + Math.sin((t / 600) * Math.PI * 2) * 0.3;
    const elevation = 0.36 + Math.sin((t / 900) * Math.PI * 2) * 0.08;
    this.sunDir.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth));
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 60);
    this.sun.color.setHex(SUN_COLOR).lerp(SUNSET_RED, THREE.MathUtils.smoothstep(0.36 - elevation, 0, 0.1) * 0.4);

    const center = camera ? camera.getWorldPosition(_v) : _v.set(0, 1.6, 0);
    this.#updateDust(dt, center);
    for (const tw of this.tumbleweeds) this.#updateTumbleweed(tw, dt);
    for (const l of this.lanterns) this.#updateLantern(l, dt);
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Gradient dome whose horizon is exactly the fog colour, so they melt together. */
function createSkyDome(fogColor) {
  const R = 280;
  const geo = new THREE.SphereGeometry(R, 32, 16);
  const low = new THREE.Color(0xe0a868); // amber glow just above the haze
  const mid = new THREE.Color(0xc7b6a4);
  const zenith = new THREE.Color(0x5a7db0);
  const col = new THREE.Color();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R;
    if (y <= 0.02) col.copy(fogColor);
    else if (y < 0.12) col.lerpColors(fogColor, low, (y - 0.02) / 0.1);
    else if (y < 0.35) col.lerpColors(low, mid, (y - 0.12) / 0.23);
    else col.lerpColors(mid, zenith, Math.min(1, (y - 0.35) / 0.5));
    colors.set([col.r, col.g, col.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -1;
  dome.name = 'sky';
  dome.raycast = () => {};
  return dome;
}

/** Pre-filtered golden-hour sky over sand, with the low sun as a hot spot. */
function createGoldenEnvMap(renderer) {
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const colors = [];
  const pos = geo.attributes.position;
  const sky = new THREE.Color(0x8fa6c8);
  const horizon = new THREE.Color(0xf0b878);
  const sand = new THREE.Color(0x7a5230);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y > 0) c.lerpColors(horizon, sky, Math.pow(y, 0.6));
    else c.lerpColors(horizon, sand, Math.min(1, -y * 3));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  envScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffc888 }));
  sunDisc.position.set(Math.sin(2.35) * 9, 3.4, Math.cos(2.35) * 9);
  envScene.add(sunDisc);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  geo.dispose();
  return target.texture;
}
