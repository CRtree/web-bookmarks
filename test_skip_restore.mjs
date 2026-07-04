import { chromium } from 'playwright';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const R = [];
function ok(n, p, d) { R.push({ name: n, pass: p, detail: d || '' }); console.log((p ? '✅' : '❌') + ' ' + n + (d ? ' — ' + d : '')); }
function lg(l, d) { console.log('  ' + l + (d !== undefined ? ': ' + d : '')); }

// A tall page so we can scroll to ~10000px. Marked article-ish, but forceRestore
// works regardless of article detection.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Skip Restore Repro</title></head>
<body style="margin:0">
<article>
${Array.from({ length: 400 }, (_, i) => `<p style="height:40px;margin:0">Line ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`).join('\n')}
</article>
</body></html>`;

async function main() {
  console.log('🧪 Skip-Restore Guard — Back-Navigation Overshoot Test\n');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  });
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const URL = `http://localhost:${PORT}/`;
  lg('Serving', URL);

  const extDir = __dirname;
  const profileDir = path.join(__dirname, '.test-profile-skip');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch(e) {}

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    viewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  const allLogs = [];
  page.on('console', m => allLogs.push(`[${m.type()}] ${m.text()}`));

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  const candidateCtxs = [];
  cdp.on('Runtime.executionContextCreated', p => {
    const aux = p.context.auxData || {};
    if (p.context.origin?.startsWith('chrome-extension://') || aux.type === 'isolated') {
      candidateCtxs.push(p.context.id);
    }
  });

  // Among candidate isolated worlds, find the extension's content-script world
  // (the one where window.debugReadingPosition is defined). Playwright injects
  // its own utility isolated world too, so we must probe to disambiguate.
  let extCtxId = null;
  async function resolveExtCtx() {
    if (extCtxId) return extCtxId;
    for (const id of candidateCtxs) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.debugReadingPosition', contextId: id, returnByValue: true,
      }).catch(() => null);
      if (r && r.result?.value === 'object') { extCtxId = id; return id; }
    }
    return null;
  }

  async function extEval(expr) {
    const id = await resolveExtCtx();
    if (!id) return { error: 'no ext ctx' };
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, contextId: id, returnByValue: true,
      awaitPromise: expr.includes('new Promise'),
    }).catch(e => ({ error: e.message }));
    if (r.error) return r;
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return r.result?.value;
  }

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 15000 });
    await sleep(2000);

    // Wait for the extension's content-script world to be resolvable.
    let ctxOk = false;
    for (let i = 0; i < 20; i++) {
      if (await resolveExtCtx()) { ctxOk = true; break; }
      await sleep(500);
    }
    lg('Ext ctx id', String(extCtxId));
    ok('Extension context available', ctxOk, String(extCtxId));

    const SAVED = 10000;
    const OVERSHOOT = SAVED + 311; // YouTube-style ~310px load-past

    // Write a saved position at 10000px under this URL's storage key.
    const wrote = await extEval(`
      new Promise((resolve) => {
        const dbg = window.debugReadingPosition;
        const key = dbg.getStorageKey(window.location.href);
        chrome.storage.local.set({ [key]: {
          scrollY: ${SAVED}, scrollPercent: 80, timestamp: Date.now(),
          url: window.location.href, title: document.title, videoId: null
        }}, () => resolve('ok:' + key));
      })
    `);
    lg('Wrote saved position', String(wrote));
    ok('Saved position written at ' + SAVED, typeof wrote === 'string' && wrote.startsWith('ok:'), String(wrote));

    // Simulate the page loading ~310px BELOW the saved position after back-nav.
    await page.evaluate(y => window.scrollTo(0, y), OVERSHOOT);
    await sleep(500);
    const afterScroll = await page.evaluate(() => window.scrollY);
    lg('Scrolled to (overshoot)', String(afterScroll));
    ok('Scrolled past saved (to ' + OVERSHOOT + ')', afterScroll >= OVERSHOOT - 5, String(afterScroll));

    // Trigger restore.
    await extEval('window.debugReadingPosition.forceRestore(window.location.href)');
    await sleep(4000); // allow smooth scroll + settle

    const finalScroll = await page.evaluate(() => window.scrollY);
    lg('Final scroll after restore', String(finalScroll));

    const skipped = allLogs.some(l => l.includes('Already scrolled past saved position, skipping restore'));
    ok('Restore NOT skipped on overshoot', !skipped, skipped ? 'skip log seen' : 'no skip');

    // The core bug: final position should be back at the saved position (~10000),
    // not left at the overshoot (~10311).
    ok('Scrolled up to saved position', Math.abs(finalScroll - SAVED) <= 60,
      'final=' + finalScroll + ' target=' + SAVED + ' delta=' + Math.abs(finalScroll - SAVED));

    // ==========================================================
    // Scenario 2: STALE click videoId must NOT be recovered when the saved
    // scroll position differs from the click-saved position. (Regression:
    // user watched a first video, then scrolled far away; restore was yanking
    // back to the first video's position.)
    // ==========================================================
    console.log('\n--- Scenario 2: stale click videoId is ignored ---');
    allLogs.length = 0;
    const SCROLL_SAVE = 9000;   // a genuine scroll save far from the click
    const CLICK_POS = 2000;     // where the old clicked video was
    await extEval(`
      new Promise((resolve) => {
        const dbg = window.debugReadingPosition;
        const key = dbg.getStorageKey(window.location.href);
        const clickKey = key.replace('reading_position_', 'click_video_');
        chrome.storage.local.set({
          [key]: { scrollY: ${SCROLL_SAVE}, scrollPercent: 72, timestamp: Date.now(),
                   url: window.location.href, title: document.title },
          [clickKey]: { videoId: 'STALEvid123', scrollY: ${CLICK_POS}, timestamp: Date.now() }
        }, () => resolve('ok'));
      })
    `);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await extEval('window.debugReadingPosition.forceRestore(window.location.href)');
    await sleep(4000);

    const recovered = allLogs.some(l => l.includes('Recovered clicked videoId'));
    const skippedStale = allLogs.some(l => l.includes('Skipping stale click videoId'));
    ok('Stale videoId NOT recovered', !recovered, recovered ? 'recovered (BUG)' : 'not recovered');
    ok('Stale videoId explicitly skipped', skippedStale, skippedStale ? 'skip log seen' : 'no skip log');
    const final2 = await page.evaluate(() => window.scrollY);
    ok('Restored to scroll-saved position (not click pos)',
      Math.abs(final2 - SCROLL_SAVE) <= 60,
      'final=' + final2 + ' target=' + SCROLL_SAVE);

    // ==========================================================
    // Scenario 3: MATCHING click videoId IS recovered (re-render jitter case).
    // ==========================================================
    console.log('\n--- Scenario 3: matching click videoId is recovered ---');
    allLogs.length = 0;
    const MATCH_SCROLL = 8000;
    const MATCH_CLICK = 8250; // within tolerance (jitter)
    await extEval(`
      new Promise((resolve) => {
        const dbg = window.debugReadingPosition;
        const key = dbg.getStorageKey(window.location.href);
        const clickKey = key.replace('reading_position_', 'click_video_');
        chrome.storage.local.set({
          [key]: { scrollY: ${MATCH_SCROLL}, scrollPercent: 64, timestamp: Date.now(),
                   url: window.location.href, title: document.title },
          [clickKey]: { videoId: 'MATCHvid456', scrollY: ${MATCH_CLICK}, timestamp: Date.now() }
        }, () => resolve('ok'));
      })
    `);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await extEval('window.debugReadingPosition.forceRestore(window.location.href)');
    await sleep(4000);
    const recovered3 = allLogs.some(l => l.includes('Recovered clicked videoId'));
    ok('Matching videoId IS recovered', recovered3, recovered3 ? 'recovered' : 'not recovered (BUG)');

  } catch(err) {
    ok('EXCEPTION', false, err.message);
  } finally {
    console.log('\n' + '='.repeat(60));
    const p = R.filter(r => r.pass).length, f = R.filter(r => !r.pass).length;
    console.log(R.length + ' assertions | ✅ ' + p + ' passed' + (f > 0 ? ' | ❌ ' + f + ' failed' : ' | 🎉 ALL PASSED'));
    await browser.close();
    server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch(e) {}
    process.exit(f > 0 ? 1 : 0);
  }
}

main();
