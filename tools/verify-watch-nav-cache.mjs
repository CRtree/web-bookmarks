// Verifies the watch-nav cache is schema-versioned.
//
// A nav cached by an earlier build can carry a stale channelUploads/channelUrl,
// which makes the popup skip the "refresh the channel's saved video" step. So a
// cache entry without the current schema must be ignored, and the current one
// must be served from cache.
//
// No network: both cases are answered from seeded storage.
// Run: node tools/verify-watch-nav-cache.mjs

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

const VIDEO = 'yhZAXXI83-4';
const CACHE = `yt_nav_${VIDEO}`;

const makeNav = (schema) => {
  const nav = {
    videoId: VIDEO,
    playlistId: 'UUSHZKyawb77ixDdsGog4iWA',
    index: 58,
    current: { videoId: VIDEO, title: 'Adam Frank', duration: '3:26:40', thumbnail: 'https://i.ytimg.com/x.jpg' },
    channelId: 'UCSHZKyawb77ixDdsGog4iWA',
    channelUrl: 'https://www.youtube.com/@lexfridman',
    channelUploads: true,
    prev: { videoId: 'u321m25rKXc', title: 'Prev', duration: '', thumbnail: '' },
    next: { videoId: '9xz8i90Hp2A', title: 'Next', duration: '', thumbnail: '' }
  };
  if (schema) nav.schema = schema;
  return nav;
};

const ext = await mkdtemp(join(tmpdir(), 'ss-cache-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-cache-prof-'));
for (const f of FILES) await cp(join(root, f), join(ext, f));
for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
try {
  const id = unpackedId(await realpath(ext));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await extPage.waitForTimeout(500);

  const result = await extPage.evaluate(async ({ videoId, key, oldNav, newNav }) => {
    const query = (nav) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get_watch_nav', videoId, listId: null, tabId: 999999 }, (r) => resolve(r));
    });

    await chrome.storage.local.clear();
    await chrome.storage.local.set({ [key]: { ts: Date.now(), nav: oldNav } });
    const stale = await query();

    await chrome.storage.local.set({ [key]: { ts: Date.now(), nav: newNav } });
    const fresh = await query();

    return { stale, fresh };
  }, { videoId: VIDEO, key: CACHE, oldNav: makeNav(null), newNav: makeNav(2) });

  check(!(result.stale && result.stale.ok && result.stale.cached),
    'a schema-less cached nav is ignored', JSON.stringify(result.stale));
  check(result.fresh && result.fresh.ok && result.fresh.cached,
    'a current-schema cached nav is served from cache', JSON.stringify(result.fresh));
  check(result.fresh && result.fresh.nav && result.fresh.nav.channelUrl === 'https://www.youtube.com/@lexfridman',
    'served nav keeps the channel url', result.fresh && result.fresh.nav && result.fresh.nav.channelUrl);
} finally {
  await ctx.close();
}

console.log(failures === 0 ? '\nWatch-nav cache versioning verified.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
