/**
 * Duel mode suite: start by shooting the DUEL plate, holster prompt,
 * countdown, jumping the gun, the draw signal, winning a round by drawing and
 * shooting, losing one by being too slow, the faster next outlaw, the summary,
 * and the return to free play. Runs inside the page.
 */
module.exports = async function duelSuite() {
  const g = window.__game;
  const { THREE, targets: tm, revolver: rev, xr, holster, sfx, duel } = g;
  tm.duelEnabled = true; // free play is on; the duel must pause and restore it
  tm.duel.timer = 9999; // ...but keep random pop-ups out of this test

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
  const played = (k) => sfx.played[k] ?? 0;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const pulses = [];
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

  const hip = () => holster.socket.getWorldPosition(V(0, 0, 0));
  const draw = async () => {
    pose(R, hip());
    await frames(2);
    xr.dispatchEvent({ type: 'squeezestart', hand: R });
    await frames(4);
  };
  const holsterGun = async () => {
    pose(R, hip());
    await frames(6);
    xr.dispatchEvent({ type: 'squeezeend', hand: R });
    return until(() => rev.state === 'holstered', 120);
  };
  const GUN = V(0.3, 1.5, 0.2);
  const aimAt = async (point) => {
    for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
    const m = new THREE.Matrix4().lookAt(GUN.clone().add(V(0, 0.06, 0)), point, V(0, 1, 0));
    pose(R, GUN, new THREE.Quaternion().setFromRotationMatrix(m));
    await frames(2);
  };
  const pullDA = async () => {
    rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(2);
    rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  };

  check('starts idle', duel.state === 'idle' && !duel.active);

  // --- Start: shoot the DUEL plate ---------------------------------------------------
  await draw();
  await frames(8);
  await aimAt(tm.duelPlate.plate.getWorldPosition(V(0, 0, 0)));
  await pullDA();
  await frames(2);
  check('shooting the DUEL plate starts a duel', duel.state === 'holster' && duel.round === 0, duel.state);
  check('free-range pop-ups paused', tm.duelEnabled === false);
  check('sign asks you to holster', duel.hud.sprite.visible && duel.hud.text === 'ROUND 1' && duel.hud.sub.includes('Holster'),
    `${duel.hud.text} | ${duel.hud.sub}`);

  // --- Holster -> countdown ----------------------------------------------------------
  duel.waitRange = [0.15, 0.25];
  const ticks = played('tick');
  check('holstered', await holsterGun());
  await frames(2);
  check('holstering starts the countdown at 3', duel.state === 'countdown' && duel.hud.text === '3' && played('tick') === ticks + 1,
    `${duel.state} ${duel.hud.text}`);
  check('countdown reaches 2', await until(() => duel.hud.text === '2', 90));

  // --- Foul: touch the gun before "DRAW!" ---------------------------------------------
  await draw();
  check('drawing early is a foul', duel.state === 'holster' && duel.fouls === 1 && duel.hud.text === 'JUMPED THE GUN', duel.hud.text);
  await frames(30);
  check('foul message stays up until you re-holster', duel.hud.text === 'JUMPED THE GUN');
  check('re-holstered', await holsterGun());
  await frames(2);
  check('countdown restarts', duel.state === 'countdown' && duel.hud.text === '3');

  // --- Draw signal --------------------------------------------------------------------
  const bells = played('bell');
  check('"DRAW!" after 3-2-1 and a pause', await until(() => duel.state === 'draw', 300) && duel.hud.text === 'DRAW!', duel.state);
  const live = tm.duelists.filter((d) => d.isLive);
  check('one outlaw springs up with the bell', live.length === 1 && live[0] === duel.opponent && played('bell') === bells + 1, live.length);

  // --- Win: draw and shoot him before he fires -----------------------------------------
  const opp = duel.opponent;
  await draw();
  await until(() => rev.isHeld, 10);
  const heart = opp.object.localToWorld(V(0, 0.15 + 1.1, 0.01));
  await aimAt(heart);
  await pullDA();
  await frames(2);
  const r1 = duel.results[0];
  check('hit before he fires: round won', duel.state === 'result' && r1?.won === true, JSON.stringify(r1));
  check('draw time measured from the signal', r1 && r1.time > 0 && r1.time < r1.outlawTime, r1 && `${r1.time.toFixed(2)} < ${r1.outlawTime}`);
  check('sign shows your time', duel.hud.text.endsWith(' s') && duel.hud.sub.includes('beat him'), `${duel.hud.text} | ${duel.hud.sub}`);

  // --- Round 2: a faster outlaw, and we're too slow -------------------------------------
  check('next round asks you to holster', await until(() => duel.state === 'holster', 300) && duel.hud.text === 'ROUND 2', duel.hud.text);
  check('the next outlaw is faster', duel.outlawTime < r1.outlawTime, `${duel.outlawTime} < ${r1.outlawTime}`);
  check('holstered for round 2', await holsterGun());
  check('round 2 draw', await until(() => duel.state === 'draw', 400));
  const shotsBack = played('outlawShot');
  const pulsesBefore = pulses.length;
  check('too slow: the outlaw fires', await until(() => played('outlawShot') === shotsBack + 1, 200));
  check('you\'re dead: red flash, hard rumble in both hands', duel.hud.text === "YOU'RE DEAD" && duel.hud.flash.visible &&
    pulses.slice(pulsesBefore).filter((p) => p.i === 1).length >= 2, duel.hud.text);
  check('round recorded as lost', duel.results[1]?.won === false);
  check('he goes back down after firing', await until(() => tm.duelists.every((d) => !d.isLive), 120));

  // --- Summary and back to free play -------------------------------------------------
  check('summary after a loss', await until(() => duel.state === 'summary', 200) && duel.hud.text === '1 / 5', duel.hud.text);
  check('back to free play', await until(() => duel.state === 'idle', 300) && !duel.hud.sprite.visible);
  check('free-range pop-ups restored', tm.duelEnabled === true);
  check('outlaws packed away after the duel', tm.duelists.every((d) => !d.active && !d.object.visible));
  return out;
};
