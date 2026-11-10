import * as THREE from 'three';
import { plankTexture, sandTexture, dustSprite, signTexture } from './util/canvasTextures.js';
import { worldBox, place, tint, merge, barrelGeometry } from './util/geometry.js';

/**
 * Desert shooting range: sky dome, slowly drifting afternoon sun with shadows,
 * sand floor, saloon facade, barrels, cacti, fences, distance markers, far
 * mesas and drifting dust motes.
 *
 * Every mesh a bullet can hit is returned in `colliders`, tagged with
 * `userData.surface` ('sand' | 'wood' | 'plant' | 'steel') so impacts can pick
 * sounds and decals.
 *
 * Draw-call budget matters on Quest: static props are merged per material or
 * instanced.
 *
 * Solid props are also registered as static boxes in the physics world, so a
 * dropped or thrown revolver lands on them.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {import('./physics/PhysicsWorld.js').PhysicsWorld} physics
 */
export function createEnvironment(scene, renderer, physics) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const yawQ = (ry) => new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, ry);
  const colliders = [];
  const solid = (mesh, surface, { cast = true, receive = true } = {}) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.userData.surface = surface;
    colliders.push(mesh);
    scene.add(mesh);
    return mesh;
  };

  // --- Sky, fog and image-based lighting ------------------------------------
  const horizon = new THREE.Color(0xecd2a6);
  scene.background = horizon;
  scene.fog = new THREE.Fog(horizon, 45, 260);
  scene.environment = createDesertEnvMap(renderer);
  scene.add(createSkyDome(horizon));

  const hemi = new THREE.HemisphereLight(0xfff1d6, 0xa0703f, 0.55);
  scene.add(hemi);

  // --- Sun -----------------------------------------------------------------------
  // The shadow frustum is a fixed box over the range (bench to saloon), so the
  // map resolution is spent where the player looks.
  const sun = new THREE.DirectionalLight(0xffd9a0, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -16; sc.right = 16; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 90;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.target.position.set(0, 0, -14);
  scene.add(sun, sun.target);
  const sunWarm = new THREE.Color(0xffb070);
  const sunHigh = new THREE.Color(0xfff0d8);

  // --- Ground --------------------------------------------------------------------
  const sandTex = sandTexture();
  sandTex.repeat.set(120, 120);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: sandTex, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'ground';
  solid(ground, 'sand', { cast: false });

  // --- Wooden things -------------------------------------------------------------
  const wallTex = plankTexture('#9c6440');
  const trimTex = plankTexture('#5e3d24', 6);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const trimMat = new THREE.MeshStandardMaterial({ map: trimTex, roughness: 0.85 });

  // Shooting bench at the firing line.
  const bench = new THREE.Mesh(worldBox(1.6, 0.9, 0.5, 1), trimMat);
  bench.position.set(0, 0.45, -0.8);
  bench.name = 'bench';
  solid(bench, 'wood');
  physics.addStaticFromMesh(bench);

  // Saloon at the end of the range.
  const saloon = buildSaloon(wallMat, trimMat);
  saloon.position.set(0, 0, -32);
  scene.add(saloon);
  saloon.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = true;
      o.userData.surface = 'wood';
      colliders.push(o);
    }
  });
  physics.addStaticBox(V(0, 2.5, -32), V(6, 2.5, 0.15)); // front wall
  physics.addStaticBox(V(0, 6.2, -32), V(4, 1.2, 0.15)); // false front
  physics.addStaticBox(V(0, 0.12, -30.4), V(6.2, 0.125, 1.6)); // porch floor
  physics.addStaticBox(V(0, 1.0, -28.95), V(6.2, 0.06, 0.04)); // hitching rail
  for (const x of [-6, -3, 3, 6]) physics.addStaticBox(V(x, 1.75, -28.95), V(0.09, 1.65, 0.09));
  for (const x of [-6, 6]) physics.addStaticBox(V(x, 2.5, -36), V(0.15, 2.5, 4));

  // Fences down both sides of the range.
  const fenceGeos = [];
  for (const x of [-9, 9]) {
    for (let z = 2; z >= -26; z -= 2.5) {
      fenceGeos.push(place(worldBox(0.12, 1.2, 0.12), x, 0.6, z));
      physics.addStaticBox(V(x, 0.6, z), V(0.06, 0.6, 0.06));
    }
    for (const y of [0.45, 0.95]) {
      fenceGeos.push(place(worldBox(0.05, 0.1, 28.5), x, y, -12));
      physics.addStaticBox(V(x, y, -12), V(0.025, 0.05, 14.25));
    }
  }
  solid(new THREE.Mesh(merge(fenceGeos), trimMat), 'wood').name = 'fence';

  // Barrels scattered around (instanced: one draw call).
  const barrelSpots = [
    [-6.5, -3, 0.3], [-7.2, -3.7, 1.2], [6.8, -6, 2.0], [-4.5, -29, 0.7], [5.2, -29.4, 2.4], [4.6, -28.6, 0.2],
  ];
  const barrels = new THREE.InstancedMesh(
    barrelGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    barrelSpots.length,
  );
  const m = new THREE.Matrix4();
  barrelSpots.forEach(([x, z, ry], i) => barrels.setMatrixAt(i, m.compose(
    new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1),
  )));
  barrels.computeBoundingSphere();
  for (const [x, z, ry] of barrelSpots) physics.addStaticBox(V(x, 0.425, z), V(0.29, 0.425, 0.29), yawQ(ry));
  barrels.name = 'barrels';
  solid(barrels, 'wood');

  // Saguaro cacti (merged).
  const cactusSpots = [[-11, -9, 0.2, 1.0], [12, -15, 1.4, 1.2], [-13, -22, 2.5, 0.9], [-24, -40, 1.0, 1.4], [20, -45, 0.6, 1.3], [14, 4, 2.2, 0.8]];
  for (const [x, z, , sc] of cactusSpots) physics.addStaticBox(V(x, 1.82 * sc, z), V(0.2 * sc, 1.82 * sc, 0.2 * sc), null, { surface: 'plant' });
  const cacti = new THREE.Mesh(
    merge(cactusSpots.map(([x, z, rot, sc]) => saguaro(x, z, rot, sc))),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }),
  );
  cacti.name = 'cacti';
  solid(cacti, 'plant');

  // Distance markers along the left fence.
  for (const d of [5, 10, 15, 20, 25]) {
    const post = new THREE.Mesh(worldBox(0.08, 1.0, 0.08), trimMat);
    post.position.set(-8.4, 0.5, -d);
    solid(post, 'wood');
    physics.addStaticFromMesh(post);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.3),
      new THREE.MeshStandardMaterial({ map: signTexture(`${d} m`, { w: 256, h: 128, font: 'bold 64px Georgia, serif' }), roughness: 0.9 }),
    );
    sign.position.set(-8.4, 1.05, -d + 0.05);
    sign.rotation.y = 0.5;
    solid(sign, 'wood');
  }

  // Far mesas: scenery only, no shadows, no colliders.
  const mesaGeos = [];
  const mesaSpots = [[-120, -190, 60, 28], [-40, -230, 45, 36], [70, -210, 70, 30], [170, -150, 50, 24], [-190, -90, 40, 20]];
  for (const [x, z, r, h] of mesaSpots) {
    mesaGeos.push(tint(place(new THREE.CylinderGeometry(r * 0.7, r, h, 7), x, h / 2, z), 0xb4643c));
    mesaGeos.push(tint(place(new THREE.CylinderGeometry(r * 0.72, r * 0.7, 2, 7), x, h + 1, z), 0xc77a4a));
  }
  const mesas = new THREE.Mesh(merge(mesaGeos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  scene.add(mesas);

  // --- Dust motes -----------------------------------------------------------------
  const dust = createDust(scene);

  // --- Per-frame -------------------------------------------------------------------
  let time = 0;
  const DAY_PERIOD = 600; // seconds for one full sway of the sun
  const sunDir = new THREE.Vector3();
  function update(dt) {
    time += dt;
    // The sun slowly sweeps across the afternoon sky; shadows follow.
    const azimuth = 2.4 + Math.sin((time / DAY_PERIOD) * Math.PI * 2) * 0.45;
    const elevation = 0.62 + Math.sin((time / (DAY_PERIOD * 1.5)) * Math.PI * 2) * 0.16;
    sunDir.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth));
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 45);
    const k = THREE.MathUtils.smoothstep(elevation, 0.4, 0.8);
    sun.color.lerpColors(sunWarm, sunHigh, k);
    sun.intensity = 2.2 + k * 0.6;

    dust.update(dt, time);
  }
  update(0);

  return { sun, colliders, update, dust };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildSaloon(wallMat, trimMat) {
  const group = new THREE.Group();
  group.name = 'saloon';

  const walls = [
    place(worldBox(12, 5, 0.3), 0, 2.5, 0), // front wall
    place(worldBox(8, 2.4, 0.3), 0, 6.2, 0), // false front
    place(worldBox(0.3, 5, 8), -6, 2.5, -4), // side walls
    place(worldBox(0.3, 5, 8), 6, 2.5, -4),
    place(worldBox(12.3, 0.3, 8.3), 0, 5.0, -4, 0.06), // roof
  ];
  group.add(new THREE.Mesh(merge(walls), wallMat));

  const trim = [
    place(worldBox(12.4, 0.25, 3.2), 0, 0.12, 1.6), // porch floor
    place(worldBox(12.6, 0.15, 3.4), 0, 3.45, 1.7, -0.08), // porch roof
    place(worldBox(8.3, 0.3, 0.4), 0, 7.45, 0.05), // false-front cap
    place(worldBox(12.4, 0.12, 0.08), 0, 1.0, 3.05), // hitching rail
  ];
  for (const x of [-6, -3, 3, 6]) {
    trim.push(place(worldBox(0.18, 3.3, 0.18), x, 1.75, 3.05)); // porch posts
    trim.push(place(worldBox(0.08, 0.9, 0.08), x * 0.98, 0.55, 3.05)); // rail posts
  }
  for (const x of [-4.2, 4.2]) trim.push(place(worldBox(1.5, 0.12, 0.1), x, 2.7, 0.2)); // window lintels
  trim.push(place(worldBox(0.55, 0.9, 0.05), -0.32, 1.35, 0.3, 0, 0.15)); // batwing doors
  trim.push(place(worldBox(0.55, 0.9, 0.05), 0.32, 1.35, 0.3, 0, -0.15));
  group.add(new THREE.Mesh(merge(trim), trimMat));

  const dark = new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: 0.3, metalness: 0.2 });
  group.add(new THREE.Mesh(merge([
    place(new THREE.PlaneGeometry(1.4, 1.5), -4.2, 1.85, 0.16),
    place(new THREE.PlaneGeometry(1.4, 1.5), 4.2, 1.85, 0.16),
    place(new THREE.PlaneGeometry(1.3, 2.3), 0, 1.3, 0.16), // doorway
    place(new THREE.PlaneGeometry(1.2, 1.0), 0, 6.1, 0.16), // upper window
  ]), dark));

  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 1.1),
    new THREE.MeshStandardMaterial({ map: signTexture('SALOON'), roughness: 0.8 }),
  );
  sign.position.set(0, 4.3, 0.17);
  group.add(sign);
  return group;
}

