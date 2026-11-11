/**
 * Twirl suite: a sharp wrist-pitch flick spins the revolver round the trigger
 * guard (whoosh + light rumble per turn), it can't fire mid-spin, the hand
 * catches it on a full turn, slow movement or a roll flick doesn't twirl, a
 * spin into the holster gets a flourish, and letting go mid-spin throws it
 * spinning. Runs inside the page.
 */
module.exports = async function twirlSuite() {
  const g = window.__game;
  const { THREE, revolver: rev, xr, holster, sfx, targets: tm } = g;
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
  const pulses = [];
  const fake = (hand, handedness) => {
    const gp = {
      buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      hapticActuators: [{ pulse: (i, d) => { pulses.push({ i, d }); return Promise.resolve(true); } }],
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
  const draw = async () => {
    pose(R, holster.object.getWorldPosition(V(0, 0, 0)));
    await frames(3);
    xr.dispatchEvent({ type: 'squeezestart', hand: R });
    await frames(10);
  };
  const GUN = V(0.25, 1.3, -0.1);
  const level = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -0.3);
  const rot = (axis, a) => level.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, a));
  /** Rotate the wrist about a gun-local axis, `step` radians per frame. */
  const flick = async (axis, step, n = 6, pos = GUN) => {
    for (let i = 1; i <= n; i++) { pose(R, pos, rot(axis, i * step)); await frames(1); }
  };
  const settle = async () => { pose(R, GUN, level); await frames(8); };
  const pull = async () => {
    rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(2);
    rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  };

  await frames(3);
  await draw();
  await settle();
  check('drawn, not twirling', rev.isHeld && !rev.twirling);

  // Slow movement or a roll flick don't twirl.
  await flick(V(1, 0, 0), 0.03);
  check('a slow wrist turn does not twirl', !rev.twirling);
  await settle();
  await flick(V(0, 0, 1), 0.5);
  check('a roll flick does not twirl', !rev.twirling);
  await settle();

  // A sharp pitch flick spins it.
  const whoosh = played('twirl');
  await flick(V(1, 0, 0), 0.5);
  check('a sharp wrist flick starts a twirl', rev.twirling && Math.abs(rev.twirlVel) > 6, rev.twirlVel.toFixed(1));
  pose(R, GUN, level);
  await frames(3);
  check('the gun spins round the trigger guard', Math.abs(rev.twirl.rotation.x) > 0.5, rev.twirl.rotation.x.toFixed(2));
  const shots = played('gunshot');
  await pull();
  check('it cannot fire mid-spin', played('gunshot') === shots);
  check('whoosh as it spins', played('twirl') > whoosh, played('twirl') - whoosh);
  check('caught on a full turn', await until(() => !rev.twirling, 300) && rev.twirl.rotation.x === 0 && rev.twirlTurns >= 1, `${rev.twirlTurns} turns`);
  check('a catch rumble', pulses.some((p) => p.i === 0.3 && p.d === 20));
  await frames(3);
  await pull();
  check('fires normally after the catch', played('gunshot') === shots + 1);

  // Spin it into the holster.
  await settle();
  let flourish = 0;
  rev.addEventListener('twirlHolster', () => flourish++);
  await flick(V(1, 0, 0), 0.5);
  check('spinning again', rev.twirling);
  pose(R, holster.socket.getWorldPosition(V(0, 0, 0)));
  await frames(1);
  xr.dispatchEvent({ type: 'squeezeend', hand: R });
  check('spun into the holster', rev.state === 'holstering' && flourish === 1 && !rev.twirling, rev.state);
  check('"SMOOTH!" flourish', tm.text.items.some((it) => it.sprite.visible));
  check('holstered', await until(() => rev.state === 'holstered', 60));

  // Let go mid-spin elsewhere: it flies off spinning.
  await draw();
  await settle();
  await flick(V(1, 0, 0), 0.5);
  check('spinning before the throw', rev.twirling);
  xr.dispatchEvent({ type: 'squeezeend', hand: R });
  check('let go mid-spin: thrown, still spinning', rev.state === 'dropped' && rev.body.angularVelocity.length() > 5,
    rev.body.angularVelocity.length().toFixed(1));
  rev.recall();
  await until(() => rev.state === 'holstered', 60);
  return out;
};
