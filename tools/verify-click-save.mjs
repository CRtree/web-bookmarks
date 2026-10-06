// Regression test for "stray saved videos" (customer bug).
//
// A YouTube channel page is an SPA, so navigating within it changes the URL
// without a full load. The original code re-armed the click-to-save listener on
// every such change without checking whether the channel was added, so clicking
// a video on a channel the user never added silently wrote a yt_position_ entry —
// while the popup button still read "Add".
//
// Loads the real extension in Chromium against a local YouTube-shaped fixture and
// asserts the full lifecycle:
//   1. Not added  + SPA navigation + click  -> nothing is saved
//   2. Add (while the page stays open) + click -> saved (no reload needed)
//   3. Stop (while the page stays open) + click -> ignored, entry unchanged
//
// Run: node tools/verify-click-save.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A channel page has to be on a youtube.com /@ URL for content.js to treat it as
// a channel. Requests are fulfilled locally, so no network is involved.
const CHANNEL_PATH = '/@testchannel/videos';
const CHANNEL_URL = 'https://www.youtube.com' + CHANNEL_PATH;
const CHANNEL_ROOT = 'https://www.youtube.com/@testchannel';
const STORAGE_KEY = 'yt_position_' + CHANNEL_URL;

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture Channel</title></head>
<body>
  <div id="contents">
    <div class="card"><a href="/watch?v=VIDEO_ONE">Video One</a></div>
    <div class="card"><a href="/watch?v=VIDEO_TWO">Video Two</a></div>
    <div class="card"><a href="/watch?v=VIDEO_THREE">Video Three</a></div>
  </div>
  <script>
    // YouTube handles video clicks with an SPA navigation; keep the fixture on the
    // channel page so the content script's save path is what is under test.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href*="/watch?v="]');
      if (a) e.preventDefault();
    });
  </script>
