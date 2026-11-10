# Western Slop

A single-player, semi-realistic VR Western shooting range built with Three.js, WebXR and Vite.
It targets Meta Quest and other standalone WebXR browsers at 72–90 FPS.

## Run

```bash
npm install
npm run dev
```

The dev server uses HTTPS with a self-signed certificate, because WebXR needs a secure context, and it
listens on your LAN. On the Quest, open `https://<your-pc-ip>:5173` in the Meta Quest Browser, accept the
certificate warning, then press **ENTER VR**. On desktop you can drag to orbit around the scene.

## Controls (Pass 2)

| Action | Input |
| --- | --- |
| Draw / hold the revolver | Hold the **grip** button with your hand at your right hip, where the holster is |
| Swap hands | Squeeze the other hand's grip near the gun |
| Holster | Let go of the grip: the gun returns to the holster (and is refilled until reloading lands in Pass 4) |
| Cock the hammer | **A/B** (or **X/Y**), or pull the **thumbstick** back |
| Fan the hammer | Hold the trigger and swipe your free hand fast across the hammer spur |
| Fire (cocked) | Light trigger pull |
| Fire (double action) | Full, heavy trigger pull: the hammer rises with the trigger and drops at the break |

## Test

```bash
npm test
```

This starts a Vite server, loads the game in headless Chromium, and drives fake XR controllers through
grabbing, cocking, single and double action fire, dry fire, fanning, hand swaps and holstering. It needs the
`playwright` package and a Chromium build available to Node.

## Layout

| File | Responsibility |
| --- | --- |
| `src/main.js` | Renderer, scene, player rig, WebXR session, render loop |
| `src/environment.js` | Desert range, lighting and shadows (saloon, props and dust come in Pass 3) |
| `src/xr/XRManager.js` | Controller tracking and models, button polling with edge detection, raycasting, haptics |
| `src/weapons/Revolver.js` | Revolver model, grip snapping, hammer/trigger/cylinder logic, raycast fire, recoil, flash, haptics |
| `src/weapons/Holster.js` | Hip holster that follows the player's body |
| `src/audio/SoundFX.js` | Web Audio synth: gunshot with echo, hammer and dry-fire clicks, holster thud |
| `src/fx/ImpactFX.js` | Pooled bullet-hole decals |
| `src/targets/TargetManager.js` | Targets, hit zones and score (implemented in Pass 3) |

## Roadmap

1. ✅ Vite + Three.js scaffold, WebXR session, controller models
2. ✅ Revolver: grip attachment, trigger and hammer, raycast fire, haptics
3. Environment and targets: saloon, gongs, bottles, pop-ups, 3D scoreboard
4. Cylinder load and eject, recoil interpolation, sparks and smoke
