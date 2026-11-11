/**
 * Settings suite: the board is operated by pointing an empty hand and pulling
 * the trigger; handedness moves the holster and pouch (and you can draw from
 * the new side); effects / ambience volume; quality presets; snap and smooth
 * turning around the head; settings persist. Runs inside the page.
 */
module.exports = async function settingsSuite() {
  const g = window.__game;
  const { THREE, settings, settingsBoard: board, xr, holster, pouch, revolver: rev, sfx, audio, atmosphere: atm, playerRig } = g;
  const out = [];
  const check = (name, ok, detail = '') => {
    out.push({ name, ok: !!ok, detail: String(detail) });
    console.log(`[check] ${ok ? 'ok ' : 'BAD'} ${name} ${detail}`);
  };
  const frames = (n) => new Promise((res) => {
    let i = 0;
    const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const until = async (pred, max = 300) => {
    for (let i = 0; i < max && !pred(); i++) await frames(1);
    return pred();
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const fake = (hand, handedness) => {
    const gp = {
      buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      hapticActuators: [{ pulse: () => Promise.resolve(true) }],
    };
    hand.inputSource = { handedness, gamepad: gp, profiles: [] };
    hand.handedness = handedness;
    hand.connected = true;
    return gp;
  };
  /** Pose a hand at a WORLD position/orientation (controllers live in the player rig). */
  const pose = (hand, pos, quat = new THREE.Quaternion()) => {
    playerRig.updateWorldMatrix(true, false);
    const rigInv = playerRig.matrixWorld.clone().invert();
    const local = new THREE.Matrix4().compose(pos, quat, V(1, 1, 1)).premultiply(rigInv);
    for (const o of [hand.grip, hand.controller]) {
      local.decompose(o.position, o.quaternion, o.scale);
      o.matrix.compose(o.position, o.quaternion, o.scale);
      o.matrixWorldNeedsUpdate = true;
    }
  };
  const R = xr.hands[0];
  const L = xr.hands[1];
  const rgp = fake(R, 'right');
  fake(L, 'left');
  pose(L, V(-0.6, 1.0, 0.4));
  await frames(3);

  /** Point the left (empty) hand at a button and pull the trigger. */
  const press = async (key, dir) => {
    const btn = board.buttons.find((b) => b.userData.key === key && b.userData.dir === dir);
    const target = btn.getWorldPosition(V(0, 0, 0));
    const from = V(0.6, 1.3, 0);
    const m = new THREE.Matrix4().lookAt(from, target, V(0, 1, 0));
    pose(L, from, new THREE.Quaternion().setFromRotationMatrix(m));
    await frames(2);
    xr.dispatchEvent({ type: 'selectstart', hand: L });
    await frames(2);
  };

  check('settings board with ◀ ▶ for each row', board.buttons.length === board.keys.length * 2 && board.keys.length >= 5, board.keys.join(','));
  check('defaults: right-handed, snap turning, high quality', settings.get('handedness') === 'right' && settings.get('turning') === 'snap' && settings.get('quality') === 'high');

  // --- Handedness ------------------------------------------------------------------
  const head = () => g.camera.getWorldPosition(V(0, 0, 0));
  const sideOf = (obj) => obj.getWorldPosition(V(0, 0, 0)).x - head().x;
  check('right-handed: holster on the right hip, pouch on the left', sideOf(holster.object) > 0.1 && sideOf(pouch.object) < -0.1,
    `${sideOf(holster.object).toFixed(2)} ${sideOf(pouch.object).toFixed(2)}`);
  await press('handedness', 1);
  check('pointing + trigger changes a setting', settings.get('handedness') === 'left');
  await frames(3);
  check('left-handed: holster on the left hip, pouch on the right', sideOf(holster.object) < -0.1 && sideOf(pouch.object) > 0.1,
    `${sideOf(holster.object).toFixed(2)} ${sideOf(pouch.object).toFixed(2)}`);
  const saved = JSON.parse(localStorage.getItem('westernslop.settings.v1'));
  check('settings saved', saved?.handedness === 'left');
  // Draw from the left hip with the left hand.
  pose(L, holster.object.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: L });
  await frames(10);
  check('draw from the left hip', rev.isHeld && rev.hand === L);
  pose(L, holster.socket.getWorldPosition(V(0, 0, 0)));
  await frames(7);
  xr.dispatchEvent({ type: 'squeezeend', hand: L });
  check('holster on the left', await until(() => rev.state === 'holstered', 60));
  await press('handedness', -1);
  check('back to right-handed', settings.get('handedness') === 'right');

  // --- Volume -------------------------------------------------------------------------
  check('audio running (the board press unlocked it)', await until(() => audio.unlocked, 120));
  for (let i = 0; i < 3; i++) await press('sfxVolume', -1);
  check('effects volume steps down', Math.abs(settings.get('sfxVolume') - 0.7) < 1e-9 && Math.abs(sfx.volume - 0.7) < 1e-9, settings.get('sfxVolume'));
  check('master gain follows', await until(() => Math.abs(sfx.master.gain.value - 0.63) < 0.02, 60),
    `${sfx.master.gain.value.toFixed(3)} ctx=${audio.ctx.state} t=${audio.ctx.currentTime.toFixed(2)} sfxctx=${sfx.ctx === audio.ctx}`);
  await press('ambienceVolume', -1);
  check('ambience volume applies', Math.abs(audio.ambience - 0.6) < 1e-9 && Math.abs(audio.layers.crickets.getVolume() - 0.03) < 1e-6,
    audio.layers.crickets.getVolume());

  // --- Quality ------------------------------------------------------------------------
  await press('quality', 1);
  check('medium quality: 1024 shadows, no lantern shadow, less dust', settings.get('quality') === 'medium' && atm.sun.shadow.mapSize.x === 1024 &&
    atm.lanterns.every((l) => !l.light.castShadow) && atm.dust.points.geometry.drawRange.count === 500 && g.renderer.shadowMap.type === THREE.PCFShadowMap);
  await press('quality', 1);
  check('low quality: 512 shadows, little dust', atm.sun.shadow.mapSize.x === 512 && atm.dust.points.geometry.drawRange.count === 250);
  await frames(3);
  check('still renders after switching shadow settings', g.renderer.info.render.calls > 0);
  await press('quality', 1);
  check('high quality restored: soft shadows, lantern shadow back', atm.sun.shadow.mapSize.x === 2048 && atm.lanterns.some((l) => l.light.castShadow) &&
    g.renderer.shadowMap.type === THREE.PCFSoftShadowMap);

  // --- Turning ------------------------------------------------------------------------
  const yaw0 = playerRig.rotation.y;
  const h0 = head();
  rgp.axes[2] = 0.9; await frames(2);
  check('snap turn: one 30° step', Math.abs(Math.abs(playerRig.rotation.y - yaw0) - Math.PI / 6) < 1e-6, (playerRig.rotation.y - yaw0).toFixed(3));
  await frames(5);
  check('holding the stick does not keep snapping', Math.abs(Math.abs(playerRig.rotation.y - yaw0) - Math.PI / 6) < 1e-6);
  check('turning pivots around the head', head().distanceTo(h0) < 1e-3, head().distanceTo(h0).toFixed(4));
  rgp.axes[2] = 0; await frames(2);
  rgp.axes[2] = -0.9; await frames(2);
  rgp.axes[2] = 0; await frames(2);
  check('snap back', Math.abs(playerRig.rotation.y - yaw0) < 1e-6);
  await press('turning', 1);
  check('smooth turning selected', settings.get('turning') === 'smooth');
  const y1 = playerRig.rotation.y;
  rgp.axes[2] = 1; await frames(10);
  const mid = playerRig.rotation.y - y1;
  await frames(10);
  rgp.axes[2] = 0;
  const end = playerRig.rotation.y - y1;
  check('smooth turn: gradual, keeps going while held', mid < -0.05 && end < mid && end > -Math.PI, `${mid.toFixed(3)} then ${end.toFixed(3)}`);
  await press('turning', 1);
  const y2 = playerRig.rotation.y;
  rgp.axes[2] = 1; await frames(5); rgp.axes[2] = 0;
  check('turning off: no turn', settings.get('turning') === 'off' && playerRig.rotation.y === y2);

  // --- Performance meter -------------------------------------------------------------
  const perf = g.perf;
  check('performance meter off by default', !perf.object.visible);
  await press('perfMeter', 1);
  await frames(30);
  check('meter on: a watch on the off-hand (left) wrist', settings.get('perfMeter') === true && perf.object.visible && perf.object.parent === L.grip);
  check('meter measures fps and frame times', perf.fps > 1 && perf.avgMs > 0 && perf.worstMs >= perf.avgMs,
    `${perf.fps.toFixed(1)} fps, ${perf.avgMs.toFixed(1)} / ${perf.worstMs.toFixed(1)} ms`);
  await press('handedness', 1);
  await frames(3);
  check('left-handed: the meter moves to the right wrist', perf.object.parent === R.grip);
  await press('handedness', -1);
  await frames(3);

  // --- Persistence ------------------------------------------------------------------
  const { Settings } = await import('/src/game/Settings.js');
  const reloaded = new Settings();
  check('settings come back on the next load', reloaded.get('turning') === 'off' && reloaded.get('quality') === 'high' && reloaded.get('perfMeter') === true &&
    Math.abs(reloaded.get('sfxVolume') - 0.7) < 1e-9);
  return out;
};
