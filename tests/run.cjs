/**
 * Headless simulation tests. Starts a Vite dev server, then runs each suite in
 * a freshly loaded page in Chromium. Suites are functions evaluated in the page;
 * they drive the game through window.__game with fake XR controllers and
 * return [{ name, ok, detail }].
 *
 * Run: npm test   (needs the `playwright` package and a Chromium build)
 *      npm test -- targets   (run only suites whose name matches)
 *      VERBOSE=1 npm test    (stream each check as it runs)
 */
const path = require('node:path');
const { chromium } = require('playwright');

const SUITES = {
  revolver: require('./suites/revolver.cjs'),
  targets: require('./suites/targets.cjs'),
  physics: require('./suites/physics.cjs'),
  reload: require('./suites/reload.cjs'),
};

(async () => {
  const filter = process.argv[2];
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: path.join(__dirname, '..'),
    logLevel: 'error',
    server: { port: 5199, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

  let total = 0;
  let failed = 0;
  try {
    for (const [name, suite] of Object.entries(SUITES)) {
      if (filter && !name.includes(filter)) continue;
      const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
        else if (process.env.VERBOSE && m.text().startsWith('[check]')) console.log('   ', m.text());
      });
      await page.goto(url);
      await page.waitForFunction(() => window.__game);

      console.log(`\n== ${name}`);
      const results = await page.evaluate(suite);
      if (pageErrors.length) results.push({ name: 'no page errors', ok: false, detail: pageErrors.join(' | ') });
      for (const r of results) {
        total++;
        if (!r.ok) failed++;
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok && !r.detail ? '' : `  (${r.detail})`}`);
      }
      await page.close();
    }
    console.log(`\n${total - failed}/${total} checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(failed || total === 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
