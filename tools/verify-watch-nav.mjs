// Renders the popup's Current panel for a YouTube watch page and asserts the
// new Prev / Next controls, in both layouts and in the degraded (API failed)
// state. Runs popup.js against a stubbed chrome API — no network, no extension
// install — so it is fast and deterministic.
//
// Run: node tools/verify-watch-nav.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
};

const THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#888"/></svg>');

const WATCH_URL = 'https://www.youtube.com/watch?v=7dyMnwKPTAg';
const NAV = {
  videoId: '7dyMnwKPTAg',
  playlistId: 'UUuAXFkgsw1L7xaCfnd5JJOw',
  index: 295,
  channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  channelUrl: 'https://www.youtube.com/@RickAstleyYT',
  channelUploads: true,
  current: { videoId: '7dyMnwKPTAg', title: 'Rick Astley - Driving Me Crazy (Official Audio)', duration: '3:33', thumbnail: THUMB },
  prev: { videoId: 'DSIaExtrG9k', title: 'Rick Astley - Golden Hour (Official Audio)', duration: '3:46', thumbnail: THUMB },
  next: { videoId: '-2BFZsiVejU', title: 'Rick Astley - Waterfall (Official Audio)', duration: '3:13', thumbnail: THUMB }
};
const NEXT_URL = 'https://www.youtube.com/watch?v=-2BFZsiVejU';
const PREV_URL = 'https://www.youtube.com/watch?v=DSIaExtrG9k';

// Injected before popup.js runs. `env` is serialized into the page, so it must
// carry every value the stub needs (closures are not available in page scope).
function stubChrome(env) {
  const noop = () => {};
  window.__updated = [];
  window.chrome = {
    runtime: {
      lastError: undefined,
      getURL: () => '',
      onMessage: { addListener: noop },
      sendMessage: (msg, cb) => {
        if (msg && msg.action === 'watch_nav_goto') window.__goto = msg;
        const reply = (r) => { if (typeof cb === 'function') cb(r); };
        switch (msg && msg.action) {
          case 'get_watch_nav': return reply(env.navResponse);
          case 'get_extension_enabled': return reply({ enabled: false });
          case 'get_current_tab_position': return reply({ position: null });
          case 'get_positions': return reply({ positions: {} });
          case 'ping': return reply({ status: 'ok' });
          default: return reply({});
        }
      }
    },
    storage: { local: { get: (_k, cb) => cb && cb({ layout: env.layout }), set: (_o, cb) => cb && cb() } },
    tabs: {
      query: (_q, cb) => cb && cb([{ id: 5, url: env.watchUrl, title: 'Rick Astley - Driving Me Crazy (Official Audio) - YouTube' }]),
      update: (id, opts) => { window.__updated.push({ id, url: opts && opts.url }); },
      create: noop
    },
    windows: { create: noop },
    action: { setPopup: noop }
  };
}

const browser = await chromium.launch({ headless: true });
try {
  for (const layout of ['modern', 'classic']) {
    const file = layout === 'modern' ? 'popup.html' : 'popup-classic.html';
    console.log(`\n[${layout}] ${file}`);
    for (const scenario of ['ready', 'failed']) {
      const navResponse = scenario === 'ready' ? { ok: true, nav: NAV } : { ok: false, error: 'boom' };
      const page = await browser.newPage();
      await page.addInitScript(stubChrome, { navResponse, watchUrl: WATCH_URL, layout });
      await page.goto('file://' + join(root, file), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.watch-nav', { timeout: 10000 });

      const state = await page.evaluate(() => {
        const prev = document.querySelector('.watch-nav-arrow.prev');
        const next = document.querySelector('.watch-nav-arrow.next');
        const media = document.querySelector('.watch-nav-media .entry-thumb img');
        return {
          hasNav: !!document.querySelector('.watch-nav'),
          prevIsButton: prev && prev.tagName === 'BUTTON',
          nextIsButton: next && next.tagName === 'BUTTON',
          prevVideo: prev && prev.getAttribute('data-video-id'),
          nextVideo: next && next.getAttribute('data-video-id'),
          prevTitle: prev && prev.getAttribute('title'),
          nextTitle: next && next.getAttribute('title'),
          title: (document.querySelector('.watch-nav-title') || {}).textContent,
          note: (document.querySelector('.watch-nav-note') || {}).textContent,
          thumbVisible: !!(media && media.getBoundingClientRect().width > 50)
        };
      });

      if (scenario === 'ready') {
        check(state.hasNav, 'watch-nav rendered');
        check(state.prevIsButton && state.nextIsButton, 'prev & next are interactive buttons');
        check(state.prevVideo === 'DSIaExtrG9k', 'prev points to newer video', state.prevVideo);
        check(state.nextVideo === '-2BFZsiVejU', 'next points to older video', state.nextVideo);
        check(/Previous:/.test(state.prevTitle) && /Next:/.test(state.nextTitle), 'arrows carry target titles');
        check(/Driving Me Crazy/.test(state.title || ''), 'current title shown', state.title);
        check(/Video 295/.test(state.note || ''), 'channel position shown', state.note);
        check(state.thumbVisible, 'thumbnail has layout size');

        // Clicking Next asks the background to refresh the channel's saved video
        // and navigate the active tab.
        await page.click('.watch-nav-arrow.next');
        const goto = await page.evaluate(() => window.__goto);
        check(!!goto, 'clicking next sends the goto message', JSON.stringify(goto));
        check(goto && goto.videoId === '-2BFZsiVejU', 'goto targets the next video', goto && goto.videoId);
        check(goto && goto.tabId === 5 && goto.duration === '3:13', 'goto carries tab id and duration', JSON.stringify(goto && { tabId: goto.tabId, duration: goto.duration }));
        check(goto && goto.fromVideoId === '7dyMnwKPTAg',
          'goto reports the video being left (logged for diagnostics)', goto && goto.fromVideoId);
        check(goto && goto.channelUrl === 'https://www.youtube.com/@RickAstleyYT',
          'goto sends the channel so its Videos-tab spot can follow', goto && goto.channelUrl);
      } else {
        check(state.hasNav, 'preview still renders when navigation fails');
        check(!state.prevIsButton && !state.nextIsButton, 'arrows disabled in fallback');
        check(/unavailable/i.test(state.note || ''), 'fallback note shown', state.note);
      }

      // The classic layout fades its cards in (up to ~0.9s); let that settle so
      // screenshots are stable and not caught at opacity 0.
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `/tmp/ss-watch-nav-${layout}-${scenario}.png` });
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nAll watch-nav checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
