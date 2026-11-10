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

## Play online

https://markovitch08.github.io/WesternSlop/ : open it in the Meta Quest Browser and press **ENTER VR**.
Every push to the deploy branch rebuilds and redeploys the site (`.github/workflows/pages.yml`).

## Controls

| Action | Input |
| --- | --- |
| Draw / hold the revolver | Hold the **grip** button with your hand at your right hip, where the holster is. The gun only stays in your hand while you keep holding grip |
| Swap hands | Squeeze the other hand's grip near the gun |
| Holster | Let go of the grip with the gun at your hip (refills it until reloading lands in Pass 4) |
| Drop / throw | Let go anywhere else: the gun is a rigid body, so it falls, clatters and keeps your hand's momentum. A thrown gun breaks bottles, rings gongs and knocks over duelists (no score) |
| Pick up | Grip button near the gun, wherever it landed |
| Recall | Click either **thumbstick** to bring a dropped gun back to the holster. A gun thrown out of the play area comes back on its own |
| Cock the hammer | **A/B** (or **X/Y**), or pull the **thumbstick** back |
| Fan the hammer | Hold the trigger and swipe your free hand fast across the hammer spur |
| Fire (cocked) | Light trigger pull |
| Fire (double action) | Full, heavy trigger pull: the hammer rises with the trigger and drops at the break |
| Aim | Line the brass bead on the front blade up in the rear notch. The sights are zeroed at 15 m: hits land about 2 cm low up close and about 1 cm high at 25 m |

## The range

| Target | Where | Scoring |
| --- | --- | --- |
| Pop-up duelists | 4 outlaw cut-outs at 8–14 m. A bell rings and one springs up; you have 2.6 s to draw and fire | Head 100, heart ring 100, chest ring 70, body 40, hat 20, plus up to +100 for reaction time |
| Steel gongs | 3 hanging plates at 13, 18 and 24 m (smaller plates further out). They ring and swing | 50 × precision (centre ring scores most) |
| Glass bottles | 6 on a plank at 6 m, 3 on a crate at 19 m. They shatter and the row resets once it's cleared | 30 |
| Red plate | Beside the scoreboard | Resets the score |

Every score is multiplied by the distance factor 1 + distance / 15. The chalkboard on the left shows score,
accuracy, headshots, duels won or missed, and best and average draw times. Each hit also shows a floating
pop-up with points, zone, distance and reaction time.

## Test

```bash
npm test
```

This starts a Vite server and runs each suite in `tests/suites/` in a fresh headless Chromium page with fake XR
controllers. The revolver suite covers grabbing, cocking, single and double action fire, dry fire, fanning, hand
swaps and holstering. The targets suite fires real shots at gongs, duelists, bottles and the reset plate, and
checks zones, scores, duel timeouts, bottle respawns, surface impacts and the draw-call budget. The physics suite
drops, rests, picks up and throws the gun (into bottles, gongs and duelists), tests recall and out-of-bounds
return, and checks the sights both geometrically and by aiming with them and firing. Run one suite with
`npm test -- targets`. It needs the
`playwright` package and a Chromium build available to Node.

## Layout

| File | Responsibility |
| --- | --- |
| `src/main.js` | Renderer, scene, player rig, WebXR session, render loop |
| `src/environment.js` | Sky dome, drifting sun with shadows, sand, saloon, fences, barrels, cacti, mesas, dust motes |
| `src/xr/XRManager.js` | Controller tracking and models, button polling with edge detection, raycasting, haptics |
| `src/weapons/Revolver.js` | Revolver model, grip snapping, hammer/trigger/cylinder logic, raycast fire, recoil, flash, haptics |
| `src/weapons/Holster.js` | Hip holster that follows the player's body |
| `src/audio/SoundFX.js` | Web Audio synth: gunshot with echo, clicks, and positional steel, wood, glass, sand and bell sounds |
| `src/fx/ImpactFX.js` | Pooled bullet-hole decals |
| `src/targets/TargetManager.js` | Duel scheduler, scoring, shot routing, score UI |
| `src/targets/Duelist.js`, `Gong.js`, `BottleGroup.js` | Target types: hit zones, reactions, physics |
| `src/physics/PhysicsWorld.js` | cannon-es world: static props, kinematic followers for moving targets, the revolver's rigid body |
| `src/fx/ShardFX.js` | Instanced glass shards and wood splinters |
| `src/ui/Scoreboard.js`, `FloatingText.js` | Chalkboard and floating score pop-ups in the world |
| `src/util/` | Procedural canvas textures, geometry helpers |

## Roadmap

1. ✅ Vite + Three.js scaffold, WebXR session, controller models
2. ✅ Revolver: grip attachment, trigger and hammer, raycast fire, haptics
3. ✅ Environment and targets: saloon, gongs, bottles, pop-ups, 3D scoreboard
4. Cylinder load and eject, recoil interpolation, sparks and smoke
