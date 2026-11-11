/**
 * Records suite: best duel draw, furthest duel ladder run (and the 5/5
 * crown), best pop-up score: beaten only by better results, announced on the
 * sign, shown on the scoreboard, and kept across loads. Runs inside the page.
 */
module.exports = async function recordsSuite() {
  const g = window.__game;
  const { records, duel, popups, targets: tm } = g;
  const hud = duel.hud;
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
  const saved = () => JSON.parse(localStorage.getItem('westernslop.records.v1') ?? 'null');

  check('no records on a fresh device', records.values.duelBestDraw === null && records.values.duelBestRounds === 0 && records.values.popupBest === 0);
  await frames(3);
  check('scoreboard shows a records line', tm.scoreboard.recordsLine.startsWith('Records') && tm.scoreboard.recordsLine.includes('—'),
    tm.scoreboard.recordsLine);

  // --- Duel draw -------------------------------------------------------------------
  hud.show('0.61 s', 'BULLSEYE · beat him by 0.89 s');
  duel.dispatchEvent({ type: 'roundWon', time: 0.61, round: 1 });
  check('first win sets the draw record', records.values.duelBestDraw === 0.61 && saved()?.duelBestDraw === 0.61);
  check('the sign announces it', hud.sub.includes('NEW RECORD DRAW'), hud.sub.replace('\n', ' | '));
  hud.show('0.70 s', 'CHEST · beat him by 0.80 s');
  duel.dispatchEvent({ type: 'roundWon', time: 0.7, round: 2 });
  check('a slower draw is not a record', records.values.duelBestDraw === 0.61 && !hud.sub.includes('NEW RECORD'));
  duel.dispatchEvent({ type: 'roundWon', time: 0.48, round: 3 });
  check('a faster draw is', records.values.duelBestDraw === 0.48);

  // --- Duel ladder --------------------------------------------------------------------
  hud.show('2 / 5', 'outlaws beaten · best draw 0.48 s');
  duel.dispatchEvent({ type: 'summary', wins: 2, champion: false });
  check('ladder record: 2/5', records.values.duelBestRounds === 2 && hud.sub.includes('NEW RECORD'));
  hud.show('1 / 5', 'outlaws beaten');
  duel.dispatchEvent({ type: 'summary', wins: 1, champion: false });
  check('a shorter run is not a record', records.values.duelBestRounds === 2 && !hud.sub.includes('NEW RECORD'));
  duel.dispatchEvent({ type: 'summary', wins: 5, champion: true });
  check('beating all five: crowned', records.values.duelBestRounds === 5 && records.values.duelChampion === true);

  // --- Pop-ups ------------------------------------------------------------------------
  hud.show('840 pts', '6 hit · 2 got away · 75% accuracy\naverage 0.62 s · shoot POP-UP to go again');
  popups.dispatchEvent({ type: 'summary', score: { points: 840 } });
  check('pop-up high score', records.values.popupBest === 840 && hud.sub.includes('NEW HIGH SCORE'), hud.sub.replace('\n', ' | '));
  hud.show('500 pts', 'x');
  popups.dispatchEvent({ type: 'summary', score: { points: 500 } });
  check('a lower score is not a record', records.values.popupBest === 840 && !hud.sub.includes('NEW'));

  // --- Scoreboard and persistence -------------------------------------------------------
  await frames(3);
  const line = tm.scoreboard.recordsLine;
  check('scoreboard shows the records', line.includes('0.48 s') && line.includes('5/5') && line.includes('840'), line);
  const { Records } = await import('/src/game/Records.js');
  const again = new Records();
  check('records come back on the next load', again.values.duelBestDraw === 0.48 && again.values.duelChampion && again.values.popupBest === 840);

  return out;
};
