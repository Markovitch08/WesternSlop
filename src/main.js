import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createEnvironment } from './environment.js';
import { XRManager } from './xr/XRManager.js';
import { Revolver } from './weapons/Revolver.js';
import { Holster } from './weapons/Holster.js';
import { SoundFX } from './audio/SoundFX.js';
import { ImpactFX } from './fx/ImpactFX.js';
import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { ParticleFX } from './fx/ParticleFX.js';
import { CasingFX } from './fx/CasingFX.js';
import { AmmoPouch } from './weapons/AmmoPouch.js';
import { TargetManager } from './targets/TargetManager.js';

// ---------------------------------------------------------------------------
// Renderer — tuned for standalone headsets (Quest 2/3 at 72–90 Hz).
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1); // fixed foveated rendering: big GPU win on Quest
document.body.appendChild(renderer.domElement);
document.body.appendChild(
  VRButton.createButton(renderer, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] }),
);

// ---------------------------------------------------------------------------
// Scene, camera and player rig. The rig is the player's origin in the world;
// in XR the headset and controllers are tracked relative to it, so moving the
// rig moves the player.
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 300);
camera.position.set(0, 1.6, 0.5);

const playerRig = new THREE.Group();
playerRig.name = 'playerRig';
playerRig.add(camera);
scene.add(playerRig);

// Desktop fallback: orbit around the range when not in VR.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.3, -5);
orbit.enableDamping = true;
orbit.update();

// ---------------------------------------------------------------------------
// Game systems
// ---------------------------------------------------------------------------
const physics = new PhysicsWorld();
const environment = createEnvironment(scene, renderer, physics);
const xr = new XRManager(renderer, playerRig);
const sfx = new SoundFX();
const fx = new ParticleFX(scene);
const casings = new CasingFX(scene, physics, sfx);
const targets = new TargetManager(scene, { sfx, camera, physics, fx });
const impacts = new ImpactFX(scene);
const holster = new Holster(scene, 'right');
const colliders = [...environment.colliders];
const revolver = new Revolver({
  xr,
  holster,
  sfx,
  impacts,
  physics,
  scene,
  fx,
  casings,
  getColliders: () => {
    colliders.length = environment.colliders.length;
    colliders.push(...targets.colliders);
    return colliders;
  },
});

// Free-hand reloading: cartridges come from a pouch on the left hip. Created
// after the revolver so a squeeze near the gun grabs the gun first.
const pouch = new AmmoPouch(scene, xr, sfx, () => revolver.roundsWanted, 'left');
revolver.pouch = pouch;

// Every shot is scored (accuracy), and reacts with the target or surface it hit.
revolver.addEventListener('shot', (shot) => targets.handleShot(shot));

// Audio may only start after a user gesture: the ENTER VR click counts.
window.addEventListener('pointerdown', () => sfx.unlock());
xr.addEventListener('connected', ({ hand }) =>
  console.info(`[XR] ${hand.handedness} controller connected (${hand.inputSource.profiles[0] ?? 'unknown'})`),
);

renderer.xr.addEventListener('sessionstart', () => {
  sfx.unlock();
  orbit.enabled = false;
  // The XR camera pose is absolute relative to the rig; clear the desktop offset.
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
});
renderer.xr.addEventListener('sessionend', () => {
  orbit.enabled = true;
  camera.position.set(0, 1.6, 0.5);
  orbit.update();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Render loop. setAnimationLoop drives both the desktop rAF and the XR frame
// loop. dt is clamped so a hitch (e.g. entering VR) doesn't explode physics.
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 30);

  xr.update(dt);
  holster.update(camera, dt);
  pouch.update(camera, dt);
  targets.update(dt);
  physics.step(dt);
  revolver.update(dt);
  casings.update(dt);
  fx.update(dt);
  environment.update(dt);
  sfx.updateListener(camera);
  if (orbit.enabled) orbit.update();

  renderer.render(scene, camera);
});

// Exposed for debugging from the browser console / remote devtools.
window.__game = { THREE, scene, renderer, camera, playerRig, xr, revolver, holster, targets, sfx, environment, physics, pouch, fx, casings };
