/**
 * Rifle suite: grab from the rack; fire the chambered round; no shot until
 * the lever is worked (dry click); the lever ejects a case and feeds the next
 * round; ammo runs out and the rack reloads it; flatter ballistics than the
 * revolver; sights zeroed at 25 m (geometry and an end-to-end aimed shot);
 * two-handed hold points along the line between the hands; duels treat it as
 * a gun. Runs inside the page.
 */
module.exports = async function rifleSuite() {
  const g = window.__game;
  const { THREE, rifle, xr, sfx, casings, targets: tm, duel } = g;
  const { MUZZLE_VELOCITY } = await import('/src/weapons/Rifle.js');
  const { dropAt } = await import('/src/weapons/ballistics.js');
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
  const played = (k) => sfx.played[k] ?? 0;
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
  const pull = async () => {
    rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(2);
    rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  };
  const lever = async () => {
    rgp.buttons[4].pressed = true; await frames(2);
    rgp.buttons[4].pressed = false;
    await until(() => !rifle.levering, 60);
  };
  let shot = null;
  rifle.addEventListener('shot', (e) => { shot = e; });

  // --- Rack and grab ---------------------------------------------------------------
  check('rifle racked, fully loaded', rifle.state === 'racked' && rifle.rounds === 11, rifle.rounds);
  check('rack within reach at waist height', rifle.object.getWorldPosition(V(0, 0, 0)).y > 0.9);
  pose(R, rifle.object.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(12);
  check('grabbed from the rack', rifle.isHeld && rifle.hand === R && R.held === rifle && !R.model.visible);

  // --- Fire, dry, lever ---------------------------------------------------------------
  const down = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -0.25);
  pose(R, V(0.25, 1.35, -0.1), down);
  await frames(4);
  const shots = played('gunshot');
  shot = null;
  await pull();
  check('trigger fires the chambered round', shot && played('gunshot') === shots + 1 && rifle.chamber === 'spent');
  check('it kicks', Math.abs(rifle.recoil.ang) > 0.01 || Math.abs(rifle.recoil.angVel) > 0.1);
  shot = null;
  const clicks = played('click');
  await frames(10);
  await pull();
  check('no lever, no shot: a dry click', !shot && played('click') > clicks);
  const cases = casings.activeCount;
  await lever();
  check('the lever clacks, ejects the case and chambers a round', played('lever') >= 1 && casings.activeCount === cases + 1 &&
    rifle.chamber === 'live' && rifle.magazine === 9, `chamber=${rifle.chamber} mag=${rifle.magazine}`);
  check('the lever swings and returns', Math.abs(rifle.lever.rotation.x) < 0.01);
  await pull();
  check('fires again after the lever', shot !== null);

  // Run it dry.
  for (let i = 0; i < 12; i++) { await lever(); await pull(); }
  check('runs out: empty chamber, empty magazine', rifle.chamber === 'empty' && rifle.magazine === 0, `${rifle.chamber} ${rifle.magazine}`);

  // --- Ballistics -----------------------------------------------------------------------
  rifle.magazine = 5;
  await lever();
  pose(R, V(0, 1.5, 0), new THREE.Quaternion());
  for (const k of Object.keys(rifle.recoil)) rifle.recoil[k] = 0;
  await frames(4);
  rifle.muzzle.updateWorldMatrix(true, false);
  const mo = V(0, 0, 0).setFromMatrixPosition(rifle.muzzle.matrixWorld);
  shot = null;
  await pull();
  const hit = shot?.hit;
  const run = hit ? Math.hypot(hit.point.x - mo.x, hit.point.z - mo.z) : 0;
  check('level shot hits the saloon', hit?.object.parent?.name === 'saloon', hit?.object?.parent?.name);
  check('drops less than the revolver (400 m/s)', hit && Math.abs((mo.y - hit.point.y) - dropAt(run, MUZZLE_VELOCITY)) < 0.006 && dropAt(run, MUZZLE_VELOCITY) < dropAt(run, 260) / 2,
    hit ? `drop ${(mo.y - hit.point.y).toFixed(4)} vs ${dropAt(run, MUZZLE_VELOCITY).toFixed(4)} (revolver ${dropAt(run, 260).toFixed(4)})` : 'miss');

  // --- Sights ---------------------------------------------------------------------------
  const rear = rifle.sightRear.position;
  const fr = rifle.sightFront.position;
  const boreY = rifle.muzzle.position.y;
  const sightY25 = rear.y + ((fr.y - rear.y) * (-25 - rear.z)) / (fr.z - rear.z);
  check('sight line meets the bullet at 25 m', Math.abs(sightY25 - (boreY - dropAt(25, MUZZLE_VELOCITY))) < 0.0005,
    `sight ${sightY25.toFixed(4)} bullet ${(boreY - dropAt(25, MUZZLE_VELOCITY)).toFixed(4)}`);
  // Park the running outlaw at the end of his rail so he can't cross the shot.
  tm.runner.speed = 0;
  tm.runner.x = -tm.runner.halfLength;
  const gong = tm.gongs[2]; // the small far one, ~24 m
  gong.swing = gong.swingVel = gong.twist = gong.twistVel = 0;
  await frames(2);
  const target = gong.plate.getWorldPosition(V(0, 0, 0));
  const GUN = V(0.3, 1.5, 0.2);
  const dirLocal = fr.clone().sub(rear).normalize();
  const qLocalInv = new THREE.Quaternion().setFromUnitVectors(V(0, 0, -1), dirLocal).invert();
  let q = new THREE.Quaternion();
  for (let i = 0; i < 5; i++) {
    const rw = rear.clone().applyQuaternion(q).add(GUN);
    q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(rw, target, V(0, 1, 0))).multiply(qLocalInv);
  }
  pose(R, GUN, q);
  for (const k of Object.keys(rifle.recoil)) rifle.recoil[k] = 0;
  await frames(4);
  let report = null;
  const onHit = (e) => { report = e.report; };
  tm.addEventListener('hit', onHit);
  await lever();
  for (const k of Object.keys(rifle.recoil)) rifle.recoil[k] = 0;
  await frames(2);
  await pull();
  tm.removeEventListener('hit', onHit);
  check('sights on the 24 m gong: a centre hit', report?.type === 'gong' && report.precision > 0.9, report ? `${report.zone} ${report.precision.toFixed(3)}` : 'miss');

  // --- Two hands -------------------------------------------------------------------------
  pose(R, V(0.2, 1.35, 0.05), new THREE.Quaternion());
  await frames(3);
  pose(L, rifle.foreEnd.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: L });
  check('the other hand steadies it on the fore-end', rifle.support === L && L.held?.type === 'rifleSupport');
  const front = V(-0.1, 1.45, -0.4);
  pose(L, front);
  await frames(4);
  const barrel = V(0, 0, -1).transformDirection(rifle.muzzle.matrixWorld);
  const line = front.clone().sub(R.position).normalize();
  check('two-handed: it points from the back hand to the front hand', barrel.dot(line) > 0.995, barrel.dot(line).toFixed(4));
  xr.dispatchEvent({ type: 'squeezeend', hand: L });
  await frames(2);
  check('letting go with the front hand: back to one hand', rifle.support === null && L.held === null);

  // --- Back to the rack ---------------------------------------------------------------
  xr.dispatchEvent({ type: 'squeezeend', hand: R });
  check('released: it returns to the rack', await until(() => rifle.state === 'racked', 60) && R.held === null);
  check('and the rack reloads it', rifle.rounds === 11, rifle.rounds);

  // --- Duels treat it as a gun -------------------------------------------------------
  pose(L, V(-0.6, 1.0, 0.4));
  duel.waitRange = [0.5, 0.6];
  duel.start();
  check('rifle on the rack counts as put away: countdown', await until(() => duel.state === 'countdown', 120), duel.state);
  pose(R, rifle.object.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(2);
  check('grabbing the rifle early is a foul', duel.fouls === 1 && duel.hud.text === 'JUMPED THE GUN');
  duel.stop();
  xr.dispatchEvent({ type: 'squeezeend', hand: R });
  await until(() => rifle.state === 'racked', 60);
  return out;
};
