/**
 * Radio suite: the old radio on the bench comes alive once audio is unlocked,
 * streams the western tracks (all served), shuffles through every track before
 * repeating, moves on when a track ends, and its knobs (pointed at + trigger)
 * do power, volume down / up and next; power and volume persist. Runs inside
 * the page.
 */
module.exports = async function radioSuite() {
  const g = window.__game;
  const { THREE, radio, settings, xr, audio } = g;
  const { TRACKS } = await import('/src/audio/Radio.js');
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
  const fake = (hand, handedness) => {
    hand.inputSource = { handedness, gamepad: { buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], hapticActuators: [] }, profiles: [] };
    hand.handedness = handedness;
    hand.connected = true;
  };
  const pose = (hand, pos, quat) => {
    for (const o of [hand.grip, hand.controller]) {
      o.position.copy(pos);
      o.quaternion.copy(quat);
      o.matrix.compose(o.position, o.quaternion, o.scale);
      o.matrixWorldNeedsUpdate = true;
    }
  };
  const L = xr.hands[1];
  fake(xr.hands[0], 'right');
  fake(L, 'left');
  /** Point the left hand at a knob and pull the trigger. */
  const press = async (action) => {
    const knob = radio.buttons.find((b) => b.userData.radioAction === action);
    const target = knob.getWorldPosition(V(0, 0, 0));
    const from = V(-0.2, 1.35, 0.1);
    pose(L, from, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(from, target, V(0, 1, 0))));
    await frames(2);
    xr.dispatchEvent({ type: 'selectstart', hand: L });
    await frames(2);
  };

  // --- Files ---------------------------------------------------------------------------
  const base = new URL('music/', document.baseURI);
  const served = await Promise.all(TRACKS.map(async (t) => {
    const r = await fetch(new URL(t.file, base));
    return r.ok && /audio/.test(r.headers.get('content-type') ?? '') && Number(r.headers.get('content-length') ?? 1) > 100000;
  }));
  check('all six tracks are served as audio', TRACKS.length === 6 && served.every(Boolean), served.join(','));
  const credits = await fetch(new URL('CREDITS.md', base));
  check('music credits are served with them', credits.ok && (await credits.text()).includes('CC BY 4.0'));

  // --- Comes alive with audio -------------------------------------------------------------
  check('radio sits on the bench', radio.object.getWorldPosition(V(0, 0, 0)).y > 0.85 && radio.buttons.length === 4);
  check('silent until audio is unlocked', !radio.built && !radio.playing);
  await press('next'); // the first trigger press unlocks audio
  check('audio unlocked by the press', await until(() => audio.unlocked, 120));
  check('radio switches on and plays', await until(() => radio.built && radio.playing, 300), `built=${radio.built} playing=${radio.playing}`);
  const t0 = radio.el.currentTime;
  await until(() => radio.el.currentTime > t0 + 0.3, 300);
  check('the track really streams (time advances)', radio.el.currentTime > t0 + 0.3, `${t0.toFixed(2)} -> ${radio.el.currentTime.toFixed(2)}`);
  check('it plays one of the western tracks', TRACKS.some((t) => radio.el.src.endsWith(t.file)), radio.el.src);
  check('music sounds from the radio (positional)', radio.speaker instanceof THREE.PositionalAudio && radio.speaker.parent === radio.object);

  // --- Shuffle -----------------------------------------------------------------------------
  while (radio.played.length < 6) await press('next');
  const firstSix = radio.played.slice(0, 6);
  check('shuffle plays every track once before repeating', new Set(firstSix).size === 6, firstSix.join(' | '));
  const n = radio.played.length;
  radio.el.dispatchEvent(new Event('ended'));
  await frames(2);
  check('moves on by itself when a track ends', radio.played.length === n + 1 && radio.played[n] !== radio.played[n - 1]);

  // --- Volume and power ---------------------------------------------------------------------
  await press('down');
  check('volume down', Math.abs(settings.get('musicVolume') - 0.4) < 1e-9 && Math.abs(radio.gain.gain.value - 0.32) < 1e-3, radio.gain.gain.value);
  await press('up');
  await press('up');
  check('volume up', Math.abs(settings.get('musicVolume') - 0.6) < 1e-9);
  await press('power');
  check('power off: music stops', settings.get('musicOn') === false && radio.el.paused);
  await press('next');
  check('next does nothing while off', radio.el.paused);
  await press('power');
  check('power on: music resumes', await until(() => radio.playing, 120));
  const { Settings } = await import('/src/game/Settings.js');
  const saved = new Settings();
  check('power and volume are saved', saved.get('musicOn') === true && Math.abs(saved.get('musicVolume') - 0.6) < 1e-9);
  return out;
};
