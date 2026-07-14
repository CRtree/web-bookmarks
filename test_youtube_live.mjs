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
  console.log('🧪 Scroll Saver — Live YouTube Channel Test (video-ID-only)\n');
  console.log('Target:', CHANNEL_URL, '\n');

  const extDir = __dirname;
  const profileDir = path.join(__dirname, '.test-profile');

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

  async function readState() {
    return {
      tracking: await extEval('window.debugReadingPosition.isTrackingActive()'),
      restoring: await extEval('window.debugReadingPosition.isRestoring()'),
      ytChannel: await extEval('window.debugReadingPosition.isYouTubeChannelPage()'),
    };
  }

  // helper: read the yt_position_ entry for the channel
  async function readYTChannelEntry(normalizedUrl) {
    const raw = await extEvalAsync(`
      new Promise((resolve) => {
        const key = 'yt_position_' + ${JSON.stringify(normalizedUrl)};
        chrome.storage.local.get([key], (r) => {
          resolve(JSON.stringify(r[key] || null));
        });
      })
    `);
    return raw && !raw.error ? JSON.parse(raw) : null;
  }

  // helper: click a video that is in viewport at scrollTop (or within 200px)
  async function clickVideoAtScroll(scrollTarget, minLinks) {
    await page.evaluate(y => window.scrollTo(0, y), scrollTarget);
    await sleep(3000); // wait for lazy-load
    const info = await page.evaluate(() => {
      const vh = window.innerHeight;
      const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
      const visible = links.filter(l => {
        const r = l.getBoundingClientRect();
        return r.top > 120 && r.bottom < vh - 20 && r.width > 0;
      });
      const target = visible[0] || links[0];
      if (!target) return null;
      const href = target.getAttribute('href');
      const m = href.match(/[?&]v=([^&]+)/);
      return { href, videoId: m ? m[1] : null };
    });
    if (!info) return info;
    lg('  Clicking videoId=' + info.videoId + ' href=' + info.href);
    await page.evaluate((href) => {
      const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
      const target = links.find(l => l.getAttribute('href') === href) || links[0];
      if (!target) return;
      target.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, composed: true, button: 0
      }));
      target.click();
    }, info.href);
    return info;
  }

  try {

  // ==========================================================
  // STEP 0: Bypass consent + navigate
  // ==========================================================
  console.log('--- STEP 0: Bypass consent + navigate ---');
  await page.context().addCookies([
    { name: 'CONSENT', value: 'YES+cb.20220719-12-p0.en+FX+999', domain: '.youtube.com', path: '/', sameSite: 'Lax', secure: true },
    { name: 'SOCS', value: 'YES', domain: '.youtube.com', path: '/', sameSite: 'Lax', secure: true },
    { name: 'CONSENT', value: 'YES+cb', domain: '.consent.youtube.com', path: '/' },
  ]);
  lg('Consent cookies set');

  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  let currentUrl = page.url();
  lg('After load', currentUrl);

  for (let attempt = 0; attempt < 4 && currentUrl.includes('consent.youtube.com'); attempt++) {
    lg('Consent page detected — attempt ' + (attempt + 1) + ' to dismiss');
    try {
      const btn = await page.$([
        'button[aria-label*="Accept" i]', 'button[aria-label*="Reject" i]',
        'form[action*="save"] button', 'button:has-text("Accept all")',
        'button:has-text("全部接受")', 'button:has-text("Reject all")',
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
  ok('Landed on YouTube channel', currentUrl.includes('youtube.com/@'), currentUrl);
  await sleep(10000);

  // ==========================================================
  // STEP 1: Enable extension
  // ==========================================================
  console.log('\n--- STEP 1: Enable extension ---');
  await sleep(3000);
  let ctxId = await latestExtCtx();
  lg('Ext contexts', extCtxs.length + ' (latest id=' + ctxId + ')');
  ok('Extension context found', ctxId !== null, String(ctxId));
  if (!ctxId) { lg('STOPPING — no extension context'); return; }

  const storageKey = await extEval('window.debugReadingPosition.getStorageKey(window.location.href)');
  const normalizedUrl = storageKey && !storageKey.error
    ? String(storageKey).replace(/^yt_position_/, '').replace(/^reading_position_/, '')
    : currentUrl;
  lg('Normalized URL', normalizedUrl);

  await extEvalAsync(`
    new Promise((resolve) => {
      chrome.storage.local.get(['enabled_sites'], (r) => {
        const sites = r.enabled_sites || {};
        sites[${JSON.stringify(normalizedUrl)}] = true;
        sites[${JSON.stringify(currentUrl)}] = true;
        chrome.storage.local.set({ enabled_sites: sites }, resolve);
      });
    })
  `);

  // ==========================================================
  // STEP 2: Reload to re-init with enabled site
  // ==========================================================
  console.log('\n--- STEP 2: Reload ---');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => lg('Reload timeout', e.message.split('\n')[0]));
  await sleep(10000);
  currentUrl = page.url();
  ok('Still on YouTube after reload', currentUrl.includes('youtube.com/@'), currentUrl);

  ctxId = await latestExtCtx();
  let state = await readState();
  ok('YouTube channel detected', state.ytChannel === true, String(state.ytChannel));

  for (let i = 0; i < 10; i++) {
    if (state.tracking === true) break;
    await sleep(2000);
    state = await readState();
    lg('  retry ' + (i + 1), 'tracking=' + state.tracking);
  }
  ok('Tracking active after reload', state.tracking === true, String(state.tracking));
  if (state.tracking !== true) { lg('STOPPING'); return; }

  await sleep(5000);

  // ==========================================================
  // STEP 3: Scroll does NOT save for YT (video-ID-only mode)
  // ==========================================================
  console.log('\n--- STEP 3: Scroll-save blocked for YT ---');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(ys => window.scrollBy(0, ys), 800);
    await sleep(2000);
  }
  await sleep(3000);
  const scrollAfter = await page.evaluate(() => window.scrollY);
  ok('Scrolled > 1500px', scrollAfter > 1500, String(scrollAfter));

  const scrollSaveExists = await extEvalAsync(`
    new Promise((resolve) => {
      const key = window.debugReadingPosition.getStorageKey(window.location.href);
      chrome.storage.local.get([key], (r) => resolve(!!r[key]));
    })
  `);
  ok('Scroll-save blocked for YT (reading_position_ empty)', scrollSaveExists === false,
    'reading_position_ exists=' + scrollSaveExists);

  // ==========================================================
  // STEP 4: Click a viewport video → saves videoId only
  // ==========================================================
  console.log('\n--- STEP 4: Click video → save videoId ---');
  const linkCount = await page.evaluate(() => document.querySelectorAll('a[href*="/watch?v="]').length);
  ok('Video links found', linkCount > 0, String(linkCount));
  if (linkCount === 0) { lg('STOPPING'); return; }

  const channelUrl = page.url();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  lg('scrollY before click', String(scrollBefore));

  const clickInfo1 = await clickVideoAtScroll(scrollBefore, 1);
  ok('Click target found', !!clickInfo1, clickInfo1?.videoId || 'none');
  if (!clickInfo1) { lg('STOPPING'); return; }

  await sleep(10000);
  const watchUrl1 = page.url();
  ok('Navigated to watch page', watchUrl1.includes('watch?v='), watchUrl1);

  // Verify videoId saved under yt_position_ key
  const ytEntry1 = await readYTChannelEntry(normalizedUrl);
  lg('YT entry after click', JSON.stringify(ytEntry1));
  ok('videoId saved under yt_position_ key',
    ytEntry1 && ytEntry1.videoId === clickInfo1.videoId,
    'expected=' + clickInfo1.videoId + ' got=' + (ytEntry1?.videoId || 'none'));

  // ==========================================================
  // STEP 5: Back-navigation → progressive scan restores to video
  // ==========================================================
  console.log('\n--- STEP 5: Back-navigation progressive scan restore ---');
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(4000);
  await page.goBack({ timeout: 20000 });
  await sleep(15000);

  const backUrl = page.url();
  const backScroll = await page.evaluate(() => window.scrollY);
  const backState = await readState();
  lg('After back: url=' + backUrl + ' scrollY=' + backScroll + ' restoring=' + backState.restoring);

  ok('Back to channel', backUrl.includes('youtube.com/@'), backUrl);
  ok('Progressive scan restored scroll near video', backScroll > 0,
    'scrollY=' + backScroll + ' (beforeClick=' + scrollBefore + ') delta=' + Math.abs(backScroll - scrollBefore));
  ok('isRestoring reset', backState.restoring === false, String(backState.restoring));

  // ==========================================================
  // STEP 6: Deep video — scroll near bottom, click, go back
  // ==========================================================
  console.log('\n--- STEP 6: Deep video near bottom ---');
  await sleep(5000);

  // Scroll progressively to load many videos, then target a video near the bottom
  lg('Loading videos by progressive scrolling...');
  const totalLoaded = await page.evaluate(async () => {
    const DH = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    let lastH = DH();
    let stalled = 0;
    for (let i = 0; i < 40; i++) {
      window.scrollTo(0, DH());
      await new Promise(r => setTimeout(r, 600));
      const h = DH();
      if (h === lastH) {
        stalled++;
        if (stalled > 5) break;
      } else {
        stalled = 0;
        lastH = h;
      }
    }
    return window.scrollY;
  });
  lg('Scrolled near bottom, scrollY=' + totalLoaded);

  // Click a video near the bottom (must have deep scroll for progressive scan to kick in)
  const deepClickInfo = await clickVideoAtScroll(totalLoaded - 300, 5);
  ok('Deep video target found', !!deepClickInfo, deepClickInfo?.videoId || 'none');
  if (!deepClickInfo) { lg('STOPPING deep-video test'); }
  else {
    await sleep(10000);
    const watchUrl2 = page.url();
    ok('Deep: navigated to watch page', watchUrl2.includes('watch?v='), watchUrl2);

    // Verify deep videoId saved
    const ytEntryDeep = await readYTChannelEntry(normalizedUrl);
    lg('Deep YT entry', JSON.stringify(ytEntryDeep));
    ok('Deep videoId saved', ytEntryDeep && ytEntryDeep.videoId === deepClickInfo.videoId,
      'expected=' + deepClickInfo.videoId + ' got=' + (ytEntryDeep?.videoId || 'none'));

    // Back to channel
    await sleep(3000);
    await page.goBack({ timeout: 20000 });
    await sleep(20000); // deep video needs more time for progressive scan

    const deepBackScroll = await page.evaluate(() => window.scrollY);
    const deepBackState = await readState();
    lg('Deep back: scrollY=' + deepBackScroll + ' restoring=' + deepBackState.restoring);

    ok('Deep video restored by progressive scan', deepBackScroll > 500,
      'scrollY=' + deepBackScroll + ' (deep click was near ' + totalLoaded + ')');
    ok('Deep restore: isRestoring reset', deepBackState.restoring === false, String(deepBackState.restoring));
  }

  // ==========================================================
  // STEP 7: Rapid click — 3 videos, verify unique videoIds
  // ==========================================================
  console.log('\n--- STEP 7: Rapid click — 3 videos ---');
  const rapidVideoIds = [];

  for (let round = 1; round <= 3; round++) {
    console.log('\n  Round ' + round + '/3');
    await sleep(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
    await page.evaluate((ys) => window.scrollBy(0, ys), 1000 + round * 1500);
    await sleep(2000);

    const rapidScroll = await page.evaluate(() => window.scrollY);
    lg('  scrollY', String(rapidScroll));

    const info = await page.evaluate(() => {
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
    lg('  Clicked', info?.videoId || 'NONE');
    await sleep(1000);

    const ytEntry = await readYTChannelEntry(normalizedUrl);
    lg('  YT entry:', JSON.stringify(ytEntry));

    if (ytEntry?.videoId) {
      rapidVideoIds.push(ytEntry.videoId);
      ok('Round ' + round + ': videoId stored',
        ytEntry.videoId === info?.videoId,
        'stored=' + ytEntry.videoId + ' expected=' + info?.videoId);
    } else {
      ok('Round ' + round + ': videoId stored', false, 'missing');
    }

    await sleep(8000);
    const rapidWatchUrl = page.url();
    ok('Round ' + round + ': on watch page', rapidWatchUrl.includes('watch?v='), rapidWatchUrl);

    await page.goBack({ timeout: 20000 });
    await sleep(8000);
    const rapidBackScroll = await page.evaluate(() => window.scrollY);
    const rapidBackState = await readState();
    lg('  Back scrollY=' + rapidBackScroll + ' restoring=' + rapidBackState.restoring);
    ok('Round ' + round + ': scroll restored', rapidBackScroll > 0, 'scrollY=' + rapidBackScroll);
  }

  if (rapidVideoIds.length === 3) {
    const uniqueIds = new Set(rapidVideoIds);
    ok('All 3 rapid clicks unique videoIds',
      uniqueIds.size === 3,
      'ids=' + rapidVideoIds.join(', '));
  } else {
    ok('3 rapid clicks completed',
      rapidVideoIds.length === 3,
      'completed=' + rapidVideoIds.length + '/3');
  }

  // ==========================================================
  // STEP 8: Video not found → toast + remove entry
  // ==========================================================
  // Use the already-loaded channel page (all videos visible from prior steps).
  // Save a fake videoId, then force-restore — the page height won't grow
  // so stalls trigger quickly and we verify the not-found cleanup.
  console.log('\n--- STEP 8: Video not found → notification ---');
  // Scroll to top so restoreYouTubePosition runs the scan from scratch
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1000);

  // Save a fake videoId
  await extEvalAsync(`
    new Promise((resolve) => {
      const key = 'yt_position_' + ${JSON.stringify(normalizedUrl)};
      chrome.storage.local.set({ [key]: { videoId: 'FAKE_DEAD_VIDEO', timestamp: Date.now() } }, resolve);
    })
  `);
  lg('Fake videoId saved');

  // Force YouTube restore — the scan will run to end of page
  await extEval('window.debugReadingPosition.forceYouTubeRestore()');
  lg('Forced YouTube restore, waiting for scan...');

  // Wait for scan to give up (max 60 attempts × 1s + stall time)
  await sleep(90000);

  const fakeEntry = await readYTChannelEntry(normalizedUrl);
  lg('Fake entry after scan:', JSON.stringify(fakeEntry));
  ok('Fake videoId removed from storage after not-found scan',
    fakeEntry === null,
    'entry=' + JSON.stringify(fakeEntry));

  // Check toast/log
  const logText = allLogs.join('\n');
  const toastLogged = /Video not found/i.test(logText);
  ok('Toast/log notification for not-found video',
    toastLogged,
    'found in logs=' + toastLogged);

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
      ['finishRestore()', 'isRestoring reset to false'],
      ['3s cooldown', 'stability cooldown'],
      ['Click listener attached', 'Click interception attached'],
      ['Click listener removed', 'Click interception removed'],
      ['Video click detected', 'Video link clicked'],
      ['Progressive scan YT', 'Scan attempt'],
      ['Wiggle triggered', 'wiggling'],
      ['Race guard', 'Already restoring, skipping'],
      ['restoreYouTubePosition', 'restoreYouTubePosition called'],
      ['YT channel detected', 'YouTube channel page detected'],
      ['Scroll Saver active', 'Scroll Saver active for'],
      ['Video not found toast', 'Video not found'],
      ['Saved videoId', 'Saved videoId'],
    ]) {
      console.log('  ' + (t.includes(pt) ? '✅' : 'ℹ️') + ' ' + n + ': ' + (t.includes(pt) ? 'seen' : 'not triggered'));
    }

    console.log('\n--- Relevant Logs (last 60) ---');
    const rel = allLogs.filter(l => /Scroll Saver|CLICK|Saving|Restore|Progressive|video|wiggl|Stall|cooldown|isRestoring|pushState|popstate|extension|Click interception|Channel|article|tracking|enabled|Saved videoId|not found/gi.test(l));
    console.log('  (' + rel.length + ' of ' + allLogs.length + ' total)');
    rel.slice(-60).forEach(l => console.log('    ' + l));

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
