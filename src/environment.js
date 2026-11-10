import * as THREE from 'three';

/**
 * Pass 1 environment: desert ground, sky colour, fog and a sun with shadows,
 * enough to orient the player in VR. The saloon facade, props, target stands
 * and dust particles are built in Pass 3.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{ sun: THREE.DirectionalLight, colliders: THREE.Object3D[], update: (dt: number) => void }}
 */
export function createEnvironment(scene, renderer) {
  const skyColor = new THREE.Color(0xe9c89a);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 30, 140);
  scene.environment = createDesertEnvMap(renderer);

  // Warm sky / sand bounce light.
  const hemi = new THREE.HemisphereLight(0xfff1d6, 0xa0703f, 0.55);
  scene.add(hemi);

  // Low afternoon sun. A tight shadow frustum around the play area keeps the
  // shadow map cheap enough for standalone headsets.
  const sun = new THREE.DirectionalLight(0xffd9a0, 2.6);
  sun.position.set(-12, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const s = sun.shadow.camera;
  s.left = -15; s.right = 15; s.top = 15; s.bottom = -15; s.near = 1; s.far = 60;
  sun.shadow.bias = -0.0005;
  sun.target.position.set(0, 0, -6);
  scene.add(sun, sun.target);

  // Desert floor.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0xc89a62, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  // Placeholder shooting-bench marker so the player can see where to stand.
  const bench = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.9, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 }),
  );
  bench.position.set(0, 0.45, -0.8);
  bench.castShadow = bench.receiveShadow = true;
  bench.name = 'bench';
  scene.add(bench);

  return {
    sun,
    /** Static meshes bullets can hit. */
    colliders: [ground, bench],
    update(/* dt */) {},
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
