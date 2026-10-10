// Verifies the scroll restore fires on an in-app (SPA) navigation to a channel
// tab, not just on a hard reload.
//
// YouTube swaps channel-tab content inside shadow DOM, which MutationObserver
// cannot observe, so a URL change with no light-DOM mutation used to be missed
// and the stored video was never restored. This test changes the URL from the
// page world exactly like YouTube does (the content script's history hooks live
// in an isolated world and cannot see it) and mutates nothing, then asserts the
// restore still runs.
//
// No network: the channel page is a local fixture.
// Run: node tools/verify-spa-nav.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
};

const unpackedId = (abs) => [...createHash('sha256').update(abs).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css',
  'popup-classic.html', 'popup-classic.css', 'popup.js', 'import.html', 'import.js', 'LICENSE'];

const CHANNEL = 'https://www.youtube.com/@spatest';
const VIDEO = 'SPAVID00001';

// A video card sits ~3000px down; a successful restore scrolls near it and a
// missed restore leaves scrollY at 0. The hidden placeholder earlier in the DOM
// stands in for the real case this guards: after an in-app tab switch YouTube can
// briefly have the card in the DOM but not laid out (0 tall, at the top), which
// must not be mistaken for the real card.
const fixture = `<!doctype html><html><head>
<script>window.ytcfg={data_:{},set:function(o){Object.assign(this.data_,o);}};</script>
<style>body{margin:0}</style>
</head><body>
<div style="display:none"><a href="/watch?v=${VIDEO}">placeholder</a></div>
<div style="height:3000px"></div>
<ytd-rich-item-renderer><a href="/watch?v=${VIDEO}"><div style="height:200px">target</div></a></ytd-rich-item-renderer>
<div style="height:3000px"></div>
</body></html>`;

const ext = await mkdtemp(join(tmpdir(), 'ss-spa-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-spa-prof-'));
for (const f of FILES) await cp(join(root, f), join(ext, f));
for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
try {
  await ctx.route('https://www.youtube.com/@spatest**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));

  const id = unpackedId(await realpath(ext));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await extPage.waitForTimeout(400);
  await extPage.evaluate(async ({ CHANNEL, VIDEO }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      enabled_sites: { [CHANNEL]: true },
      ['yt_position_' + CHANNEL + '/videos']: { videoId: VIDEO, type: 'video', timestamp: Date.now() }
    });
  }, { CHANNEL, VIDEO });

  const page = await ctx.newPage();
  await page.goto(CHANNEL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // initial (home) restore settles

  // Enter the Videos tab the way YouTube does: change the URL with no DOM
  // mutation the content script's observer could see.
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => history.pushState({}, '', '/@spatest/videos'));

  let scrolled = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    scrolled = await page.evaluate(() => window.scrollY);
    if (scrolled > 2000) break;
  }

  console.log('\nSPA tab switch');
  check(before === 0, 'starts at the top', String(before));
  check(scrolled > 2000, 'restore fired after an in-app URL change with no DOM mutation', String(scrolled));
} finally {
  await ctx.close();
}

console.log(failures === 0 ? '\nSPA navigation restore verified.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
