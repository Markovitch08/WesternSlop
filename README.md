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
| Holster | Let go of the grip with the gun at your hip |
| Drop / throw | Let go anywhere else: the gun is a rigid body, so it falls, clatters and keeps your hand's momentum. A thrown gun breaks bottles, rings gongs and knocks over duelists (no score) |
| Pick up | Grip button near the gun, wherever it landed |
| Recall | Click either **thumbstick** to bring a dropped gun back to the holster. A gun thrown out of the play area comes back on its own |
| Cock the hammer | **A** (or **X**), or pull the **thumbstick** back |
| Open / close the cylinder | **B** (or **Y**). Spent cases drop out as soon as it swings open |
| Load | With the cylinder open, squeeze grip with your free hand at the **pouch on your left hip** to take a palmful of cartridges, then hold them at the cylinder: they feed in quickly (a full six in under half a second) |
| Push it shut | Once your free hand is empty, sweep it into the swung-out cylinder toward the frame to push it home |
| Flick it shut | Snap your wrist (a fast roll) with the cylinder open: it closes and spins free. Wherever it stops is the chamber under the hammer |
| Fan the hammer | Hold the trigger and swipe your free hand fast across the hammer spur |
| Fire (cocked) | Light trigger pull |
| Fire (double action) | Full, heavy trigger pull: the hammer rises with the trigger and drops at the break |
| Aim | Line the brass bead on the front blade up in the rear notch. Bullets fly at 260 m/s and drop under gravity; the sights are zeroed at 15 m (about 2 cm low up close, about 1.5 cm low at 25 m) |

## The range

| Target | Where | Scoring |
| --- | --- | --- |
| Pop-up duelists | 4 outlaw cut-outs at 8–14 m. A bell rings and one springs up; you have 2.6 s to draw and fire | Head 100, heart ring 100, chest ring 70, body 40, hat 20, plus up to +100 for reaction time |
| Steel gongs | 3 hanging plates at 13, 18 and 24 m (smaller plates further out). They ring and swing | 50 × precision (centre ring scores most) |
| Glass bottles | 6 on a plank at 6 m, 3 on a crate at 19 m. They shatter and the row resets once it's cleared | 30 |
| Red plate | Beside the scoreboard | Resets the score |
| Black DUEL plate | Next to the red plate | Starts quick-draw duel mode (below) |

Every score is multiplied by the distance factor 1 + distance / 15. The chalkboard on the left shows score,
accuracy, headshots, duels won or missed, and best and average draw times. Each hit also shows a floating
pop-up with points, zone, distance and reaction time.

## Atmosphere and sound

- **Light:** a low golden-hour sun (`0xffb56b`) with long, soft shadows and a cool violet ambient fill
  (`0x332244`) for contrast, plus image-based light for the metal. It drifts slowly across the sky.
- **Haze:** exponential dust fog (`0xc29b6c`, density 0.015), with the sky fading into it at the horizon. The
  mesas show through as silhouettes.
- **Wind:** one wind with slow gusts and veer. It carries about 800 dust motes around you, the gun smoke, two
  tumbleweeds and the lanterns. The tumbleweeds roll and hop across the ground using a raycast against it, and
  you can shoot them.
- **Lanterns:** two oil lanterns hang beside the firing line and the plates. Their lights flicker and they
  sway in the wind; the one by the bench casts small soft shadows.
- **Spatial audio:** a `THREE.AudioListener` sits on the headset.
  - The ambient bed is canyon wind that swells with the gusts, a whistle through the boards, occasional
    saloon creaks and dry crickets.
  - The gunshot's snap comes from the muzzle. A few faint echoes come back from the saloon front and the mesa
    faces, delayed by the real round trip and duller with distance. There is no reverb.
  - Impacts and brass are positional. Gongs fade with exponential distance falloff, and spent cases sound
    different on dirt, wood and steel.
- **Unlock:** audio starts on your first click, trigger or grip press, or when the VR session starts.

## Quick-draw duel mode

Shoot the black **DUEL** plate to take on five outlaws in a row, each faster on the draw than the last
(1.50, 1.25, 1.05, 0.90 and 0.80 s).

1. **Holster.** The sign over the range shows the round and who you're facing. Holster your gun (load it first
   if it's empty).
2. **3 · 2 · 1.** A countdown with a knock on each beat, then a random pause so you can't time the draw.
3. **DRAW!** The bell rings and the outlaw springs up. Draw from the holster and shoot him before he fires. Your
   time runs from the signal to the hit.