/** One saguaro as a vertex-coloured geometry at (x, z). */
function saguaro(x, z, rot, scale) {
  const green = 0x4f6b35;
  const parts = [tint(place(new THREE.CapsuleGeometry(0.22, 3.2, 4, 10), 0, 1.8, 0), green)];
  const arm = (side, h, len) => {
    parts.push(tint(place(new THREE.CapsuleGeometry(0.14, 0.5, 3, 8), side * 0.42, h, 0, 0, 0, Math.PI / 2), green));
    parts.push(tint(place(new THREE.CapsuleGeometry(0.15, len, 3, 8), side * 0.68, h + len / 2, 0), green));
  };
  arm(1, 1.6, 1.0);
  arm(-1, 2.2, 0.7);
  for (const g of parts) g.deleteAttribute('uv');
  const geo = merge(parts);
  geo.scale(scale, scale, scale);
  geo.rotateY(rot);
  geo.translate(x, 0, z);
  return geo;
}

function createSkyDome(horizon) {
  const geo = new THREE.SphereGeometry(280, 32, 16);
  const zenith = new THREE.Color(0x6fa2d8);
  const mid = new THREE.Color(0xb9d1e6);
  const col = new THREE.Color();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 280;
    if (y <= 0) col.copy(horizon);
    else if (y < 0.25) col.lerpColors(horizon, mid, y / 0.25);
    else col.lerpColors(mid, zenith, Math.min(1, (y - 0.25) / 0.6));
    colors.set([col.r, col.g, col.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  dome.renderOrder = -1;
  dome.name = 'sky';
  return dome;
}

/**
 * Dust motes drifting on the wind through the sunlit range. CPU-updated
 * Points: a few hundred particles cost well under 0.1 ms per frame.
 */
function createDust(scene, count = 360) {
  const box = { x: 16, y: 5, zMin: -34, zMax: 4 };
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() * 2 - 1) * box.x;
    positions[i * 3 + 1] = Math.random() * box.y;
    positions[i * 3 + 2] = box.zMin + Math.random() * (box.zMax - box.zMin);
    seeds[i] = Math.random() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.045, map: dustSprite(), color: 0xf6e2bf, transparent: true, opacity: 0.6,
    depthWrite: false, sizeAttenuation: true,
  }));
  points.frustumCulled = false;
  points.name = 'dust';
  scene.add(points);

  const wind = new THREE.Vector3(0.55, 0, -0.18);
  return {
    points,
    update(dt, t) {
      for (let i = 0; i < count; i++) {
        const s = seeds[i];
        const ix = i * 3;
        positions[ix] += (wind.x + Math.sin(t * 0.7 + s) * 0.2) * dt;
        positions[ix + 1] += Math.sin(t * 1.1 + s * 1.7) * 0.06 * dt;
        positions[ix + 2] += (wind.z + Math.cos(t * 0.5 + s) * 0.15) * dt;
        if (positions[ix] > box.x) positions[ix] -= 2 * box.x;
        if (positions[ix + 1] < 0.05) positions[ix + 1] = box.y;
        if (positions[ix + 1] > box.y) positions[ix + 1] = 0.05;
        if (positions[ix + 2] < box.zMin) positions[ix + 2] = box.zMax;
        if (positions[ix + 2] > box.zMax) positions[ix + 2] = box.zMin;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

/**
 * Image-based lighting for metals: a pre-filtered sky-over-sand gradient with
 * a hot spot toward the sun. Built once at startup, so it costs nothing per frame.
 */
function createDesertEnvMap(renderer) {
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const colors = [];
  const pos = geo.attributes.position;
  const sky = new THREE.Color(0xb8d4f0);
  const horizon = new THREE.Color(0xf5dcb0);
  const sand = new THREE.Color(0x8a6238);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y > 0) c.lerpColors(horizon, sky, Math.pow(y, 0.6));
    else c.lerpColors(horizon, sand, Math.min(1, -y * 3));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  envScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff0d0 }));
  sunDisc.position.set(-5, 7.5, 3.3);
  envScene.add(sunDisc);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  geo.dispose();
  return target.texture;
}
