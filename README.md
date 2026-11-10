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

## Layout

| File | Responsibility |
| --- | --- |
| `src/main.js` | Renderer, scene, player rig, WebXR session, render loop |
| `src/environment.js` | Desert range, lighting and shadows (saloon, props and dust come in Pass 3) |
| `src/xr/XRManager.js` | Controller tracking and models, button polling with edge detection, raycasting, haptics |
| `src/weapons/Revolver.js` | Revolver state machine (implemented in Passes 2 and 4) |
| `src/targets/TargetManager.js` | Targets, hit zones and score (implemented in Pass 3) |

## Roadmap

1. ✅ Vite + Three.js scaffold, WebXR session, controller models
2. Revolver: grip attachment, trigger and hammer, raycast fire, haptics
3. Environment and targets: saloon, gongs, bottles, pop-ups, 3D scoreboard
4. Cylinder load and eject, recoil interpolation, sparks and smoke
