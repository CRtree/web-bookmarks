import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_URL = 'https://www.youtube.com/@LearnEnglishwithBobtheCanadian/videos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const R = [];
function ok(n, p, d) { R.push({ name: n, pass: p, detail: d || '' }); console.log((p ? '✅' : '❌') + ' ' + n + (d ? ' — ' + d : '')); }
function lg(l, d) { console.log('  ' + l + (d !== undefined ? ': ' + d : '')); }

async function main() {
  console.log('🧪 Scroll Saver — Live YouTube Channel Test\n');
  console.log('Target:', CHANNEL_URL, '\n');

  const extDir = __dirname;
  const profileDir = path.join(__dirname, '.test-profile');

  // Clean old profile
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch(e) {}

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
    viewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  const allLogs = [];
  page.on('console', m => allLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => allLogs.push(`[PAGE_ERR] ${e.message}`));

  // CDP
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  const extCtxs = [];
  cdp.on('Runtime.executionContextCreated', p => {
    if (p.context.origin?.startsWith('chrome-extension://'))
      extCtxs.push(p.context);
  });

  async function latestExtCtx() {
    try { await page.evaluate(() => 1); } catch(e) {}
    await sleep(1000);
    return extCtxs.length > 0 ? extCtxs[extCtxs.length - 1].id : null;
  }

  async function extEval(expr) {
    const id = extCtxs.length > 0 ? extCtxs[extCtxs.length - 1].id : null;
    if (!id) return { error: 'no ctx' };
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, contextId: id, returnByValue: true,
      awaitPromise: expr.includes('new Promise') || expr.includes('.then('),
    }).catch(e => ({ error: e.message }));
    if (r.error) return r;
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return r.result?.value;
  }

  async function extEvalAsync(expr) { return extEval(expr); }

  try {
  // ==========================================================
  // STEP 0: Set consent cookie, then navigate
  // ==========================================================
  console.log('--- STEP 0: Bypass consent + navigate ---');

  // Set YouTube consent cookie to skip consent page
  await page.context().addCookies([
    {
      name: 'CONSENT',
      value: 'YES+cb.20220719-12-p0.en+FX+999',
      domain: '.youtube.com',
      path: '/',
      sameSite: 'Lax',
      secure: true,
    },
    {
      name: 'SOCS',
      value: 'YES',
      domain: '.youtube.com',
      path: '/',
      sameSite: 'Lax',
      secure: true,
    },
    {
      name: 'CONSENT',
      value: 'YES+cb',
      domain: '.consent.youtube.com',
      path: '/',
    },
  ]);
  lg('Consent cookies set');

  // Navigate direct to channel
  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  let currentUrl = page.url();
  lg('After load', currentUrl);

  // If still on consent, click through the consent form, then reload if needed.
  for (let attempt = 0; attempt < 4 && currentUrl.includes('consent.youtube.com'); attempt++) {
    lg('Consent page detected — attempt ' + (attempt + 1) + ' to dismiss');
    try {
      const btn = await page.$([
        'button[aria-label*="Accept" i]',
        'button[aria-label*="Reject" i]',
        'form[action*="save"] button',
        'button:has-text("Accept all")',
        'button:has-text("全部接受")',
        'button:has-text("Reject all")',
      ].join(', '));
      if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); await sleep(4000); }
    } catch(e) { lg('Consent click error', e.message); }
    currentUrl = page.url();
    if (currentUrl.includes('consent.youtube.com')) {
      await page.goto(CHANNEL_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await sleep(6000);
      currentUrl = page.url();
    }
  }

  ok('Landed on YouTube channel',
    currentUrl.includes('youtube.com/@'),
    currentUrl);

  // Wait for SPA to render video grid
  await sleep(10000);

  // ==========================================================
  // STEP 1: Enable the extension for this EXACT URL
  // ==========================================================
  console.log('\n--- STEP 1: Enable extension for this page ---');

  // Wait for extension context on this page
  await sleep(3000);
  let ctxId = await latestExtCtx();
  lg('Ext contexts', extCtxs.length + ' (latest id=' + ctxId + ')');
  ok('Extension context found on YouTube', ctxId !== null, String(ctxId));

  if (!ctxId) {
    // Extension might not inject — try to force it
    lg('No ext context — checking if extension is loaded...');
    return;
  }

  // Read the storage key to determine the normalized URL
  const storageKey = await extEval(
    'window.debugReadingPosition.getStorageKey(window.location.href)'
  );
  const normalizedUrl = storageKey && !storageKey.error
    ? String(storageKey).replace(/^reading_position_/, '')
    : currentUrl;
  lg('Normalized URL for enable', normalizedUrl);

  // Enable the extension for this exact URL
  const enabled = await extEvalAsync(`
    new Promise((resolve) => {
      chrome.storage.local.get(['enabled_sites'], (r) => {
        const sites = r.enabled_sites || {};
        sites[${JSON.stringify(normalizedUrl)}] = true;
        // Also enable the consent URL variant (if any redirect happened)
        sites[${JSON.stringify(currentUrl)}] = true;
        chrome.storage.local.set({ enabled_sites: sites }, () => {
          resolve('ok:' + Object.keys(sites).length);
        });
      });
    })
  `);
  lg('Enable result', String(enabled));

  // ==========================================================
  // STEP 2: Force re-init — navigate to same page
  // ==========================================================
  console.log('\n--- STEP 2: Reload to trigger init with enabled site ---');

  // Since the extension already ran init and disabled itself,
  // we need to reload the page so content script runs again
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => lg('Reload timeout (continuing)', e.message.split('\n')[0]));
  await sleep(10000);
  currentUrl = page.url();
  lg('After reload', currentUrl);
  ok('Still on YouTube after reload', currentUrl.includes('youtube.com/@'), currentUrl);

  // Get fresh context after reload
  ctxId = await latestExtCtx();
  lg('Ext context after reload', String(ctxId));

  // Check state
  async function readState() {
    return {
      tracking: await extEval('window.debugReadingPosition.isTrackingActive()'),
      restoring: await extEval('window.debugReadingPosition.isRestoring()'),
      ytChannel: await extEval('window.debugReadingPosition.isYouTubeChannelPage()'),
      storageKey: await extEval('window.debugReadingPosition.getStorageKey(window.location.href)'),
    };
  }

  let state = await readState();
  lg('State after reload', JSON.stringify(state));

  ok('YouTube channel detected', state.ytChannel === true, String(state.ytChannel));

  // Wait for tracking
  for (let i = 0; i < 10; i++) {
    if (state.tracking === true) break;
    await sleep(2000);
    state = await readState();
    lg('  retry ' + (i + 1), 'tracking=' + state.tracking);
  }
  ok('Tracking active after reload', state.tracking === true, String(state.tracking));

  if (state.tracking !== true) {
    lg('STOPPING — tracking not active');
    return;
  }

  // Wait for restore cooldown
  await sleep(5000);

  // ==========================================================
  // STEP 3: Scroll + save
  // ==========================================================
  console.log('\n--- STEP 3: Scroll and verify save ---');

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  for (let i = 0; i < 6; i++) {
    await page.evaluate(ys => window.scrollBy(0, ys), 800);
    await sleep(2000);
  }
  await sleep(3000);
  const scrollAfter = await page.evaluate(() => window.scrollY);
  lg('ScrollY', String(scrollAfter));
  ok('Scrolled > 1500px', scrollAfter > 1500, String(scrollAfter));

  const savedStr = await extEvalAsync(`
    new Promise((resolve) => {
      const key = window.debugReadingPosition.getStorageKey(window.location.href);
      chrome.storage.local.get([key], (r) => {
        resolve(JSON.stringify(r[key] ? {scrollY:r[key].scrollY, videoId:r[key].videoId} : null));
      });
    })
  `);
  const saved = savedStr && !savedStr.error ? JSON.parse(savedStr) : null;
  lg('Saved', JSON.stringify(saved));
  ok('Position saved', saved && saved.scrollY > 500,
    'saved=' + (saved?.scrollY || 'N/A'));

  // ==========================================================
  // STEP 4: Click video
  // ==========================================================
  console.log('\n--- STEP 4: Click video on channel ---');
  const linkCount = await page.evaluate(
    () => document.querySelectorAll('a[href*="/watch?v="]').length
  );
  lg('Video links', String(linkCount));
  ok('Video links found', linkCount > 0, String(linkCount));

  if (linkCount > 0) {
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const channelUrl = page.url();
    lg('Before click — scrollY=' + scrollBefore + ' url=' + channelUrl);

    await sleep(2000);
    // Click a video that is currently in the viewport (the one the user is
    // actually looking at), NOT the first link in the DOM. Clicking the first
    // link would force a scroll back to the top and defeat the purpose of the
    // "align channel restore to the clicked video" feature.
    const clickTarget = await page.evaluate(() => {
      const vh = window.innerHeight;
      const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
      const inView = links.find(l => {
        const r = l.getBoundingClientRect();
        return r.top > 0 && r.top < vh - 100 && r.width > 0 && r.height > 0;
      }) || links[0];
      if (!inView) return null;
      const r = inView.getBoundingClientRect();
      return { href: inView.getAttribute('href'), absTop: Math.round(r.top + window.scrollY) };
    });
    lg('Click target', JSON.stringify(clickTarget));
    // Simulate a REAL user click: fire pointerdown FIRST (YouTube starts SPA
    // navigation on pointerdown, so the extension must intercept there — a plain
    // 'click' listener misses fast clicks), then let the native click navigate.
    // Done in-page so Playwright doesn't auto-scroll the viewport to the top.
    await page.evaluate((href) => {
      const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
      const target = links.find(l => l.getAttribute('href') === href) || links[0];
      if (!target) return;
      target.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, composed: true, button: 0
      }));
      target.click();
    }, clickTarget?.href);
    await sleep(10000);

    const watchUrl = page.url();
    ok('Navigated to watch page', watchUrl.includes('watch?v='), watchUrl);

    // Check click interception
    const clickSavedStr = await extEvalAsync(`
      new Promise((resolve) => {
        const dbg = window.debugReadingPosition;
        const key = dbg.getStorageKey(${JSON.stringify(channelUrl)});
        chrome.storage.local.get([key], (r) => {
          const d = r[key];
          resolve(JSON.stringify(d ? {scrollY:d.scrollY, videoId:d.videoId} : null));
        });
      })
    `);
    const clickSaved = clickSavedStr && !clickSavedStr.error ? JSON.parse(clickSavedStr) : null;
    lg('Channel save after click', JSON.stringify(clickSaved));
    ok('Click interception saved channel position',
      clickSaved && clickSaved.scrollY > 500,
      'scrollY=' + (clickSaved?.scrollY || 'N/A'));
    if (clickSaved?.videoId)
      ok('Video ID extracted', true, 'videoId=' + clickSaved.videoId);

    // Scroll watch
    await page.evaluate(() => window.scrollTo(0, 500));
    await sleep(4000);

    // ==========================================================
    // STEP 5: Back-navigation + scroll restore
    // ==========================================================
    console.log('\n--- STEP 5: Back-navigation restore ---');
    await page.goBack({ timeout: 20000 });
    await sleep(15000);

    const backUrl = page.url();
    const backScroll = await page.evaluate(() => window.scrollY);
    const backState = await readState();
    lg('Back: url=' + backUrl + ' scrollY=' + backScroll + ' restoring=' + backState.restoring);

    ok('Back to channel', backUrl.includes('youtube.com'), backUrl);
    ok('Scroll restored', backScroll > 500,
      'got ' + backScroll + ' (beforeClick=' + scrollBefore + ') delta=' + Math.abs(backScroll - scrollBefore));
    ok('isRestoring false', backState.restoring === false, String(backState.restoring));

    // ==========================================================
    // STEP 6: Save-on-navigate
    // ==========================================================
    console.log('\n--- STEP 6: Save-on-navigate ---');
    const watchSaveStr = await extEvalAsync(`
      new Promise((resolve) => {
        const key = window.debugReadingPosition.getStorageKey(${JSON.stringify(watchUrl)});
        chrome.storage.local.get([key], (r) => {
          resolve(JSON.stringify(r[key] ? r[key].scrollY : null));
        });
      })
    `);
    lg('Watch page persisted', watchSaveStr);
    ok('Save-on-nav: watch page kept',
      JSON.parse(watchSaveStr || 'null') > 0,
      'scrollY=' + watchSaveStr);
  }

  // ==========================================================
  // STEP 7: Rapid click scenario (3 videos, quick clicks)
  // ==========================================================
  console.log('\n--- STEP 7: Rapid click — 3 videos, quick click + back ---');

  const rapidVideoIds = [];
  for (let round = 1; round <= 3; round++) {
    console.log('\n  Round ' + round + '/3');

    // Wait for cooldown to expire
    await sleep(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    // Scroll to a DIFFERENT region each round so positions differ
    await page.evaluate((ys) => window.scrollBy(0, ys), 1000 + round * 1500);
    await sleep(2000);

    const rapidScroll = await page.evaluate(() => window.scrollY);
    lg('  Round ' + round + ' scrollY', String(rapidScroll));

    // Find + click an in-viewport video with MINIMAL delay (rapid click simulation)
    const rapidClickInfo = await page.evaluate(() => {
      const all = document.querySelectorAll('a[href*="/watch?v="]');
      for (const a of all) {
        const r = a.getBoundingClientRect();
        if (r.top > 150 && r.bottom < window.innerHeight && r.width > 0) {
          const href = a.getAttribute('href');
          const m = href.match(/[?&]v=([^&]+)/);
          a.click();
          return { href, videoId: m ? m[1] : null };
        }
      }
      return null;
    });
    lg('  Clicked', rapidClickInfo?.videoId || 'NONE');

    // SHORT wait — simulates rapid click (user clicks without waiting for debounce)
    await sleep(1000);

    // Immediately check if the click stored videoId.
    // After click, location has already changed to watch URL, so query
    // the channel's fixed storage key (computed from STEP 1's normalizedUrl).
    const rapidSaved = await extEvalAsync(`
      new Promise((resolve) => {
        const channelKey = 'reading_position_' + ${JSON.stringify(normalizedUrl)};
        chrome.storage.local.get([channelKey], (r) => {
          const d = r[channelKey];
          resolve(JSON.stringify(d ? {scrollY:d.scrollY, videoId:d.videoId || 'NONE'} : null));
        });
      })
    `);
    const rd = JSON.parse(rapidSaved || '{}');
    lg('  Rapid save:', JSON.stringify(rd));

    if (rd?.videoId && rd.videoId !== 'NONE') {
      rapidVideoIds.push(rd.videoId);
      ok('Rapid click round ' + round + ': videoId stored',
        rd.videoId === rapidClickInfo?.videoId,
        'stored=' + rd.videoId + ' expected=' + rapidClickInfo?.videoId);
    } else {
      ok('Rapid click round ' + round + ': videoId stored',
        false,
        'videoId missing — click too fast for handler?');
    }

    // Wait for watch page to load
    await sleep(8000);

    const rapidWatchUrl = page.url();
    ok('Round ' + round + ': on watch page',
      rapidWatchUrl.includes('watch?v='),
      rapidWatchUrl);

    // Back to channel (wait only minimal time — user doesn't stay long)
    await page.goBack({ timeout: 20000 });
    await sleep(8000);

    // Check if scroll was restored with correct videoId
    const rapidBackScroll = await page.evaluate(() => window.scrollY);
    const rapidBackState = await readState();
    lg('  Back scrollY=' + rapidBackScroll + ' restoring=' + rapidBackState.restoring);
    ok('Round ' + round + ': scroll restored after rapid back',
      rapidBackScroll > 500,
      'scrollY=' + rapidBackScroll);
  }

  // Verify all 3 clicks stored DIFFERENT videoIds (no stale/cached ID)
  if (rapidVideoIds.length === 3) {
    const uniqueIds = new Set(rapidVideoIds);
    ok('All 3 rapid clicks stored unique videoIds',
      uniqueIds.size === 3,
      'ids=' + rapidVideoIds.join(', ') + ' unique=' + uniqueIds.size);
  } else {
    ok('3 rapid clicks completed',
      rapidVideoIds.length === 3,
      'completed=' + rapidVideoIds.length + '/3 ids=' + rapidVideoIds.join(', '));
  }

  } catch(err) {
    console.error('\n🔴 ' + err.message);
    ok('EXCEPTION', false, err.message);
  } finally {
    console.log('\n' + '='.repeat(60));
    console.log('📊 LIVE YOUTUBE TEST REPORT');
    console.log('='.repeat(60));
    for (const r of R) console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.detail ? ' — ' + r.detail : ''));
    const p = R.filter(r => r.pass).length, f = R.filter(r => !r.pass).length;

    console.log('\n--- Log Feature Detection ---');
    const t = allLogs.join('\n');
    for (const [n, pt] of [
      ['finishRestore() centralized', 'isRestoring reset to false'],
      ['3s cooldown', 'stability cooldown'],
      ['Click listener attached', 'Click interception attached'],
      ['Click listener removed', 'Click interception removed'],
      ['Video click detected', 'Video link clicked'],
      ['Video refinement', 'Refining restore'],
      ['Progressive scroll', 'Progressive scroll attempt'],
      ['Wiggle triggered', 'wiggling'],
      ['Race guard', 'Already restoring, skipping'],
      ['Save-on-nav pushState', 'pushState'],
      ['Save-on-nav popstate', 'popstate'],
      ['restoreScrollPosition', 'restoreScrollPosition called'],
      ['YT channel detected', 'YouTube channel page detected'],
      ['Scroll Saver active', 'Scroll Saver active for'],
    ]) {
      console.log('  ' + (t.includes(pt) ? '✅' : 'ℹ️') + ' ' + n + ': ' + (t.includes(pt) ? 'seen' : 'not triggered'));
    }

    console.log('\n--- Relevant Logs (last 50) ---');
    const rel = allLogs.filter(l => /Scroll Saver|CLICK|Saving|Restore|Progressive|video|wiggling|Stall|Refining|cooldown|isRestoring|pushState|popstate|recently|extension|Click interception|Channel|watch\?v=|article|tracking|enabled/.test(l));
    console.log('  (' + rel.length + ' of ' + allLogs.length + ' total)');
    rel.slice(-50).forEach(l => console.log('    ' + l));

    console.log('\n' + '-'.repeat(60));
    console.log(R.length + ' assertions | ✅ ' + p + ' passed' + (f > 0 ? ' | ❌ ' + f + ' failed' : ' | 🎉 ALL PASSED'));

    console.log('\n⏸️  Closing in 15s...');
    await sleep(15000);
    await browser.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch(e) {}
    console.log('🧹 Done');
    process.exit(f > 0 ? 1 : 0);
  }
}

main();
