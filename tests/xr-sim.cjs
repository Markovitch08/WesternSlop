/**
 * Headless simulation test for the revolver. Starts a Vite dev server, loads
 * the game in Chromium, injects fake XR controllers (gamepad state + grip /
 * target-ray poses) and drives grab, cock, fire, double action, dry fire,
 * fanning, hand-to-hand transfer and holster return.
 *
 * Run: npm test   (needs the `playwright` package and a Chromium build)
 */
const { chromium } = require('playwright');

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: __dirname + '/..',
    logLevel: 'error',
    server: { port: 5199, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  let failures = 0;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__game);

    const results = await page.evaluate(async () => {
      const THREE_Q = (x) => {
        const s = Math.sin(x / 2), c = Math.cos(x / 2);
        return { x: s, y: 0, z: 0, w: c }; // rotation about X
      };
      const g = window.__game;
      const { revolver: rev, xr, holster } = g;
      const out = [];
      const check = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: String(detail) });
      const frames = (n) => new Promise((res) => {
        let i = 0;
        const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });

      // Per-frame sampler: transient effects (flash, recoil peak) can be shorter
      // than a slow headless frame, so record their peaks every frame.
      const peak = { recoil: 0, flash: false };
      const sample = () => {
        peak.recoil = Math.max(peak.recoil, rev.recoilPivot.rotation.x);
        peak.flash = peak.flash || rev.flash.visible;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      rev.addEventListener('shot', () => { peak.flash = rev.flash.visible; peak.recoil = 0; });

      const events = [];
      for (const t of ['shot', 'dryfire', 'cock', 'grab', 'release', 'holstered']) {
        rev.addEventListener(t, (e) => events.push({ type: t, chamber: e.chamber, hit: e.hit?.object?.name }));
      }
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
      const pose = (hand, x, y, z, pitch = 0) => {
        const q = THREE_Q(pitch);
        for (const o of [hand.grip, hand.controller]) {
          o.position.set(x, y, z);
          o.quaternion.set(q.x, q.y, q.z, q.w);
          o.matrix.compose(o.position, o.quaternion, o.scale);
          o.matrixWorldNeedsUpdate = true;
        }
      };
      const setTrigger = (gp, v) => { gp.buttons[0].value = v; gp.buttons[0].pressed = v > 0.05; };
      const lastOf = (type) => [...events].reverse().find((e) => e.type === type);

      const R = xr.hands[0], L = xr.hands[1];
      const rgp = fake(R, 'right');
      const lgp = fake(L, 'left');
      pose(L, -0.5, 1.0, 0.3);
      await frames(5);

      // --- Grab from holster -------------------------------------------------
      check('starts holstered', rev.state === 'holstered' && rev.object.parent === holster.socket, rev.state);
      pose(R, 3, 1, 3);
      await frames(2);
      xr.dispatchEvent({ type: 'squeezestart', hand: R });
      check('no grab when hand is far from holster', rev.state === 'holstered', rev.state);

      const hp = holster.object.getWorldPosition(holster.object.position.clone());
      pose(R, hp.x, hp.y, hp.z);
      await frames(2);
      xr.dispatchEvent({ type: 'squeezestart', hand: R });
      await frames(10);
      check('grab from holster', rev.state === 'held' && rev.object.parent === R.grip && R.held === rev, rev.state);
      check('grab haptic', pulses.some((p) => p.handedness === 'right' && p.i === 0.3));
      check('controller model hidden while holding', R.model.visible === false);

      // Aim down at the ground ~4 m ahead.
      pose(R, 0, 1.2, 0, -0.3);
      await frames(5);

      // --- Single action: cock with A, light pull fires ----------------------
      rgp.buttons[4].pressed = true; await frames(2); rgp.buttons[4].pressed = false; await frames(6);
      check('A button cocks hammer', rev.cocked && rev.chamberIndex === 0, `cocked=${rev.cocked} idx=${rev.chamberIndex}`);
      check('hammer drawn back', rev.hammer.rotation.x > 0.5, rev.hammer.rotation.x.toFixed(3));
      check('cock haptic', pulses.some((p) => p.i === 0.25));

      setTrigger(rgp, 0.6); await frames(2);
      const sa = lastOf('shot');
      check('cocked + light pull fires chamber 0', sa && sa.chamber === 0 && rev.chambers[0] === 'spent', JSON.stringify(sa));
      check('shot raycast hits ground', sa?.hit === 'ground', sa?.hit);
      check('fire haptic is strong', pulses.some((p) => p.i === 1.0 && p.d >= 80));
      check('bullet hole decal spawned', g.scene.children.some((c) => c.name === 'bulletHole' && c.visible));
      check('muzzle flash visible', peak.flash);
      await frames(3);
      check('recoil kicks muzzle up', peak.recoil > 0.05, peak.recoil.toFixed(3));
      check('hammer down after shot', !rev.cocked);

      // Holding the trigger does not fire again.
      const shotsBefore = events.filter((e) => e.type === 'shot').length;
      await frames(10);
      check('no auto-fire while trigger held', events.filter((e) => e.type === 'shot').length === shotsBefore);
      setTrigger(rgp, 0); await frames(40);
      check('recoil settles', Math.abs(rev.recoilPivot.rotation.x) < 0.01, rev.recoilPivot.rotation.x.toFixed(4));
      check('flash gone', !rev.flash.visible);

      // --- Double action -----------------------------------------------------
      setTrigger(rgp, 0.6); await frames(6);
      check('half pull uncocked does not fire', events.filter((e) => e.type === 'shot').length === shotsBefore);
      check('hammer rises with DA pull', rev.hammer.rotation.x > 0.1, rev.hammer.rotation.x.toFixed(3));
      setTrigger(rgp, 1.0); await frames(2);
      const da = lastOf('shot');
      check('full DA pull fires chamber 1', da && da.chamber === 1, JSON.stringify(da));
      setTrigger(rgp, 0); await frames(3);

      // --- Thumbstick cock ----------------------------------------------------
      rgp.axes[3] = 0.9; await frames(2); rgp.axes[3] = 0; await frames(2);
      check('thumbstick pull-back cocks', rev.cocked && rev.chamberIndex === 2, `idx=${rev.chamberIndex}`);
      setTrigger(rgp, 0.6); await frames(2); setTrigger(rgp, 0); await frames(3);

      // --- Empty the gun, then dry fire ---------------------------------------
      for (let i = 0; i < 3; i++) { setTrigger(rgp, 1); await frames(2); setTrigger(rgp, 0); await frames(3); }
      check('six shots fired', events.filter((e) => e.type === 'shot').length === 6 && rev.chambers.every((c) => c === 'spent'),
        rev.chambers.join(','));
      setTrigger(rgp, 1); await frames(2); setTrigger(rgp, 0); await frames(3);
      check('7th pull dry-fires', lastOf('dryfire') && events.filter((e) => e.type === 'shot').length === 6);

      // --- Fanning ------------------------------------------------------------
      rev.chambers.fill('live');
      // Trigger held past the single-action break but short of double action:
      // nothing fires until the hammer is slapped.
      setTrigger(rgp, 0.8); await frames(2);
      const shotsBeforeFan = events.filter((e) => e.type === 'shot').length;
      rev.hammerSpur.updateWorldMatrix(true, false);
      const spur = rev.hammerSpur.getWorldPosition(rev.hammerSpur.position.clone());
      pose(L, spur.x, spur.y, spur.z + 0.08); await frames(2);
      pose(L, spur.x, spur.y, spur.z); await frames(2);
      check('fanning with trigger held fires', events.filter((e) => e.type === 'shot').length === shotsBeforeFan + 1,
        `${events.filter((e) => e.type === 'shot').length} vs ${shotsBeforeFan}`);
      check('fanning hand gets haptic', pulses.some((p) => p.handedness === 'left' && p.i === 0.35));
      setTrigger(rgp, 0);
      pose(L, -0.5, 1.0, 0.3); await frames(15);

      // Slow movement near the hammer does not fan.
      const cockCount = events.filter((e) => e.type === 'cock').length;
      pose(L, spur.x, spur.y, spur.z + 0.3); await frames(4); // outside fan radius
      for (let i = 0; i < 60; i++) { pose(L, spur.x, spur.y, spur.z + 0.3 - i * 0.005); await frames(1); }
      check('slow hand near hammer does not fan', events.filter((e) => e.type === 'cock').length === cockCount);
      pose(L, -0.5, 1.0, 0.3); await frames(3);

      // --- Hand-to-hand transfer ------------------------------------------------
      rev.object.updateWorldMatrix(true, false);
      const gp = rev.object.getWorldPosition(rev.object.position.clone());
      pose(L, gp.x + 0.05, gp.y, gp.z); await frames(2);
      xr.dispatchEvent({ type: 'squeezestart', hand: L });
      await frames(8);
      check('other hand takes the gun', rev.object.parent === L.grip && L.held === rev && R.held === null);
      check('right controller model visible again', R.model.visible === true);
      xr.dispatchEvent({ type: 'squeezeend', hand: R });
      check('releasing the old hand does not drop it', rev.state === 'held');

      // --- Release -> holster -----------------------------------------------------
      rev.chambers.fill('spent');
      xr.dispatchEvent({ type: 'squeezeend', hand: L });
      check('release starts return', rev.state === 'returning' && L.held === null);
      await frames(30);
      check('returns to holster', rev.state === 'holstered' && rev.object.parent === holster.socket);
      check('holster refills cylinder', rev.chambers.every((c) => c === 'live'));
      check('snapped into socket', rev.object.position.length() < 1e-3);
      return out;
    });

    for (const r of results) {
      if (!r.ok) failures++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.detail})`}`);
    }
    if (pageErrors.length) {
      failures++;
      console.log('FAIL  page errors:\n  ' + pageErrors.join('\n  '));
    }
    console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
