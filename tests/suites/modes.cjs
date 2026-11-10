/**
 * Game modes suite: home is static practice (no outlaws, no random pop-ups;
 * bottles, gongs, a knock-down plate rack and tumbleweeds), the timed pop-up
 * mode started from the orange plate, one mode at a time, and the mode sign
 * being fixed in the world rather than following the head. Runs inside the page.
 */
module.exports = async function modesSuite() {
  const g = window.__game;
  const { THREE, targets: tm, revolver: rev, xr, holster, sfx, popups, duel, modes, atmosphere } = g;

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
  const until = async (pred, max = 900) => {
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
  const pose = (hand, pos, quat = new THREE.Quaternion()) => {
    for (const o of [hand.grip, hand.controller]) {
      o.position.copy(pos);
      o.quaternion.copy(quat);
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
  const GUN = V(0.3, 1.5, 0.2);
  const aimAt = async (point) => {
    for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
    const m = new THREE.Matrix4().lookAt(GUN.clone().add(V(0, 0.06, 0)), point, V(0, 1, 0));
    pose(R, GUN, new THREE.Quaternion().setFromRotationMatrix(m));
    await frames(2);
  };
  let lastShot = null;
  rev.addEventListener('shot', (e) => { lastShot = e; });
  const fire = async () => {
    rev.chambers.fill('live');
    rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(2);
    rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  };

  // --- Home: static target practice ---------------------------------------------
  check('home: no game mode running', modes.current === null && !duel.active && !popups.active);
  check('home: cardboard outlaws hidden and not shootable', tm.duelists.every((d) => !d.active && !d.object.visible) &&
    !tm.colliders.some((c) => c.name === 'duelistBoard'));
  check('home: outlaw physics bodies removed', tm.duelists.every((d) => d.bodies.every((b) => !g.physics.world.bodies.includes(b))));
  await frames(120);
  check('home: no random pop-ups', tm.duelists.every((d) => d.state === 'down') && !tm.duelEnabled);
  check('home targets: bottles, gongs, plate rack, tumbleweeds', tm.bottleGroups.length === 2 && tm.gongs.length === 3 &&
    tm.plateRack.plates.length === 5 && atmosphere.tumbleweeds.length >= 1 &&
    tm.colliders.some((c) => c.name === 'rackPlate') && tm.colliders.some((c) => c.name === 'bottleCollider'));

  // Plate rack: knock one down with a real shot, then clear the rest and watch it reset.
  pose(R, holster.object.getWorldPosition(V(0, 0, 0)));
  await frames(2);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(10);
  const plate = tm.plateRack.plates[2];
  await aimAt(plate.mesh.localToWorld(V(0, 0.12, 0)));
  let hit = null;
  const onHit = (e) => { hit = e.report; };
  tm.addEventListener('hit', onHit);
  const steel = sfx.played.steel ?? 0;
  await fire();
  check('shooting a rack plate scores and rings', hit?.type === 'plate' && hit.points > 0 && (sfx.played.steel ?? 0) > steel,
    `${JSON.stringify(hit)} shotHit=${lastShot?.hit?.object?.name} at ${lastShot?.hit?.point?.toArray().map((v) => v.toFixed(2))} held=${rev.isHeld}`);
  check('the plate gets knocked down', await until(() => plate.state === 'down', 120) && !tm.colliders.includes(plate.mesh), plate.state);
  tm.removeEventListener('hit', onHit);
  tm.plateRack.plates.forEach((p, i) => tm.plateRack.knock(i));
  check('rack resets once every plate is down', await until(() => tm.plateRack.standing === 5, 300), tm.plateRack.standing);

  // --- The sign is fixed in the world, not head-locked ----------------------------
  const hudMesh = duel.hud.sprite;
  check('mode sign is a fixed panel, not a billboard sprite', hudMesh.isMesh && !hudMesh.isSprite);
  const q0 = hudMesh.getWorldQuaternion(new THREE.Quaternion());
  const p0 = hudMesh.getWorldPosition(V(0, 0, 0));
  g.camera.rotation.y += 0.8;
  g.camera.position.x += 1;
  g.camera.updateMatrixWorld();
  g.renderer.render(g.scene, g.camera);
  check('sign keeps its place when the head moves', hudMesh.getWorldQuaternion(new THREE.Quaternion()).angleTo(q0) < 1e-6 &&
    hudMesh.getWorldPosition(V(0, 0, 0)).distanceTo(p0) < 1e-6);
  g.camera.rotation.y -= 0.8;
  g.camera.position.x -= 1;
  check('score pop-ups are fixed panels too', tm.text.items.every((it) => it.sprite.isMesh && !it.sprite.isSprite));

  // --- Pop-up mode -------------------------------------------------------------------
  popups.duration = 4; // a short round for the test
  await aimAt(tm.popupPlate.plate.getWorldPosition(V(0, 0, 0)));
  await fire();
  check('shooting the orange plate starts pop-up mode', popups.state === 'countdown' && modes.current === popups, popups.state);
  check('pop-up mode shows the outlaws', tm.duelists.every((d) => d.active && d.object.visible));
  check('countdown on the sign', popups.hud.text === '3' || popups.hud.text === '2', popups.hud.text);

  // One mode at a time: the DUEL plate does nothing now.
  await aimAt(tm.duelPlate.plate.getWorldPosition(V(0, 0, 0)));
  await fire();
  check('duel cannot start during pop-ups', !duel.active && modes.current === popups);

  check('GO! then outlaws start popping up', await until(() => popups.state === 'play', 200) &&
    await until(() => tm.duelists.some((d) => d.isLive), 200));
  const live = tm.duelists.find((d) => d.isLive);
  await until(() => live.state === 'up', 30);
  await aimAt(live.object.localToWorld(V(0, 0.15 + 1.1, 0.01)));
  await fire();
  check('hitting a pop-up scores in the mode', popups.score.hits >= 1 && popups.score.points > 0, JSON.stringify(popups.score));
  check('sign shows the clock and score', /^0:\d\d$/.test(popups.hud.text) && popups.hud.sub.includes('pts'), `${popups.hud.text} | ${popups.hud.sub}`);
  check('time runs out: summary', await until(() => popups.state === 'summary', 400) && popups.hud.text.endsWith('pts'), popups.hud.text);
  check('back home after the summary', await until(() => popups.state === 'idle', 400) && modes.current === null);
  check('outlaws packed away, random pop-ups off', tm.duelists.every((d) => !d.active) && !tm.duelEnabled);
  check('draw calls within budget', g.renderer.info.render.calls < 120, g.renderer.info.render.calls);
  return out;
};
