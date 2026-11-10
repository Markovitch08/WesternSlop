/**
 * Atmosphere & audio suite: golden-hour light, exponential fog and sky,
 * dust riding the wind around the player, tumbleweeds (wind, raycast ground
 * contact, rolling, respawn, bullet knock), flickering swinging lanterns, and
 * the spatial audio environment (unlock on a trigger press, listener on the
 * camera, ambient layers, creaks, terrain echo emitters, positional gunshot,
 * exponential gong decay, brass on dirt vs wood). Runs inside the page.
 */
module.exports = async function atmosphereSuite() {
  const g = window.__game;
  const { THREE, atmosphere: atm, audio, sfx, xr, fx, casings, targets: tm } = g;
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
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  // --- Light, fog, sky ------------------------------------------------------------
  const fog = g.scene.fog;
  check('exponential dust-haze fog', fog?.isFogExp2 && fog.color.getHex() === 0xc29b6c && near(fog.density, 0.015, 1e-9),
    `${fog?.type} ${fog?.color?.getHexString()} ${fog?.density}`);
  const sunHex = atm.sun.color.getHex();
  check('golden-hour sun', near(atm.sun.intensity, 2.5, 1e-6) && atm.sun.castShadow &&
    Math.abs(((sunHex >> 16) & 255) - 0xff) + Math.abs(((sunHex >> 8) & 255) - 0xb5) + Math.abs((sunHex & 255) - 0x6b) < 12,
    `#${atm.sun.color.getHexString()} ${atm.sun.intensity}`);
  check('soft shadow maps', g.renderer.shadowMap.type === THREE.PCFSoftShadowMap);
  check('cool ambient fill', atm.ambient.isAmbientLight && atm.ambient.color.getHex() === 0x332244);
  check('low golden-hour sun angle', atm.sunDir.y > 0.2 && atm.sunDir.y < 0.5, atm.sunDir.y.toFixed(2));
  const skyCol = atm.sky.geometry.attributes.color;
  const skyPos = atm.sky.geometry.attributes.position;
  let horizonIdx = -1;
  for (let i = 0; i < skyPos.count; i++) if (skyPos.getY(i) <= 0) { horizonIdx = i; break; }
  const hc = new THREE.Color(skyCol.getX(horizonIdx), skyCol.getY(horizonIdx), skyCol.getZ(horizonIdx));
  check('sky horizon melts into the fog colour', hc.getHex() === fog.color.getHex(), hc.getHexString());

  // --- Wind & dust ------------------------------------------------------------------
  check('one shared wind vector (smoke uses it too)', fx.wind === atm.wind.vector);
  const gusts = new Set();
  for (let i = 0; i < 20; i++) { gusts.add(atm.wind.gust.toFixed(3)); await frames(2); }
  check('wind gusts vary over time', gusts.size > 3, gusts.size);

  const dust = atm.dust;
  check('500-1000 dust particles in one Points', dust.points.isPoints && dust.count >= 500 && dust.count <= 1000, dust.count);
  const pos = dust.positions;
  const snap = () => Float32Array.from(pos);
  const a0 = snap();
  const windAvg = V(0, 0, 0);
  for (let i = 0; i < 30; i++) { windAvg.add(atm.wind.vector); await frames(1); }
  const a1 = snap();
  let dx = 0, dy = 0, dz = 0, n = 0;
  for (let i = 0; i < dust.count; i++) {
    const ddx = a1[i * 3] - a0[i * 3], ddy = a1[i * 3 + 1] - a0[i * 3 + 1], ddz = a1[i * 3 + 2] - a0[i * 3 + 2];
    if (Math.abs(ddx) > 5 || Math.abs(ddz) > 5 || Math.abs(ddy) > 2) continue; // wrapped
    dx += ddx; dy += ddy; dz += ddz; n++;
  }
  const drift = V(dx / n, dy / n, dz / n);
  check('dust drifts downwind', drift.x * windAvg.x + drift.z * windAvg.z > 0, `drift ${drift.toArray().map((v) => v.toFixed(3))}`);
  check('dust has a slight vertical drift', Math.abs(drift.y) < Math.hypot(drift.x, drift.z), drift.y.toFixed(4));
  g.camera.position.x += 25;
  await frames(4);
  const cx = g.camera.getWorldPosition(V(0, 0, 0)).x;
  let outside = 0;
  for (let i = 0; i < dust.count; i++) if (Math.abs(pos[i * 3] - cx) > 14.5) outside++;
  check('dust cloud stays around the player', outside === 0, `${outside} outside`);
  g.camera.position.x -= 25;
  await frames(2);

  // --- Tumbleweeds ------------------------------------------------------------------
  const tws = atm.tumbleweeds;
  check('1-2 tumbleweeds', tws.length >= 1 && tws.length <= 2, tws.length);
  const tw = tws[0];
  tw.group.position.set(-5, 0.32, -10);
  tw.vel.set(0, 0, 0);
  const p0 = tw.group.position.clone();
  const q0 = tw.spin.quaternion.clone();
  const w0 = atm.wind.vector.clone();
  let minY = Infinity;
  for (let i = 0; i < 60; i++) { await frames(1); minY = Math.min(minY, tw.group.position.y); }
  const moved = tw.group.position.clone().sub(p0);
  check('tumbleweed is blown downwind', moved.x * w0.x + moved.z * w0.z > 0.5, moved.toArray().map((v) => v.toFixed(2)));
  check('tumbleweed rolls as it goes', tw.spin.quaternion.angleTo(q0) > 0.5, tw.spin.quaternion.angleTo(q0).toFixed(2));
  check('tumbleweed rides on the ground (never sinks below it)', minY >= 0.32 - 1e-3, minY.toFixed(3));
  check('ground raycast: sand', near(atm.groundHeight(V(5, 0, 5)), 0, 1e-3));
  check('ground raycast: lands on the bench top', near(atm.groundHeight(V(0, 0, -0.8)), 0.9, 0.01), atm.groundHeight(V(0, 0, -0.8)).toFixed(3));
  tw.group.position.set(60, 0.32, -10);
  await frames(2);
  check('tumbleweed that blows away respawns upwind', tw.group.position.x < 0, tw.group.position.x.toFixed(1));
  const v0 = tw.vel.clone();
  tm.handleShot({ origin: V(0, 1.5, 0), direction: V(0, 0, -1), hit: { point: tw.group.position.clone(), object: tw.ball, face: null } });
  check('a bullet knocks it along and up', tw.vel.y > v0.y + 1 && tw.vel.z < v0.z, tw.vel.toArray().map((v) => v.toFixed(2)));
  check('tumbleweeds are shootable', g.revolver.getColliders().includes(tw.ball));

  // --- Lanterns ---------------------------------------------------------------------
  const ls = atm.lanterns;
  check('hanging lanterns with point lights', ls.length >= 1 && ls.every((l) => l.light.isPointLight), ls.length);
  check('a lantern casts (cheap) shadows', ls.some((l) => l.light.castShadow && l.light.shadow.mapSize.x <= 512 && l.light.shadow.camera.far <= 6));
  let lo = Infinity, hi = -Infinity;
  const r0 = ls[0].pivot.rotation.clone();
  for (let i = 0; i < 30; i++) { await frames(1); lo = Math.min(lo, ls[0].light.intensity); hi = Math.max(hi, ls[0].light.intensity); }
  check('lantern flickers', hi - lo > 0.15, `${lo.toFixed(2)}..${hi.toFixed(2)}`);
  check('lantern swings in the wind (moving light and shadows)', ls[0].pivot.rotation.x !== r0.x || ls[0].pivot.rotation.z !== r0.z);
  check('draw calls still within budget', g.renderer.info.render.calls < 120, g.renderer.info.render.calls);

  // --- Audio ------------------------------------------------------------------------
  check('no audio before any interaction', !audio.unlocked && sfx.ctx === null);
  const R = xr.hands[0];
  xr.dispatchEvent({ type: 'selectstart', hand: R }); // a trigger press
  check('a trigger press resumes the AudioContext', await until(() => audio.unlocked, 120) && audio.ctx.state === 'running', audio.ctx?.state);
  check('THREE.AudioListener rides on the camera (headset)', audio.listener instanceof THREE.AudioListener && audio.listener.parent === g.camera);
  check('effects play into the listener', sfx.ctx === audio.ctx && sfx.echoSend === audio.echoInput);
  check('ambient bed playing: wind, whistle, crickets', ['wind', 'whistle', 'crickets'].every((k) => audio.layers[k]?.isPlaying),
    Object.keys(audio.layers).join(','));
  check('ambient layers are non-positional', Object.values(audio.layers).every((l) => !l.panner));
  await frames(10);
  const wf = audio.windFilter.frequency.value;
  check('wind sound follows the gusts', wf >= 270 && wf <= 940, wf.toFixed(0));
  const creaks = audio.creaks ?? 0;
  audio.creakTimer = 0;
  await frames(2);
  check('saloon board creaks', (audio.creaks ?? 0) === creaks + 1);

  // Echo emitters at the reflectors, tuned to the round trip from the head.
  const head = g.camera.getWorldPosition(V(0, 0, 0));
  check('one positional echo emitter per reflector', audio.echoes.length === g.environment.reflectors.length &&
    audio.echoes.every((e) => e.emitter instanceof THREE.PositionalAudio && e.emitter.position.equals(e.reflector.position)), audio.echoes.length);
  await frames(20);
  const saloon = audio.echoes.find((e) => e.reflector.name === 'saloon');
  const expect = (2 * head.distanceTo(saloon.reflector.position)) / 343;
  check('saloon echo arrives after the round trip', near(saloon.delay.delayTime.value, expect, expect * 0.05),
    `${saloon.delay.delayTime.value.toFixed(3)} s vs ${expect.toFixed(3)} s`);
  check('far echoes are darker and quieter', audio.echoes.filter((e) => e.reflector.name === 'mesa').every((e) =>
    e.lp.frequency.value < saloon.lp.frequency.value && e.gain.gain.value < saloon.gain.gain.value));
  check('echoes kept faint (no reverb wash)', audio.echoMaster.gain.value <= 0.4 && saloon.gain.gain.value < 0.2,
    `${audio.echoMaster.gain.value} ${saloon.gain.gain.value.toFixed(3)}`);

  // Positional effects.
  const muzzle = V(0.25, 1.3, -0.4);
  sfx.gunshot(muzzle);
  check('gunshot snap sounds from the muzzle', near(sfx.lastPanner.positionX.value, muzzle.x, 1e-6) && near(sfx.lastPanner.positionZ.value, muzzle.z, 1e-6));
  sfx.steelPing(V(-5.5, 1.4, -13), 0.25);
  check('gongs ring with exponential distance decay', sfx.lastPanner.distanceModel === 'exponential');

  // Brass: one case onto the sand, one onto the bench's floorboards.
  const sand0 = sfx.played['brass:sand'] ?? 0;
  const wood0 = sfx.played['brass:wood'] ?? 0;
  const q = new THREE.Quaternion();
  casings.eject(V(2, 0.5, 2), q, V(0, -1, 0));
  casings.eject(V(0.3, 1.3, -0.8), q, V(0, -1, 0));
  check('brass on dirt', await until(() => (sfx.played['brass:sand'] ?? 0) > sand0, 200));
  check('brass on wood (a different sound)', await until(() => (sfx.played['brass:wood'] ?? 0) > wood0, 200));
  return out;
};
