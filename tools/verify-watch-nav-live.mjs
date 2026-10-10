// Live end-to-end test for watch-page Prev / Next.
//
// Loads the real extension, serves a fake youtube.com watch page (so the content
// script runs on the right origin) whose inline ytcfg advertises the real WEB
// client, then asks the content script to fetch the channel's ordered playlist.
// Also exercises the popup-facing path through the background proxy.
//
// This is the test that catches the "service worker gets HTTP 403" class of bug:
// the request must originate from the page, not the extension.
//
// Requires network access to youtube.com.
// Run: node tools/verify-watch-nav-live.mjs

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

// Public WEB key every YouTube page ships; a fixture, not a user secret.
const KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const VER = '2.20261009.01.00';
const VIDEO = '7dyMnwKPTAg'; // deep in a real channel's uploads list
const EXPECT_NEXT = '-2BFZsiVejU';
const EXPECT_PREV = 'DSIaExtrG9k';

const unpackedId = (abs) => [...createHash('sha256').update(abs).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css',
  'popup-classic.html', 'popup-classic.css', 'popup.js', 'import.html', 'import.js', 'LICENSE'];

const ext = await mkdtemp(join(tmpdir(), 'ss-live-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-live-prof-'));
for (const f of FILES) await cp(join(root, f), join(ext, f));
for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

const fakeHtml = `<!doctype html><html><head><title>fixture watch</title>
<script>window.ytcfg={data_:{},set:function(o){Object.assign(this.data_,o);}};ytcfg.set({"INNERTUBE_API_KEY":"${KEY}","INNERTUBE_CONTEXT_CLIENT_VERSION":"${VER}"});</script>
</head><body>fixture</body></html>`;

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
try {
  await ctx.route('https://www.youtube.com/watch**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fakeHtml }));

  const watch = await ctx.newPage();
  await watch.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded' });
  await watch.waitForTimeout(2000); // content script at document_idle

  const id = unpackedId(await realpath(ext));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await extPage.waitForTimeout(500);

  const direct = await extPage.evaluate(async (videoId) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((t) => t.url && t.url.includes('/watch?v=' + videoId));
    if (!target) return { error: 'watch tab not found' };
    try {
      return { resp: await chrome.tabs.sendMessage(target.id, { action: 'fetch_watch_nav', videoId, listId: null }) };
    } catch (e) { return { error: String(e) }; }
  }, VIDEO);

  console.log('\ncontent script fetch');
  check(!direct.error, 'content script reachable', direct.error);
  check(direct.resp && direct.resp.ok, 'content script fetch succeeded', JSON.stringify(direct.resp).slice(0, 200));
  if (direct.resp && direct.resp.ok) {
    const nav = direct.resp.nav;
    check(nav.schema === 2, 'nav carries the current schema version', String(nav.schema));
    check(typeof nav.index === 'number' && nav.index > 0, 'current position resolved', String(nav.index));
    check(/^UU/.test(nav.playlistId || ''), 'sourced from the uploads playlist', nav.playlistId);
    check(nav.next && nav.next.videoId === EXPECT_NEXT, 'next video resolved', nav.next && nav.next.videoId);
    check(nav.prev && nav.prev.videoId === EXPECT_PREV, 'prev video resolved', nav.prev && nav.prev.videoId);
    check(!!(nav.current && nav.current.thumbnail), 'thumbnail present');
    check(nav.channelUrl === 'https://www.youtube.com/@RickAstleyYT', 'channel url resolved', nav.channelUrl);
    check(nav.channelUploads === true && nav.channelId === 'UCuAXFkgsw1L7xaCfnd5JJOw',
      'channel identity resolved for position refresh', JSON.stringify({ id: nav.channelId, uploads: nav.channelUploads }));
  }

  const viaBg = await extPage.evaluate(async (videoId) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((t) => t.url && t.url.includes('/watch?v=' + videoId));
    return chrome.runtime.sendMessage({ action: 'get_watch_nav', videoId, listId: null, tabId: target && target.id });
  }, VIDEO);

  console.log('\nbackground proxy');
  check(viaBg && viaBg.ok, 'background proxy returned nav', JSON.stringify(viaBg).slice(0, 200));
  check(viaBg && viaBg.nav && viaBg.nav.next && viaBg.nav.next.videoId === EXPECT_NEXT,
    'proxied next matches', viaBg && viaBg.nav && viaBg.nav.next && viaBg.nav.next.videoId);
} finally {
  await ctx.close();
}

console.log(failures === 0 ? '\nWatch-page navigation verified live.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
