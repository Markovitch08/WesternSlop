import * as THREE from 'three';
import { plankTexture, sandTexture, signTexture } from './util/canvasTextures.js';
import { worldBox, place, tint, merge, barrelGeometry } from './util/geometry.js';

/**
 * Desert shooting range geometry: sand floor, saloon facade, barrels, cacti,
 * fences, distance markers and the mesas on the horizon. Light, fog, sky,
 * dust, wind and tumbleweeds live in environment/AtmosphereManager.js.
 *
 * `reflectors` lists the big surfaces a gunshot echoes off (the saloon front
 * and the mesa faces), for AudioEnvironment.
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

  // Mesas: scenery only, no shadows, no colliders. Close enough (70–95 m) to
  // read as hazy silhouettes through the exponential fog.
  const mesaGeos = [];
  const mesaSpots = [[-60, -80, 30, 16], [-15, -95, 24, 20], [40, -88, 34, 18], [85, -60, 26, 14], [-90, -40, 22, 12]];
  for (const [x, z, r, h] of mesaSpots) {
    mesaGeos.push(tint(place(new THREE.CylinderGeometry(r * 0.7, r, h, 7), x, h / 2, z), 0xa85a36));
    mesaGeos.push(tint(place(new THREE.CylinderGeometry(r * 0.72, r * 0.7, 1.5, 7), x, h + 0.75, z), 0xbb6e44));
  }
  const mesas = new THREE.Mesh(merge(mesaGeos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  mesas.name = 'mesas';
  scene.add(mesas);

  // Echo reflectors: the saloon front and the face of each mesa nearest the range.
  const reflectors = [{ name: 'saloon', position: V(0, 3, -31.8), reflectivity: 0.5 }];
  for (const [x, z, r, h] of mesaSpots) {
    const toRange = V(-x, 0, -z).normalize();
    reflectors.push({ name: 'mesa', position: V(x, h * 0.4, z).addScaledVector(toRange, r * 0.85), reflectivity: 0.8 });
  }

  return { colliders, reflectors, mesas };
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
