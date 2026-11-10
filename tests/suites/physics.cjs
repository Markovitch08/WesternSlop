/**
 * Physics & sights suite: the revolver as a rigid body (drop, land, rest on
 * props, pick up, throw with hand velocity, break bottles, ring gongs, knock
 * duelists, recall, out-of-bounds return) and sight alignment, both geometric
 * and end-to-end (aim with the sights, fire, check where the bullet lands).
 * Runs inside the page.
 */
module.exports = async function physicsSuite() {
  const g = window.__game;
  const { THREE, targets: tm, revolver: rev, xr, holster, sfx, physics } = g;
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
  const until = async (pred, max = 900) => {
    for (let i = 0; i < max && !pred(); i++) await frames(1);
    return pred();
  };
  const played = (k) => sfx.played[k] ?? 0;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const fmt = (v) => v.toArray().map((n) => n.toFixed(3)).join(',');

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

  const SLEEPING = 2;
  const inWorld = () => physics.world.bodies.includes(rev.body);
  const gunPos = () => rev.object.getWorldPosition(V(0, 0, 0));
  const grabAt = async (pos) => {
    pose(R, pos);
    await frames(4);
    xr.dispatchEvent({ type: 'squeezestart', hand: R });
    await frames(10);
    return rev.isHeld;
  };
  const dropAt = async (pos) => {
    pose(R, pos);
    await frames(7); // hold still past the 5-frame throw window: a plain drop
    xr.dispatchEvent({ type: 'squeezeend', hand: R });
  };
  /** Drop the gun at `from` and give it a throw velocity toward `to`. */
  const throwAt = async (from, to, speed = 6) => {
    await dropAt(from);
    const v = to.clone().sub(from).normalize().multiplyScalar(speed);
    rev.body.velocity.set(v.x, v.y + 0.6, v.z);
    rev.body.angularVelocity.set(0, 0, 0);
    rev.body.wakeUp();
  };

  // --- Draw ----------------------------------------------------------------------
  await frames(3);
  check('drawn from holster', await grabAt(holster.object.getWorldPosition(V(0, 0, 0))));
  check('no physics body while held', !inWorld());

  // --- Drop on the sand ------------------------------------------------------------
  const clatterBefore = played('clatter');
  let impactSurface = null;
  rev.addEventListener('impact', (e) => { impactSurface ??= e.surface; });
  await dropAt(V(1.0, 1.4, -2.5));
  check('let go away from the hip: drops', rev.state === 'dropped' && rev.object.parent === g.scene && inWorld(), rev.state);
  await frames(3);
  check('hand empty after drop', R.held === null && R.model.visible);
  check('falls under gravity', gunPos().y < 1.39, fmt(gunPos()));
  const settled = await until(() => rev.body.sleepState === SLEEPING, 900);
  check('comes to rest on the ground', settled,
    `state=${rev.body.sleepState} v=${rev.body.velocity.length().toFixed(4)} w=${rev.body.angularVelocity.length().toFixed(4)}`);
  let p = gunPos();
  check('rests on top of the sand, not through it', p.y > 0 && p.y < 0.12, fmt(p));
  check('lands where it was dropped', Math.hypot(p.x - 1.0, p.z + 2.5) < 0.5, fmt(p));
  check('clatters on landing', played('clatter') > clatterBefore && impactSurface === 'sand', `${played('clatter')} ${impactSurface}`);

  const shots = played('gunshot');
  rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(3);
  rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  check('a dropped gun does not fire', played('gunshot') === shots);

  // --- Pick up again ------------------------------------------------------------
  check('too far to reach: no grab', !(await grabAt(p.clone().add(V(0.6, 0.5, 0)))) && rev.state === 'dropped');
  check('picked up off the ground', await grabAt(p.clone().add(V(0, 0.05, 0))) && !inWorld());

  // --- Drop onto the bench -----------------------------------------------------------
  await dropAt(V(0.1, 1.3, -0.8));
  check('settles on the bench', await until(() => rev.body.sleepState === SLEEPING, 900));
  p = gunPos();
  check('rests on the bench top (0.9 m)', p.y > 0.88 && p.y < 1.0, fmt(p));
  check('picked up off the bench', await grabAt(p.clone().add(V(0, 0.05, 0))));

  // --- Throw: the gun inherits the hand's motion ----------------------------------
  pose(R, V(0.5, 1.4, -1.5));
  await frames(4);
  for (let i = 1; i <= 3; i++) { pose(R, V(0.5, 1.4, -1.5 - i * 0.08)); await frames(1); }
  xr.dispatchEvent({ type: 'squeezeend', hand: R });
  const v0 = rev.body.velocity;
  check('thrown with the hand\'s velocity', rev.state === 'dropped' && v0.z < -0.5, `${v0.x.toFixed(2)},${v0.y.toFixed(2)},${v0.z.toFixed(2)}`);
  await until(() => rev.body.sleepState === SLEEPING, 900);
  check('picked up after the throw', await grabAt(gunPos().add(V(0, 0.05, 0))));

  // --- Interact with targets -------------------------------------------------------
  const bottle = tm.bottleGroups[0].bottles[0];
  const bottleCenter = bottle.mesh.localToWorld(V(0, 0.15, 0));
  const glass = played('glass');
  await throwAt(bottleCenter.clone().add(V(0, 0, 0.7)), bottleCenter);
  check('thrown gun breaks a bottle', await until(() => bottle.broken, 200) && played('glass') === glass + 1);
  await until(() => rev.body.sleepState === SLEEPING, 900);
  check('picked up after the bottle', await grabAt(gunPos().add(V(0, 0.05, 0))));

  const gong = tm.gongs[0];
  const plate = gong.plate.getWorldPosition(V(0, 0, 0));
  const towardPlayer = V(0, 0, 0.8).applyQuaternion(gong.object.getWorldQuaternion(new THREE.Quaternion()));
  const steel = played('steel');
  await throwAt(plate.clone().add(towardPlayer), plate);
  check('thrown gun rings and swings a gong', await until(() => played('steel') > steel, 200) && Math.abs(gong.swingVel) + Math.abs(gong.swing) > 0.01,
    `${played('steel') - steel} ${gong.swingVel.toFixed(3)}`);
  await until(() => rev.body.sleepState === SLEEPING, 900);
  check('picked up after the gong', await grabAt(gunPos().add(V(0, 0.05, 0))));

  const duelist = tm.duelists[2];
  const won = tm.stats.duelsWon;
  tm.forcePopup(2);
  await until(() => duelist.state === 'up');
  const chest = duelist.board.localToWorld(V(0, 1.1, 0.02));
  const front = V(0, 0, 0.8).applyQuaternion(duelist.object.getWorldQuaternion(new THREE.Quaternion()));
  await throwAt(chest.clone().add(front), chest);
  check('thrown gun knocks a duelist over (no score)', await until(() => duelist.state === 'falling' || duelist.state === 'down', 200) &&
    tm.stats.duelsWon === won && tm.duel.phase === 'wait', duelist.state);

  // --- Recall and out-of-bounds -----------------------------------------------------
  await until(() => rev.body.sleepState === SLEEPING, 900);
  lgp.buttons[3].pressed = true; await frames(2); lgp.buttons[3].pressed = false;
  check('thumbstick click recalls a dropped gun', rev.state === 'holstering' && !inWorld(), rev.state);
  check('recalled gun ends up holstered', await until(() => rev.state === 'holstered', 120));

  await grabAt(holster.object.getWorldPosition(V(0, 0, 0)));
  await dropAt(V(-1, 1.4, -2));
  // The ground is an infinite half-space (nothing falls through it), so "lost"
  // means thrown out past the play area.
  rev.body.position.set(80, 1, -80);
  await frames(3);
  check('a gun thrown out of the play area returns to the holster', await until(() => rev.state === 'holstered', 120), rev.state);

  // --- Sights ------------------------------------------------------------------------
  // Geometric: the line from the rear notch over the front blade crosses the bore line at the zero distance.
  const rear = rev.sightRear.position;
  const fr = rev.sightFront.position;
  const boreY = rev.muzzle.position.y;
  const crossZ = rear.z + ((boreY - rear.y) * (fr.z - rear.z)) / (fr.y - rear.y);
  check('sight line crosses the bore at 15 m', Math.abs(crossZ + 15) < 0.05, crossZ.toFixed(3));
  check('front blade is above the barrel and below the rear notch', fr.y > boreY + 0.0085 && fr.y < rear.y, `${fr.y.toFixed(4)} ${rear.y}`);

  // End to end: line the sights up on a target, fire, see where the bullet lands.
  check('drawn for sight tests', await grabAt(holster.object.getWorldPosition(V(0, 0, 0))));
  const GUN = V(0.3, 1.5, 0.2);
  const sightAim = async (target) => {
    Object.assign(rev.recoil, { ang: 0, angVel: 0, z: 0, zVel: 0 });
    const dirLocal = fr.clone().sub(rear).normalize();
    const qLocalInv = new THREE.Quaternion().setFromUnitVectors(V(0, 0, -1), dirLocal).invert();
    let q = new THREE.Quaternion();
    for (let i = 0; i < 5; i++) {
      const rearWorld = rear.clone().applyQuaternion(q).add(GUN);
      const m = new THREE.Matrix4().lookAt(rearWorld, target, V(0, 1, 0));
      q = new THREE.Quaternion().setFromRotationMatrix(m).multiply(qLocalInv);
    }
    pose(R, GUN, q);
    await frames(3);
  };
  let report = null;
  tm.addEventListener('hit', (e) => { report = e.report; });
  const fire = async () => {
    rev.chambers.fill('live');
    Object.assign(rev.recoil, { ang: 0, angVel: 0, z: 0, zVel: 0 });
    report = null;
    rgp.buttons[4].pressed = true; await frames(2);
    rgp.buttons[4].pressed = false; await frames(2);
    rgp.buttons[0].value = 0.6; rgp.buttons[0].pressed = true; await frames(2);
    rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(3);
    return report;
  };

  gong.swing = gong.swingVel = gong.twist = gong.twistVel = 0;
  await frames(2);
  const gongCenter = gong.plate.getWorldPosition(V(0, 0, 0));
  await sightAim(gongCenter);
  let r = await fire();
  check('sights on the 14 m gong centre: hit within 7.5 mm', r?.type === 'gong' && r.precision > 0.97,
    r ? `${r.zone} precision=${r.precision.toFixed(4)} dist=${r.distance.toFixed(1)}` : 'miss');

  const d1 = tm.duelists[1];
  tm.forcePopup(1);
  await until(() => d1.state === 'up');
  await sightAim(d1.board.localToWorld(V(0, 1.1, 0.02)));
  r = await fire();
  check('sights on the heart at 11 m: bullseye', r?.zone === 'heart', r ? `${r.zone} ${r.precision.toFixed(3)}` : 'miss');

  // The bore-aimed point and the sight-aimed point differ: at 15 m the sight
  // line meets the bullet, so the sights (not the bore) are what's zeroed.
  return out;
};
