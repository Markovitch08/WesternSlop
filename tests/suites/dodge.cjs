/**
 * Dodge suite: the duel outlaw aims at your head a moment before he fires.
 * Standing still: hit. Moving off the line after he aims: a miss (whizz),
 * the round goes on and he fires again. Leaning early doesn't help (he aims
 * where you are). Shooting him after a dodge still wins. Runs inside the page.
 */
module.exports = async function dodgeSuite() {
  const g = window.__game;
  const { THREE, duel, revolver: rev, xr, holster, sfx, targets: tm } = g;
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
  pose(R, V(0.6, 1.0, 0.4));
  await frames(3);
  const cam = g.camera;
  const home = cam.position.clone();
  const startRound = async () => {
    cam.position.copy(home);
    duel.waitRange = [0.1, 0.15];
    if (!duel.active) duel.start();
    return until(() => duel.state === 'draw', 400);
  };
  const untilDrawTime = (t) => until(() => duel.state !== 'draw' || duel.drawTime >= t, 400);

  // --- The tell: arm up, then glint + click as he aims; flash + tracer as he fires ---
  let atAim = null;
  duel.addEventListener('aim', () => {
    const o = duel.opponent;
    atAim = { arm: o.aimLevel, glint: o.glint.visible || o.glintTime > 0 };
  });
  const cocks = played('outlawCock');
  check('duel at the draw', await startRound());
  const opp0 = duel.opponent;
  check('his gun arm hangs at his side at first', opp0.aimLevel < 0.2, opp0.aimLevel.toFixed(2));
  await until(() => atAim !== null, 400);
  check('his arm is up by the time he aims', atAim?.arm > 0.9, atAim?.arm?.toFixed(2));
  check('a glint on his gun as he takes aim', atAim?.glint === true);
  check('and his hammer clicks', played('outlawCock') === cocks + 1);
  let tracerSeen = null;
  for (let i = 0; i < 400 && duel.state === 'draw'; i++) {
    if (duel.tracer?.visible && !tracerSeen) tracerSeen = { len: duel.tracer.scale.z, flash: opp0.flashTime > 0 };
    await frames(1);
  }
  tracerSeen ??= duel.tracer?.visible ? { len: duel.tracer.scale.z, flash: opp0.flashTime > 0 } : null;
  check('a muzzle flash and a tracer streak when he fires', tracerSeen !== null && tracerSeen.flash, JSON.stringify(tracerSeen));
  const headDist = cam.getWorldPosition(V(0, 0, 0)).distanceTo(opp0.muzzleWorld());
  check('on a hit the tracer stops short of your eyes', tracerSeen && tracerSeen.len < headDist, `${tracerSeen?.len.toFixed(2)} < ${headDist.toFixed(2)}`);
  check('standing still: he hits you', duel.results.at(-1)?.won === false && duel.hud.text === "YOU'RE DEAD" && duel.lastMissDistance <= 0.22,
    `${duel.hud.text} miss=${duel.lastMissDistance?.toFixed(3)}`);
  duel.stop();
  await frames(3);

  // --- Lean early: he aims where you are, still a hit ---------------------------------
  check('second duel at the draw', await startRound());
  cam.position.x += 0.5; // lean well before he aims
  await until(() => duel.state !== 'draw', 400);
  check('leaning early does not help: he aims where you are', duel.results.at(-1)?.won === false,
    `miss=${duel.lastMissDistance?.toFixed(3)}`);
  duel.stop();
  cam.position.copy(home);
  await frames(3);

  // --- Dodge at the right moment ------------------------------------------------------
  check('third duel at the draw', await startRound());
  const whizz = played('whizz');
  const outlawTime = duel.outlawTime;
  await untilDrawTime(outlawTime - 0.12); // he has taken aim
  check('he has taken aim', duel.state === 'draw' && duel.aimPoint !== null);
  cam.position.x += 0.5; // now step off the line
  await untilDrawTime(outlawTime + 0.05);
  check('dodging off the line: he misses', duel.state === 'draw' && duel.dodges === 1 && duel.lastMissDistance > 0.22,
    `state=${duel.state} dodges=${duel.dodges} miss=${duel.lastMissDistance?.toFixed(3)}`);
  check('a whizz past your ear', played('whizz') === whizz + 1);
  check('on a miss the tracer runs on past you', duel.tracer.scale.z >= 40);
  check('the sign says he missed', duel.hud.text === 'MISSED!', duel.hud.text);
  check('he will fire again', duel.nextShotAt > outlawTime, duel.nextShotAt.toFixed(2));

  // --- ...and shoot him: a win, with the dodge on the sign ---------------------------
  const opp = duel.opponent;
  pose(R, holster.object.getWorldPosition(V(0, 0, 0)));
  await frames(2);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(4);
  for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
  const GUN = V(0.3, 1.5, 0.2);
  const heart = opp.object.localToWorld(V(0, 0.15 + 1.1, 0.01));
  pose(R, GUN, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(GUN.clone().add(V(0, 0.06, 0)), heart, V(0, 1, 0))));
  await frames(2);
  rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(2);
  rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  const last = duel.results.at(-1);
  check('shooting him after a dodge wins the round', last?.won === true && last.dodges === 1, JSON.stringify(last));
  check('the sign credits the dodge', duel.hud.sub.includes('dodged 1 shot'), duel.hud.sub);
  duel.stop();
  cam.position.copy(home);
  await frames(30);
  check('arm back down once it is over', g.targets.duelists.every((d) => d.aimLevel < 0.05));
  return out;
};
