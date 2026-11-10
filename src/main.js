import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createEnvironment } from './environment.js';
import { AtmosphereManager } from './environment/AtmosphereManager.js';
import { AudioEnvironment } from './audio/AudioEnvironment.js';
import { XRManager } from './xr/XRManager.js';
import { Revolver } from './weapons/Revolver.js';
import { Holster } from './weapons/Holster.js';
import { SoundFX } from './audio/SoundFX.js';
import { ImpactFX } from './fx/ImpactFX.js';
import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { ParticleFX } from './fx/ParticleFX.js';
import { CasingFX } from './fx/CasingFX.js';
import { AmmoPouch } from './weapons/AmmoPouch.js';
import { DuelHUD } from './ui/DuelHUD.js';
import { DuelMode } from './game/DuelMode.js';
import { PopupMode } from './game/PopupMode.js';
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft golden-hour shadows

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
const atmosphere = new AtmosphereManager(scene, renderer, {
  groundColliders: environment.colliders.filter((c) => c.name === 'ground' || c.name === 'bench'),
  physics,
});
const xr = new XRManager(renderer, playerRig);
const sfx = new SoundFX();
const fx = new ParticleFX(scene);
fx.wind = atmosphere.wind.vector; // smoke and dust drift on the same wind as everything else
const casings = new CasingFX(scene, physics, sfx);
const targets = new TargetManager(scene, { sfx, camera, physics, fx });
const impacts = new ImpactFX(scene);
const holster = new Holster(scene, 'right');
const staticColliders = [...environment.colliders, ...atmosphere.colliders];
const colliders = [...staticColliders];
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
    colliders.length = staticColliders.length;
    colliders.push(...targets.colliders);
    return colliders;
  },
});

// Free-hand reloading: cartridges come from a pouch on the left hip. Created
// after the revolver so a squeeze near the gun grabs the gun first.
const pouch = new AmmoPouch(scene, xr, sfx, () => revolver.roundsWanted, 'left');
revolver.pouch = pouch;

// Game modes, one at a time. Home is static practice (bottles, gongs, plate
// rack, tumbleweeds). Shoot the black DUEL plate for quick-draw duels, or the
// orange POP-UP plate for timed pop-up outlaws.
const modes = { current: null };
const hud = new DuelHUD(scene, camera);
const duel = new DuelMode({ targets, revolver, sfx, xr, fx, camera, hud, modes });
const popups = new PopupMode({ targets, revolver, sfx, hud, modes });

// Every shot is scored (accuracy), and reacts with the target or surface it hit.
revolver.addEventListener('shot', (shot) => targets.handleShot(shot));

// Audio may only start after a user gesture: the ENTER VR click counts.
// Spatial audio: listener on the headset, ambience, terrain echoes. The
// AudioContext resumes on the first click / trigger / grip / XR session start.
const audio = new AudioEnvironment(camera, scene, sfx, environment.reflectors);
audio.installUnlockHandlers(renderer, xr);
xr.addEventListener('connected', ({ hand }) =>
  console.info(`[XR] ${hand.handedness} controller connected (${hand.inputSource.profiles[0] ?? 'unknown'})`),
);

renderer.xr.addEventListener('sessionstart', () => {
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
  popups.update(dt);
  duel.update(dt);
  atmosphere.update(dt, camera);
  sfx.updateListener(camera);
  audio.update(dt, atmosphere.wind);
  if (orbit.enabled) orbit.update();

  renderer.render(scene, camera);
});

// Exposed for debugging from the browser console / remote devtools.
window.__game = { THREE, scene, renderer, camera, playerRig, xr, revolver, holster, targets, sfx, environment, physics, pouch, fx, casings, duel, popups, modes, atmosphere, audio };
