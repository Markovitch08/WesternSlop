/**
 * Audio soak suite: the effects graph must not grow while you play.
 *
 *  - Offline: render ten gunshots a second apart and check the tenth is as
 *    loud as the first. (A shared node that gains an output chain per shot
 *    makes every later shot play through all earlier chains: louder and
 *    more expensive each time, until the audio thread underruns.)
 *  - Live: fire a burst of sounds on the running context and check every
 *    per-sound chain is disconnected once its sound is over.
 *  - The static echo emitters don't re-send their position every frame.
 * Runs inside the page.
 */
module.exports = async function audioSuite() {
  const g = window.__game;
  const { THREE, sfx, audio, xr } = g;
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
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // --- Offline: the 10th gunshot is no louder than the 1st -------------------------
  const { SoundFX } = await import('/src/audio/SoundFX.js');
  const SR = 22050;
  const N = 10;
  const GAP = 2; // seconds between shots, longer than a shot's tail
  const off = new OfflineAudioContext(2, SR * GAP * N + SR, SR);
  const fx = new SoundFX();
  fx.attach(off, off.destination, null);
  // Measure the effects graph itself: bypass the master compressor, whose
  // start-up state makes the very first sound quieter in Chrome.
  fx.master.disconnect();
  fx.master.connect(off.destination);
  for (let i = 0; i < N; i++) {
    off.suspend(i * GAP + 0.01).then(() => { fx.gunshot(V(0.2, 1.3, -0.4)); off.resume(); });
  }
  const buf = await off.startRendering();
  const L = buf.getChannelData(0);
  const energy = (k) => { let e = 0; for (let i = k * GAP * SR; i < (k + 1) * GAP * SR; i++) e += L[i] * L[i]; return e; };
  const es = Array.from({ length: N }, (_, k) => energy(k));
  const ratio = es[N - 1] / es[0];
  check('the 10th gunshot is as loud as the 1st (no growing graph)', ratio > 0.6 && ratio < 1.6,
    `last/first energy ${ratio.toFixed(2)} (${es.map((e) => e.toFixed(0)).join(',')})`);
  check('every shot is about the same', Math.max(...es) / Math.min(...es) < 1.8, (Math.max(...es) / Math.min(...es)).toFixed(2));

  // --- Live: chains are disconnected once their sound is over -----------------------
  xr.dispatchEvent({ type: 'selectstart', hand: xr.hands[0] });
  check('audio running', await until(() => audio.unlocked, 120));
  const before = sfx.disposed;
  for (let i = 0; i < 8; i++) {
    sfx.gunshot(V(0.2, 1.3, -0.4));
    sfx.steelPing(V(-5, 1.4, -13), 0.2);
    sfx.brassTink(V(0.3, 0.01, -0.5), 1, 'wood');
  }
  const queued = sfx.pending.length;
  check('each sound queues its chain for cleanup', queued >= 24, queued);
  check('finished chains are disconnected (audio clock)', await until(() => sfx.disposed - before >= 24 && sfx.pending.length === 0, 900),
    `disposed ${sfx.disposed - before}, pending ${sfx.pending.length}, t=${audio.ctx.currentTime.toFixed(1)}`);

  // --- Static echo emitters don't automate every frame ------------------------------
  // Count automation calls on an emitter's panner over a few frames.
  const e0 = audio.echoes[0].emitter;
  let calls = 0;
  for (const param of [e0.panner.positionX, e0.panner.orientationX]) {
    const orig = param.linearRampToValueAtTime.bind(param);
    param.linearRampToValueAtTime = (...args) => { calls++; return orig(...args); };
  }
  await frames(10);
  check('echo emitters are placed once, not re-sent every frame', calls === 0, `${calls} automation calls in 10 frames`);
  // ...while the listener on the head still tracks every frame.
  let listenerCalls = 0;
  const lp = audio.ctx.listener.positionX;
  const origL = lp.linearRampToValueAtTime.bind(lp);
  lp.linearRampToValueAtTime = (...args) => { listenerCalls++; return origL(...args); };
  await frames(10);
  lp.linearRampToValueAtTime = origL;
  check('the listener still follows the head', listenerCalls >= 5, listenerCalls);
  return out;
};
