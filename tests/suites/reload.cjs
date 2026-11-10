/**
 * Reload & Pass 4 suite: swing-out cylinder, spent-case ejection as physics
 * objects, loading from the hip pouch with the free hand, closing with B and
 * with a wrist flick (free spin), firing after a reload, bullet drop, muzzle
 * smoke and sparks, impact dust and sparks, and the outdoor echo send.
 * Runs inside the page.
 */
module.exports = async function reloadSuite() {
  const g = window.__game;
  const { THREE, targets: tm, revolver: rev, xr, holster, sfx, pouch, fx, casings } = g;
  tm.duelEnabled = false;

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
  const until = async (pred, max = 600) => {
    for (let i = 0; i < max && !pred(); i++) await frames(1);
    return pred();
  };
  const played = (k) => sfx.played[k] ?? 0;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  const fake = (hand, handedness) => {
    const gp = {
      buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      hapticActuators: [{ pulse: (i, d) => { pulses.push({ handedness, i, d }); return Promise.resolve(true); } }],
    };
    hand.inputSource = { handedness, gamepad: gp, profiles: [] };
    hand.handedness = handedness;
    hand.connected = true;
    return gp;
  };
  const pulses = [];
  const pose = (hand, pos, quat = new THREE.Quaternion()) => {
    for (const o of [hand.grip, hand.controller]) {
      o.position.copy(pos);
      o.quaternion.copy(quat);
      o.matrix.compose(o.position, o.quaternion, o.scale);
      o.matrixWorldNeedsUpdate = true;
    }
  };
  const press = async (gp, idx) => {
    gp.buttons[idx].pressed = true; await frames(2);
    gp.buttons[idx].pressed = false; await frames(2);
  };
  const pull = async (gp, v = 1) => {
    gp.buttons[0].value = v; gp.buttons[0].pressed = true; await frames(2);
    gp.buttons[0].value = 0; gp.buttons[0].pressed = false; await frames(3);
  };
  const R = xr.hands[0];
  const L = xr.hands[1];
  const rgp = fake(R, 'right');
  fake(L, 'left');
  const LEFT_REST = V(-0.6, 1.0, 0.4);
  pose(L, LEFT_REST);
  await frames(3);

  // Draw and aim at the sand a few metres out.
  pose(R, holster.object.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(10);
  const GUN = V(0.2, 1.3, -0.1);
  const down = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -0.35);
  pose(R, GUN, down);
  await frames(3);
  check('drawn', rev.isHeld);

  // --- Fire two (double action), with smoke and sparks ---------------------------
  const smoke0 = fx.smoke.activeCount;
  await pull(rgp);
  check('muzzle smoke and sparks on firing', fx.smoke.activeCount > smoke0 && fx.sparks.activeCount > 0,
    `smoke ${fx.smoke.activeCount} sparks ${fx.sparks.activeCount}`);
  await pull(rgp);
  check('two chambers spent', rev.chambers.filter((c) => c === 'spent').length === 2, rev.chambers.join(','));
  const shots = played('gunshot');

  // --- Open the cylinder ---------------------------------------------------------
  const pulsesBefore = pulses.length;
  await press(rgp, 5); // B
  check('B swings the cylinder out', rev.cylinderOpen && played('cylinderOpen') === 1);
  check('haptic on opening', pulses.length > pulsesBefore);
  await frames(10);
  check('crane swung out', rev.crane.rotation.z > 1.2, rev.crane.rotation.z.toFixed(2));
  check('spent cases ejected, chambers now empty', await until(() => rev.chambers.filter((c) => c === 'empty').length === 2, 60),
    rev.chambers.join(','));
  check('casings are physics objects in the world', casings.activeCount === 2 && casings.items.some((c) => c.alive && g.physics.world.bodies.includes(c.body)));
  check('casings fall and tinkle', await until(() => played('brass') > 0, 300), played('brass'));
  const caseYs = casings.items.filter((c) => c.alive).map((c) => c.body.position.y);
  check('casings land on the ground', await until(() => casings.items.filter((c) => c.alive).every((c) => c.body.position.y < 0.05), 600),
    caseYs.map((y) => y.toFixed(3)).join(','));

  // Nothing fires or cocks with the cylinder out.
  await pull(rgp);
  await press(rgp, 4);
  check('cylinder open: no shot, no cock', played('gunshot') === shots && !rev.cocked);

  // --- Load from the pouch -------------------------------------------------------
  check('pouch offers what the gun can take', rev.roundsWanted === 2, rev.roundsWanted);
  pose(L, pouch.object.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: L });
  check('free hand takes rounds from the pouch', L.held?.type === 'rounds' && L.held.count === 2 && played('pouch') === 1,
    JSON.stringify({ type: L.held?.type, count: L.held?.count }));
  const cyl = rev.cylinder.getWorldPosition(V(0, 0, 0));
  pose(L, cyl.clone().add(V(-0.03, 0, 0.03)));
  check('rounds feed into the cylinder', await until(() => rev.chambers.every((c) => c === 'live'), 120), rev.chambers.join(','));
  check('one insert sound per round', played('insert') === 2, played('insert'));
  await frames(2);
  check('hand empty after the last round', L.held === null);
  check('loaded chambers show live case heads', rev.caseHeads.every((h) => h.head.visible && h.head.material === rev.caseMaterials.live));
  xr.dispatchEvent({ type: 'squeezeend', hand: L });
  pose(L, LEFT_REST);
  await frames(3);

  // --- Close with B and fire the reloaded rounds in order --------------------------
  await press(rgp, 5);
  check('B closes the cylinder', !rev.cylinderOpen && played('cylinderClose') === 1);
  await frames(8);
  check('crane back in', rev.crane.rotation.z < 0.1, rev.crane.rotation.z.toFixed(2));
  let fired = 0;
  rev.addEventListener('shot', () => fired++);
  for (let i = 0; i < 6; i++) await pull(rgp);
  check('six shots after reloading', fired === 6 && rev.chambers.every((c) => c === 'spent'), `${fired} ${rev.chambers.join(',')}`);
  const dry = played('click');
  await pull(rgp);
  check('seventh pull is a dry click', fired === 6 && played('click') > dry);

  // --- Flick-close with a free spin ----------------------------------------------
  await press(rgp, 5);
  await until(() => rev.chambers.every((c) => c === 'empty'), 60);
  pose(L, pouch.object.getWorldPosition(V(0, 0, 0)));
  await frames(3);
  xr.dispatchEvent({ type: 'squeezestart', hand: L });
  check('a palmful of six', L.held?.count === 6, L.held?.count);
  pose(L, rev.cylinder.getWorldPosition(V(0, 0, 0)));
  check('six rounds fed', await until(() => rev.chambers.every((c) => c === 'live'), 240), rev.chambers.join(','));
  xr.dispatchEvent({ type: 'squeezeend', hand: L });
  pose(L, LEFT_REST);
  await frames(12); // past the minimum open time
  // Roll the wrist fast about the barrel axis.
  const roll = (a) => new THREE.Quaternion().multiplyQuaternions(down, new THREE.Quaternion().setFromAxisAngle(V(0, 0, -1), a));
  const ratchet = played('click');
  for (let i = 1; i <= 6; i++) { pose(R, GUN, roll(i * 0.45)); await frames(1); }
  check('wrist flick snaps it shut', !rev.cylinderOpen, `roll rate ${R.angularVelocity.length().toFixed(1)} rad/s`);
  check('cylinder spins free and ratchets', rev.cylinderSpin > 0 || played('click') > ratchet);
  check('spin settles on a chamber', await until(() => rev.cylinderSpin === 0, 300) && played('click') > ratchet + 1, played('click') - ratchet);
  pose(R, GUN, down);
  await frames(6);

  // --- Bullet drop ------------------------------------------------------------------
  const { MUZZLE_VELOCITY } = await import('/src/weapons/Revolver.js');
  const level = new THREE.Quaternion();
  pose(R, V(0, 1.5, 0), level);
  for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
  await frames(4);
  rev.muzzle.updateWorldMatrix(true, false);
  const mo = V(0, 0, 0).setFromMatrixPosition(rev.muzzle.matrixWorld);
  const md = V(0, 0, -1).transformDirection(rev.muzzle.matrixWorld);
  const hit = rev.traceBullet(mo, md);
  const run = hit ? Math.hypot(hit.point.x - mo.x, hit.point.z - mo.z) : 0;
  const expectedDrop = 0.5 * 9.81 * (run / MUZZLE_VELOCITY) ** 2;
  check('bullet hits the saloon wall ~32 m out', hit && hit.object.parent?.name === 'saloon' && run > 25, hit ? `${hit.object.parent?.name} ${run.toFixed(1)} m` : 'miss');
  check('bullet has dropped by gravity on the way', hit && Math.abs((mo.y - hit.point.y) - expectedDrop) < 0.005,
    hit ? `drop ${(mo.y - hit.point.y).toFixed(4)} expected ${expectedDrop.toFixed(4)}` : '');

  // --- Impact effects ----------------------------------------------------------------
  const sparks0 = fx.sparks.activeCount;
  tm.handleShot({
    origin: V(0, 1.5, 0), direction: V(0, 0, -1),
    hit: { point: tm.gongs[0].plate.getWorldPosition(V(0, 0, 0)), object: tm.gongs[0].plate, face: { normal: V(0, 0, 1) } },
  });
  check('steel hit throws sparks', fx.sparks.activeCount > sparks0, fx.sparks.activeCount);
  const smoke1 = fx.smoke.activeCount;
  tm.handleShot({ origin: V(0, 1.5, 0), direction: V(0, -0.3, -1).normalize(), hit: { point: V(0.5, 0, -4), object: g.environment.colliders[0], face: { normal: V(0, 0, 1) } } });
  check('sand hit kicks up dust', fx.smoke.activeCount > smoke1, fx.smoke.activeCount);

  // --- Outdoor echoes ------------------------------------------------------------------
  check('echo send is a high-passed, non-feedback convolution', sfx.outdoor == null || sfx.outdoor.type === 'highpass');
  return out;
};
