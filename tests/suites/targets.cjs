/**
 * Targets suite: environment colliders, gong / duelist / bottle hits through
 * the real revolver, zone scoring, duel timeouts and scheduling, bottle
 * respawn, surface impacts, the scoreboard, the reset plate and the draw-call
 * budget. Runs inside the page.
 */
module.exports = async function targetsSuite() {
  const g = window.__game;
  const { THREE, targets: tm, revolver: rev, xr, holster, sfx, environment: env } = g;
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

  // --- Fake controllers ------------------------------------------------------
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
  const pose = (hand, pos, quat) => {
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
  pose(L, new THREE.Vector3(-0.6, 1.0, 0.4), new THREE.Quaternion());
  await frames(3);

  const hp = holster.object.getWorldPosition(new THREE.Vector3());
  pose(R, hp, new THREE.Quaternion());
  await frames(2);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(12);
  check('gun drawn for target tests', rev.isHeld);

  // Aim the bore at a world point from a fixed spot on the firing line.
  const GUN = new THREE.Vector3(0.3, 1.5, 0.2);
  const BORE_OFFSET = new THREE.Vector3(0, 0.06, 0);
  const aimAt = async (point) => {
    // Settle any recoil from the previous shot so the bore is where we aim.
    for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
    const m = new THREE.Matrix4().lookAt(GUN.clone().add(BORE_OFFSET), point, new THREE.Vector3(0, 1, 0));
    pose(R, GUN, new THREE.Quaternion().setFromRotationMatrix(m));
    await frames(2);
  };
  /** First collider along the bore line, exactly as the revolver will see it. */
  const lineOfFire = () => {
    rev.muzzle.updateWorldMatrix(true, false);
    const o = new THREE.Vector3().setFromMatrixPosition(rev.muzzle.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(rev.muzzle.matrixWorld);
    const rc = new THREE.Raycaster(o, d, 0, 200);
    return rc.intersectObjects([...env.colliders, ...tm.colliders], true)[0]?.object ?? null;
  };
  let lastReport = null;
  let lastShot = null;
  tm.addEventListener('hit', (e) => { lastReport = e.report; });
  rev.addEventListener('shot', (e) => { lastShot = e; });
  const fire = async () => {
    rev.chambers.fill('live');
    for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
    lastReport = null;
    lastShot = null;
    rgp.buttons[4].pressed = true; await frames(2);
    rgp.buttons[4].pressed = false; await frames(2);
    rgp.buttons[0].value = 0.6; rgp.buttons[0].pressed = true; await frames(2);
    rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(3);
    return lastReport;
  };

  // --- Environment ---------------------------------------------------------------
  const surfaces = new Set(env.colliders.map((c) => c.userData.surface));
  check('environment colliders tagged (sand/wood/plant)', ['sand', 'wood', 'plant'].every((s) => surfaces.has(s)), [...surfaces]);
  check('saloon is solid wood', env.colliders.some((c) => c.parent?.name === 'saloon' && c.userData.surface === 'wood'));
  const dustPos = env.dust.points.geometry.attributes.position;
  const x0 = dustPos.getX(0);
  await frames(5);
  check('dust drifts', dustPos.getX(0) !== x0);

  const cols = tm.colliders;
  check('colliders include every target type',
    cols.some((c) => c.name === 'duelistBoard') && cols.some((c) => c.name === 'gongPlate') &&
    cols.some((c) => c.name === 'bottleCollider') && cols.some((c) => c.name === 'resetPlate'));

  // --- Steel gong ------------------------------------------------------------------
  const gong = tm.gongs[0];
  await aimAt(gong.plate.getWorldPosition(new THREE.Vector3()));
  check('clear line to gong', lineOfFire() === gong.plate, lineOfFire()?.name);
  const steelBefore = played('steel');
  let r = await fire();
  check('gong centre hit scores', r?.type === 'gong' && r.zone === 'center' && r.points > 0, JSON.stringify(r));
  check('gong reports distance', r && Math.abs(r.distance - gong.plate.getWorldPosition(new THREE.Vector3()).distanceTo(GUN)) < 0.5, r?.distance);
  check('gong rings', played('steel') === steelBefore + 1);
  await frames(4);
  check('gong swings', Math.abs(gong.swing) > 0.005 || Math.abs(gong.swingVel) > 0.05, `${gong.swing} ${gong.swingVel}`);
  let splash = null;
  gong.plate.traverse((o) => { if (o.name === 'bulletHole' && o.visible) splash = o; });
  check('lead splash rides on the plate', splash && splash.material.color.getHex() === 0x9a9a98);

  // Edge hit is worth less than a centre hit.
  const centerPoints = r.points;
  const edge = gong.plate.localToWorld(new THREE.Vector3(gong.radius * 0.85, 0, 0));
  gong.swing = gong.swingVel = gong.twist = gong.twistVel = 0;
  await frames(2);
  await aimAt(edge);
  r = await fire();
  check('gong edge hit scores less', r?.type === 'gong' && r.zone === 'edge' && r.points < centerPoints, JSON.stringify(r));

  // --- Duelists ----------------------------------------------------------------------
  const d1 = tm.duelists[1];
  check('duelist starts down', d1.state === 'down' && d1.onHit({ point: new THREE.Vector3() }, {}, 0) === null);
  check('forced pop-up', tm.forcePopup(1));
  await until(() => d1.state === 'up');
  await aimAt(d1.headPosition());
  check('clear line to duelist head', lineOfFire() === d1.board, lineOfFire()?.name);
  r = await fire();
  check('headshot zone', r?.type === 'duelist' && r.zone === 'head' && r.label === 'HEADSHOT', JSON.stringify(r));
  check('reaction time measured', r && r.reaction > 0 && r.reaction < 30, r?.reaction);
  check('stats: headshot and duel won', tm.stats.headshots === 1 && tm.stats.duelsWon === 1);
  check('floating score text shown', g.scene.children.some((o) => o.name === 'floatingText' && o.visible));
  await until(() => d1.state === 'down', 300);
  check('hit duelist falls flat', d1.state === 'down' && d1.angle < -1.3, d1.angle);

  const d2 = tm.duelists[2];
  tm.forcePopup(2);
  await until(() => d2.state === 'up');
  await aimAt(d2.board.localToWorld(new THREE.Vector3(0, 1.1, 0.02)));
  r = await fire();
  check('heart ring is a bullseye', r?.zone === 'heart' && r.label === 'BULLSEYE', JSON.stringify(r));
  await until(() => d2.state === 'down', 300);

  // Reaction bonus: a faster hit on the same zone scores more.
  check('reaction bonus is capped at +100', r && r.points <= Math.round(100 * (1 + r.distance / 15)) + 100);

  // Timeout: nobody shoots.
  const missed = tm.stats.duelsMissed;
  tm.forcePopup(0);
  check('duel timeout counted', await until(() => tm.stats.duelsMissed === missed + 1, 1500), tm.stats.duelsMissed);
  check('duel slot freed after timeout', tm.duel.phase === 'wait');
  await until(() => tm.duelists[0].state === 'down', 300);

  // Scheduler: with duels enabled and the timer expired, one duelist pops with a bell.
  const bells = played('bell');
  tm.duelEnabled = true;
  tm.duel.timer = 0;
  await frames(3);
  const live = tm.duelists.filter((d) => d.isLive);
  check('scheduler pops one duelist with a bell', live.length === 1 && played('bell') === bells + 1, live.length);
  tm.duelEnabled = false;
  await until(() => tm.duelists.every((d) => d.state === 'down'), 1500);

  // --- Bottles ---------------------------------------------------------------------
  const group = tm.bottleGroups[0];
  const bottle = group.bottles[2];
  const bottleCenter = bottle.mesh.localToWorld(new THREE.Vector3(0, 0.14, 0));
  await aimAt(bottleCenter);
  check('clear line to bottle', lineOfFire() === bottle.collider, lineOfFire()?.name);
  const glass = played('glass');
  r = await fire();
  check('bottle shatters', r?.type === 'bottle' && bottle.broken && !bottle.mesh.visible, JSON.stringify(r));
  check('glass sound', played('glass') === glass + 1);
  check('shards flying', tm.shards.activeCount > 0, tm.shards.activeCount);
  check('broken bottle leaves the collider list', !tm.colliders.includes(bottle.collider));
  r = await fire();
  check('second shot passes through the gap', r === null && played('glass') === glass + 1, JSON.stringify(r));

  const far = tm.bottleGroups[1];
  far.bottles.forEach((_, i) => far.shatter(i));
  check('far bottles all broken', far.remaining === 0);
  check('bottles respawn after a delay', await until(() => far.remaining === 3, 900), far.remaining);

  // --- Surfaces -------------------------------------------------------------------
  const sand = played('sand');
  await aimAt(new THREE.Vector3(0.3, 0, -4));
  r = await fire();
  check('ground hit: no score, sand sound', r === null && lastShot?.hit?.object.name === 'ground' && played('sand') === sand + 1,
    lastShot?.hit?.object.name);

  // --- Scoreboard & accuracy -------------------------------------------------------
  const s = tm.stats;
  check('every shot counted', s.shots === 7, s.shots);
  check('hits counted', s.hits === 5, s.hits);
  check('scoreboard redrawn', tm.scoreboard.redraws > 1, tm.scoreboard.redraws);

  // --- Reset plate -----------------------------------------------------------------
  await aimAt(tm.resetPlate.plate.getWorldPosition(new THREE.Vector3()));
  check('clear line to reset plate', lineOfFire() === tm.resetPlate.plate, lineOfFire()?.name);
  r = await fire();
  check('reset plate clears stats', r?.type === 'reset' && tm.stats.points === 0 && tm.stats.shots === 0, JSON.stringify(tm.stats));

  // --- Performance budget ----------------------------------------------------------
  g.camera.position.set(0, 1.6, 0.5);
  g.camera.lookAt(0, 1.3, -10);
  await frames(2);
  const calls = g.renderer.info.render.calls;
  check('draw calls within Quest budget (< 120 incl. shadow pass)', calls > 0 && calls < 120, calls);
  return out;
};
