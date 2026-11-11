/**
 * Dual-wield suite: the second gun is off by default (hidden, not grabbable);
 * switching it on puts a holster on the off-hand hip and moves the pouch to the
 * front of the belt; both guns can be drawn and fired at once, each with its own
 * cylinder; duels require both holstered and count either gun as a foul;
 * switching it off stows it even from a hand. Runs inside the page.
 */
module.exports = async function dualSuite() {
  const g = window.__game;
  const { THREE, settings, revolver: rev1, revolver2: rev2, holster, holster2, pouch, xr, targets: tm, duel } = g;
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
  const lgp = fake(L, 'left');
  pose(L, V(-0.6, 1.0, 0.4));
  pose(R, V(0.6, 1.0, 0.4));
  await frames(3);
  const head = () => g.camera.getWorldPosition(V(0, 0, 0));
  const sideOf = (obj) => obj.getWorldPosition(V(0, 0, 0)).x - head().x;
  const draw = async (hand, h) => {
    pose(hand, h.object.getWorldPosition(V(0, 0, 0)));
    await frames(3);
    xr.dispatchEvent({ type: 'squeezestart', hand });
    await frames(10);
  };

  // --- Off by default -----------------------------------------------------------------
  check('second gun off by default: hidden', settings.get('secondGun') === false && !rev2.enabled && !rev2.object.visible && !holster2.object.visible);
  await draw(L, holster2);
  // (That hip holds the cartridge pouch while the second gun is off, so the
  // squeeze takes cartridges instead.)
  check('a hidden gun cannot be grabbed', !rev2.isHeld && L.held !== rev2, L.held?.type);
  xr.dispatchEvent({ type: 'squeezeend', hand: L });
  pose(L, V(-0.6, 1.0, 0.4));
  await frames(2);
  check('pouch on the off-hand hip with one gun', sideOf(pouch.object) < -0.1, sideOf(pouch.object).toFixed(2));

  // --- Switch it on ---------------------------------------------------------------------
  settings.set('secondGun', true);
  await frames(3);
  check('second gun on: shown, holster on the off-hand hip', rev2.enabled && rev2.object.visible && holster2.object.visible && sideOf(holster2.object) < -0.1,
    sideOf(holster2.object).toFixed(2));
  check('pouch moves to the front of the belt', Math.abs(sideOf(pouch.object)) < 0.12 && pouch.object.getWorldPosition(V(0, 0, 0)).z < head().z - 0.1,
    sideOf(pouch.object).toFixed(2));

  // --- Draw both and fire both ------------------------------------------------------------
  await draw(R, holster);
  await draw(L, holster2);
  check('both guns drawn, one in each hand', rev1.isHeld && rev1.hand === R && rev2.isHeld && rev2.hand === L);
  const down = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -0.4);
  pose(R, V(0.25, 1.3, -0.1), down);
  pose(L, V(-0.25, 1.3, -0.1), down);
  await frames(4);
  const shots0 = tm.stats.shots;
  const shotsBy = new Map();
  for (const gun of [rev1, rev2]) gun.addEventListener('shot', () => shotsBy.set(gun, (shotsBy.get(gun) ?? 0) + 1));
  for (const gp of [rgp, lgp]) { gp.buttons[0].value = 1; gp.buttons[0].pressed = true; }
  await frames(3);
  for (const gp of [rgp, lgp]) { gp.buttons[0].value = 0; gp.buttons[0].pressed = false; }
  await frames(3);
  check('both triggers fire both guns', shotsBy.get(rev1) === 1 && shotsBy.get(rev2) === 1 && tm.stats.shots === shots0 + 2,
    `${shotsBy.get(rev1)} ${shotsBy.get(rev2)} stats ${tm.stats.shots - shots0}`);
  check('each gun has its own cylinder', rev1.chambers.filter((c) => c === 'spent').length === 1 && rev2.chambers.filter((c) => c === 'spent').length === 1);

  // --- Holster both, then a duel -----------------------------------------------------------
  for (const [hand, h, gun] of [[R, holster, rev1], [L, holster2, rev2]]) {
    pose(hand, h.socket.getWorldPosition(V(0, 0, 0)));
    await frames(7);
    xr.dispatchEvent({ type: 'squeezeend', hand });
    await until(() => gun.state === 'holstered', 60);
  }
  check('both holstered', rev1.state === 'holstered' && rev2.state === 'holstered');
  pose(R, V(0.6, 1.0, 0.4));
  pose(L, V(-0.6, 1.0, 0.4));
  // A duel waits for every gun to be holstered.
  await draw(L, holster2);
  duel.start();
  await frames(5);
  check('duel waits while the second gun is out', duel.state === 'holster', duel.state);
  pose(L, holster2.socket.getWorldPosition(V(0, 0, 0)));
  await frames(7);
  xr.dispatchEvent({ type: 'squeezeend', hand: L });
  check('both holstered: the countdown starts', await until(() => duel.state === 'countdown', 120), duel.state);
  await draw(L, holster2);
  check('drawing the second gun early is a foul too', duel.fouls === 1 && duel.hud.text === 'JUMPED THE GUN', duel.hud.text);
  duel.stop();

  // --- Switch it off with the gun in hand ------------------------------------------------
  check('second gun in the left hand', rev2.hand === L && L.held === rev2);
  settings.set('secondGun', false);
  await frames(3);
  check('switching off stows and hides it, freeing the hand', !rev2.enabled && rev2.state === 'holstered' && L.held === null && !rev2.object.visible);
  check('pouch back on the off-hand hip', sideOf(pouch.object) < -0.1, sideOf(pouch.object).toFixed(2));
  return out;
};