</body>
</html>`;

const FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css',
               'popup-classic.html', 'popup-classic.css', 'popup.js', 'import.html', 'import.js', 'LICENSE'];

const ext = await mkdtemp(join(tmpdir(), 'ss-click-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-click-prof-'));

let ctx;
try {
  for (const f of FILES) await cp(join(root, f), join(ext, f));
  for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

  const page = await ctx.newPage();

  // The content script runs in an isolated world; reach it over CDP by finding the
  // execution context where window.debugReadingPosition exists.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Runtime.enable');
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', (p) => worlds.push(p.context));

  async function findContentContext() {
    for (let i = worlds.length - 1; i >= 0; i--) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.debugReadingPosition',
        contextId: worlds[i].id,
        returnByValue: true,
      }).catch(() => null);
      if (r?.result?.value === 'object') return worlds[i].id;
    }
    return null;
  }

  async function extEval(expression) {
    const contextId = await findContentContext();
    if (!contextId) return undefined;
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: /new Promise|\.then\(/.test(expression),
    }).catch((e) => ({ error: e.message }));
    if (r.error) return { error: r.error };
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return r.result?.value;
  }

  async function waitFor(fn, timeout = 10000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await fn()) return true;
      await sleep(interval);
    }
    return false;
  }

  const getEnabled = () => extEval(
    'window.debugReadingPosition ? window.debugReadingPosition.isEnabled() : null');

  async function setEnabled(on) {
    const body = on
      ? `sites[${JSON.stringify(CHANNEL_ROOT)}] = true;`
      : `delete sites[${JSON.stringify(CHANNEL_ROOT)}];`;
    return extEval(`new Promise((resolve) => {
      chrome.storage.local.get(['enabled_sites'], (r) => {
        const sites = r.enabled_sites || {};
        ${body}
        chrome.storage.local.set({ enabled_sites: sites }, () => resolve(true));
      });
    })`);
  }

  async function readEntry() {
    const raw = await extEval(`new Promise((resolve) => {
      chrome.storage.local.get([${JSON.stringify(STORAGE_KEY)}], (r) => {
        resolve(JSON.stringify(r[${JSON.stringify(STORAGE_KEY)}] || null));
      });
    })`);
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  const countEntries = () => extEval(`new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      resolve(Object.keys(items).filter((k) => k.startsWith('yt_position_')).length);
    });
  })`);

  async function clickCard(videoId) {
    return page.evaluate((vid) => {
      const a = document.querySelector(`a[href="/watch?v=${vid}"]`);
      if (!a) return false;
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      return true;
    }, videoId);
  }

  // Serve our own channel page for every youtube.com request; the URL bar and
  // location.pathname stay real, so isYouTubeChannelPage() still matches.
  await page.route('https://www.youtube.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: FIXTURE_HTML,
  }));

  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

  console.log('\ncontent script ready');
  const ready = await waitFor(async () =>
    (await extEval('typeof window.debugReadingPosition')) === 'object');
  check(ready === true, 'content script loaded on the channel page');

  // ---- 1. Not added: an SPA navigation must not arm click-to-save ----
  console.log('\n1. non-added channel (the bug)');
  const startsDisabled = await waitFor(async () => (await getEnabled()) === false);
  check(startsDisabled === true, 'channel starts not added (isEnabled=false)');

  // Reproduce the exact trigger: in-page navigation re-runs the enabled check.
  await page.evaluate(() => history.pushState({}, '', '/@testchannel/shorts'));
  await sleep(500);
  await page.evaluate(() => history.pushState({}, '', '/@testchannel/videos'));
  await sleep(500);

  const stillDisabled = (await getEnabled()) === false;
  check(stillDisabled, 'still not added after SPA navigation');

  const clickedDisabled = await clickCard('VIDEO_ONE');
  check(clickedDisabled === true, 'clicked a video on the non-added channel');
  await sleep(600);

  const strayEntry = await readEntry();
  check(strayEntry === null, 'no entry saved for a non-added channel', JSON.stringify(strayEntry));
  const entryCount = await countEntries();
  check(entryCount === 0, 'no yt_position_ keys written at all', String(entryCount));

  // ---- 2. Add from the popup while the page stays open ----
  // The popup writes enabled_sites and nothing notifies the content script
  // directly, so this guards the storage.onChanged watcher.
  console.log('\n2. add while the page is open');
  await setEnabled(true);
  const pickedUp = await waitFor(async () => (await getEnabled()) === true);
  check(pickedUp === true, 'content script picks up "Add" without a reload');

  const clickedEnabled = await clickCard('VIDEO_TWO');
  check(clickedEnabled === true, 'clicked a video after adding the channel');
  await sleep(600);

  const savedEntry = await readEntry();
  check(savedEntry && savedEntry.videoId === 'VIDEO_TWO',
    'entry saved after adding', JSON.stringify(savedEntry));
  check(savedEntry && savedEntry.type === 'video',
    'saved entry records the content type', JSON.stringify(savedEntry));

  // ---- 3. Stop while the page stays open: clicks are ignored again ----
  console.log('\n3. stop while the page is open');
  await setEnabled(false);
  const disabledAgain = await waitFor(async () => (await getEnabled()) === false);
  check(disabledAgain === true, 'content script picks up "Stop" without a reload');

  const clickedAfterStop = await clickCard('VIDEO_THREE');
  check(clickedAfterStop === true, 'clicked a different video after Stop');
  await sleep(600);

  const unchanged = await readEntry();
  check(unchanged && unchanged.videoId === 'VIDEO_TWO',
    'entry unchanged after Stop (click ignored)', JSON.stringify(unchanged));

  await page.close();
} catch (err) {
  failures++;
  console.log(`\n❌ ${err.message.split('\n')[0]}`);
} finally {
  if (ctx) await ctx.close();
  await rm(ext, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

console.log(failures === 0
  ? '\n🎉 click-to-save gating verified end to end'
  : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
