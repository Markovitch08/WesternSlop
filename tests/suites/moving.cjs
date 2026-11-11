/**
 * Moving targets suite: the running outlaw (runs back and forth on his rail,
 * scores by zone with a moving bonus through a real shot, falls and gets back
 * up, sits out the game modes); the bottle toss (TOSS plate flings a bottle,
 * an air shot scores, a landed bottle smashes for nothing); the swinging WANTED
 * sign (sways in the wind, scores by precision, swings harder when hit).
 * Runs inside the page.
 */
module.exports = async function movingSuite() {
  const g = window.__game;
  const { THREE, targets: tm, revolver: rev, xr, holster, sfx } = g;
  const { runner, bottleToss: toss, sign } = tm;
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
  const rgp = fake(R, 'right');
  fake(xr.hands[1], 'left');
  pose(xr.hands[1], V(-0.6, 1.0, 0.4));
  let lastReport = null;
  tm.addEventListener('hit', (e) => { lastReport = e.report; });
  /** A synthetic hit (point on a target mesh), through the normal shot routing. */
  const shoot = (object, point, dir = V(0, 0, -1)) => {
    lastReport = null;
    return tm.handleShot({ origin: V(0, 1.5, 0), direction: dir, hit: { point, object, face: { normal: V(0, 0, 1) } } });
  };
  await frames(3);

  // --- Running outlaw -------------------------------------------------------------------
  check('runner on his rail at home', runner.visible && runner.object.visible && tm.colliders.includes(runner.board));
  const x0 = runner.x;
  await frames(20);
  check('he runs along the rail', Math.abs(runner.x - x0) > 0.2 && Math.abs(runner.x) <= runner.halfLength + 1e-6, `${x0.toFixed(2)} -> ${runner.x.toFixed(2)}`);
  runner.x = runner.halfLength - 0.05;
  runner.dir = 1;
  await frames(4);
  check('he turns around at the end', runner.dir === -1 && Math.abs(runner.x) <= runner.halfLength + 1e-6);

  // A real shot at his heart (frozen for the aim).
  runner.speed = 0;
  pose(R, holster.object.getWorldPosition(V(0, 0, 0)));
  await frames(2);
  xr.dispatchEvent({ type: 'squeezestart', hand: R });
  await frames(10);
  for (const k of Object.keys(rev.recoil)) rev.recoil[k] = 0;
  const GUN = V(0.3, 1.5, 0.2);
  const heart = runner.board.localToWorld(V(0, 1.1, 0.02));
  pose(R, GUN, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(GUN.clone().add(V(0, 0.06, 0)), heart, V(0, 1, 0))));
  await frames(3);
  rgp.buttons[0].value = 1; rgp.buttons[0].pressed = true; await frames(2);
  rgp.buttons[0].value = 0; rgp.buttons[0].pressed = false; await frames(2);
  const r1 = lastReport;
  check('shooting the runner scores by zone', r1?.type === 'runner' && r1.zone === 'heart' && r1.label.startsWith('RUNNER'), JSON.stringify(r1));
  const still = Math.round(70 * (1 + r1.distance / 15)); // what a standing chest ring would give, for scale
  check('with a moving-target bonus', r1 && r1.points > Math.round(100 * (1 + r1.distance / 15)), `${r1?.points} (standing heart ${Math.round(100 * (1 + r1.distance / 15))}, chest ${still})`);
  check('he goes down when hit', await until(() => runner.state === 'down', 120) && !tm.colliders.includes(runner.board));
  check('and gets back up', await until(() => runner.state === 'up', 300));
  runner.speed = 1.8;

  // Sits out the game modes.
  tm.setDuelistsActive(true);
  check('hidden during duels and pop-ups', !runner.visible && !runner.object.visible && !tm.colliders.includes(runner.board));
  tm.setDuelistsActive(false);
  check('back at home', runner.visible && runner.object.visible);

  // --- Bottle toss ----------------------------------------------------------------------
  check('no bottles in the air yet', toss.inFlight === 0);
  shoot(tm.tossPlate.plate, tm.tossPlate.plate.getWorldPosition(V(0, 0, 0)));
  check('shooting the TOSS plate flings a bottle', lastReport?.type === 'toss' && lastReport.launched && toss.inFlight === 1);
  const flying = toss.bottles.find((b) => b.active);
  const y0 = flying.mesh.position.y;
  await frames(6);
  check('it flies up', flying.mesh.position.y > y0 + 0.3, `${y0.toFixed(2)} -> ${flying.mesh.position.y.toFixed(2)}`);
  check('mid-air bottles are shootable', tm.colliders.includes(flying.collider));
  const glass = played('glass');
  shoot(flying.collider, flying.mesh.getWorldPosition(V(0, 0, 0)));
  check('an air shot scores', lastReport?.type === 'tossBottle' && lastReport.label === 'AIR SHOT' && lastReport.points > 60, JSON.stringify(lastReport));
  check('and smashes it', !flying.active && played('glass') === glass + 1 && !tm.colliders.includes(flying.collider));

  const pts = tm.stats.points;
  shoot(tm.tossPlate.plate, tm.tossPlate.plate.getWorldPosition(V(0, 0, 0)));
  const lander = toss.bottles.find((b) => b.active);
  const glass2 = played('glass');
  check('a bottle left alone falls and smashes on the ground', await until(() => !lander.active, 300) && played('glass') === glass2 + 1);
  check('a landed bottle scores nothing', tm.stats.points === pts);

  // --- Swinging sign --------------------------------------------------------------------
  const s0 = sign.swing;
  const w0 = sign.sway;
  await frames(30);
  check('the sign sways in the wind', Math.abs(sign.swing - s0) + Math.abs(sign.sway - w0) > 0.001, `${(sign.swing - s0).toFixed(4)} ${(sign.sway - w0).toFixed(4)}`);
  const bull = sign.board.localToWorld(V(sign.bull.x, sign.bull.y, 0.02));
  const vel0 = Math.abs(sign.swingVel);
  shoot(sign.board, bull, bull.clone().sub(V(0, 1.5, 0)).normalize());
  check('a bullseye on the sign scores high', lastReport?.type === 'sign' && lastReport.zone === 'bull' && lastReport.precision > 0.9, JSON.stringify(lastReport));
  check('and knocks it swinging', Math.abs(sign.swingVel) > vel0 + 0.5, `${vel0.toFixed(2)} -> ${Math.abs(sign.swingVel).toFixed(2)}`);
  const edge = sign.board.localToWorld(V(0.3, sign.bull.y, 0.02));
  shoot(sign.board, edge, edge.clone().sub(V(0, 1.5, 0)).normalize());
  check('an edge hit scores less', lastReport?.type === 'sign' && lastReport.zone === 'board' && lastReport.precision < 0.4, JSON.stringify(lastReport));
  check('draw calls within budget', g.renderer.info.render.calls < 120, g.renderer.info.render.calls);
  return out;
};
