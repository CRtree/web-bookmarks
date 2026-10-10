// Verifies that Prev / Next refreshes the right saved positions — and only those.
//
// The channel's Videos tab always follows (Prev / Next walks that exact list, so
// every target lives there). Home/Shorts/other tabs and other channels must keep
// their own videos — even when they hold the current video — otherwise a later
// restore scans a page for a video it does not contain and ends up at the
// bottom.
//
// Loads the real extension, seeds several positions, sends the same
// `watch_nav_goto` message the popup sends, and asserts exactly the expected
// entries changed.
//
// No network: the watch-page navigation is served from a local fixture.
// Run: node tools/verify-watch-nav-refresh.mjs

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

const FROM = '7fUk5bVvjCk';
const NEW = '-2BFZsiVejU';
const CHANNEL = 'https://www.youtube.com/@RickAstleyYT';
const VIDEOS = `yt_position_${CHANNEL}/videos`;
const HOME = `yt_position_${CHANNEL}`;
const SHORTS = `yt_position_${CHANNEL}/shorts`;
const STREAMS = `yt_position_${CHANNEL}/streams`;
const OTHER = 'yt_position_https://www.youtube.com/@SomeOtherChannel';
const CACHE = 'yt_nav_7dyMnwKPTAg';

const ext = await mkdtemp(join(tmpdir(), 'ss-ref-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-ref-prof-'));
for (const f of FILES) await cp(join(root, f), join(ext, f));
for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
try {
  await ctx.route('https://www.youtube.com/watch**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));

  const id = unpackedId(await realpath(ext));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await extPage.waitForTimeout(500);

  const result = await extPage.evaluate(async ({ seeds, keys, fromVideoId, videoId, channelUrl }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(seeds);

    const tab = await chrome.tabs.create({ url: 'about:blank' });
    const resp = await chrome.runtime.sendMessage({
      action: 'watch_nav_goto', tabId: tab.id, videoId, fromVideoId, channelUrl, duration: '3:13'
    });
    await new Promise((r) => setTimeout(r, 400));
    const after = await chrome.storage.local.get(null);
    const pick = (k) => after[k] && after[k].videoId;
    return {
      resp,
      videos: pick(keys.VIDEOS),
      videosType: after[keys.VIDEOS] && after[keys.VIDEOS].type,
      videosDuration: after[keys.VIDEOS] && after[keys.VIDEOS].duration,
      home: pick(keys.HOME),
      shorts: pick(keys.SHORTS),
      streams: pick(keys.STREAMS),
      other: pick(keys.OTHER),
      cache: !!(after[keys.CACHE] && after[keys.CACHE].nav)
    };
  }, {
    seeds: {
      // Same channel's Videos tab, holding a DIFFERENT video: the URL match must
      // still make the spot follow.
      [VIDEOS]: { videoId: 'OLDVID00001', type: 'video', timestamp: 1 },
      // Holds the video we are navigating away from, but is a home page: it must
      // still be left alone, only the Videos tab follows.
      [HOME]: { videoId: FROM, type: 'video', timestamp: 1 },
      // Other pages of this channel and another channel: never touched.
      [SHORTS]: { videoId: 'SHORTVID001', type: 'shorts', timestamp: 1 },
      [STREAMS]: { videoId: 'STREAMVID001', type: 'video', timestamp: 1 },
      [OTHER]: { videoId: 'OTHERVID001', type: 'video', timestamp: 1 },
      [CACHE]: { ts: Date.now(), nav: { videoId: '7dyMnwKPTAg' } }
    },
    keys: { VIDEOS, HOME, SHORTS, STREAMS, OTHER, CACHE },
    fromVideoId: FROM,
    videoId: NEW,
    channelUrl: CHANNEL
  });

  check(result.resp && result.resp.ok, 'background accepted the goto', JSON.stringify(result.resp));
  check(result.videos === NEW, 'the Videos-tab spot follows even if it held another video', result.videos);
  check(result.videosType === 'video' && result.videosDuration === '3:13', 'refreshed entry gets type + duration');
  check(result.home === FROM, 'a home entry holding the current video is still left untouched', result.home);
  check(result.shorts === 'SHORTVID001', 'the Shorts entry is left untouched', result.shorts);
  check(result.streams === 'STREAMVID001', 'another tab of the same channel is left untouched', result.streams);
  check(result.other === 'OTHERVID001', 'a different channel is left untouched', result.other);
  check(result.cache, 'the nav cache is untouched');
} finally {
  await ctx.close();
}

console.log(failures === 0 ? '\nChannel position refresh verified.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