4. **Win or die.** Win and the sign shows your draw time and margin. Too slow and he fires back: his shot comes
   from downrange, with muzzle smoke, a red flash and a hard rumble in both hands.

Touching your gun before "DRAW!" is **JUMPED THE GUN**: holster again to restart the round. Losing a round ends
the run with a summary of outlaws beaten and your best draw; beat all five to be the **FASTEST GUN** in the West.
Random free-range pop-ups pause during a duel and come back afterwards.

## Test

```bash
npm test
```

This starts a Vite server and runs each suite in `tests/suites/` in a fresh headless Chromium page with fake XR
controllers. The revolver suite covers grabbing, cocking, single and double action fire, dry fire, fanning, hand
swaps and holstering. The targets suite fires real shots at gongs, duelists, bottles and the reset plate, and
checks zones, scores, duel timeouts, bottle respawns, surface impacts and the draw-call budget. The physics suite
drops, rests, picks up and throws the gun (into bottles, gongs and duelists), tests recall and out-of-bounds
return, and checks the sights both geometrically and by aiming with them and firing. The reload suite opens the
cylinder, checks that the ejected cases are physics objects, loads from the pouch, pushes it shut with the free hand,
closes with B and with a wrist flick, fires the reloaded rounds, and checks bullet drop, smoke, sparks and dust. The duel suite starts a duel from the plate,
checks the holster prompt, countdown and foul, wins a round by drawing and shooting, loses the next by being
too slow, and checks the summary and the return to free play. The atmosphere suite checks the light, fog and sky, dust and wind,
tumbleweeds, lanterns, and the audio system (unlock, listener, ambient layers, echoes, positional effects).
Tests run Chromium with autoplay allowed so the audio graph really runs. Run one suite with
`npm test -- targets`. It needs the
`playwright` package and a Chromium build available to Node.

## Layout

| File | Responsibility |
| --- | --- |
| `src/main.js` | Renderer, scene, player rig, WebXR session, render loop |
| `src/environment.js` | Range geometry: sand, saloon, fences, barrels, cacti, mesas, echo reflectors |
| `src/environment/AtmosphereManager.js` | Golden-hour sun and fill, fog, sky, wind, dust, tumbleweeds, lanterns |
| `src/audio/AudioEnvironment.js` | Listener on the headset, ambient bed, terrain echo emitters, audio unlock |
| `src/xr/XRManager.js` | Controller tracking and models, button polling with edge detection, raycasting, haptics |
| `src/weapons/Revolver.js` | Revolver model, grip snapping, hammer/trigger/cylinder logic, raycast fire, recoil, flash, haptics |
| `src/weapons/Holster.js` | Hip holster that follows the player's body |
| `src/audio/SoundFX.js` | Web Audio synth: gunshot with outdoor echoes, reload sounds, brass, and positional steel, wood, glass, sand and bell sounds |
| `src/fx/ImpactFX.js` | Pooled bullet-hole decals |
| `src/targets/TargetManager.js` | Duel scheduler, scoring, shot routing, score UI |
| `src/targets/Duelist.js`, `Gong.js`, `BottleGroup.js` | Target types: hit zones, reactions, physics |
| `src/physics/PhysicsWorld.js` | cannon-es world: static props, kinematic followers for moving targets, the revolver's rigid body |
| `src/weapons/AmmoPouch.js` | Hip cartridge pouch and the rounds held in the free hand |
| `src/fx/ParticleFX.js` | One-draw-call particles: muzzle smoke and sparks, impact dust, steel sparks |
| `src/fx/CasingFX.js` | Ejected brass cases as rigid bodies (instanced) |
| `src/fx/ShardFX.js` | Instanced glass shards and wood splinters |
| `src/game/DuelMode.js` | Quick-draw duel mode: round flow, countdown, fouls, outlaw ladder |
| `src/ui/DuelHUD.js` | Duel sign over the range and the red hit flash |
| `src/ui/Scoreboard.js`, `FloatingText.js` | Chalkboard and floating score pop-ups in the world |
| `src/util/` | Procedural canvas textures, geometry helpers |

## Roadmap

1. ✅ Vite + Three.js scaffold, WebXR session, controller models
2. ✅ Revolver: grip attachment, trigger and hammer, raycast fire, haptics
3. ✅ Environment and targets: saloon, gongs, bottles, pop-ups, 3D scoreboard
4. ✅ Cylinder load and eject, recoil interpolation, sparks and smoke
