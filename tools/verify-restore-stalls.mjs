// Verifies the restore scan survives intermittent lazy-load stalls.
//
// The old scan gave up after 20 *cumulative* no-growth polls. A long channel
// with a few slow batches could therefore abort at the bottom of the loaded
// list and report a saved video as missing. This fixture stalls for two polls,
// grows for one, and repeats — 21 stalls in total, but never more than two in a
// row. The target only appears on the 21st stall, after the old cumulative cap.
//
// No network: the channel page is a local fixture.
// Run: node tools/verify-restore-stalls.mjs

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

const CHANNEL = 'https://www.youtube.com/@stalltest';
const ROOT = 'https://www.youtube.com/@stalltest';
const VIDEO = 'STALLTARGET';

// Two no-growth polls, then a 400px growth. On the 21st poll, add the target.
const fixture = `<!doctype html><html><head>
<style>body{margin:0}</style>
</head><body>
<div style="height:800px"></div>
<script>
  var polls = 0;
  var lastAt = 0;
  var added = false;
  function addTarget() {
    document.body.insertAdjacentHTML('beforeend',
      '<ytd-rich-item-renderer><a href="/watch?v=${VIDEO}">' +
      '<div style="height:200px">target</div></a></ytd-rich-item-renderer>');
  }
  addEventListener('scroll', function() {
    if (scrollY + innerHeight < document.documentElement.scrollHeight - 100) return;
    var now = Date.now();
    if (now - lastAt < 300) return;
    lastAt = now;
    polls++;
    if (polls % 3 !== 0) return; // stall
    if (polls >= 21) {
      if (!added) { added = true; addTarget(); }
      return;
    }
    document.body.insertAdjacentHTML('beforeend', '<div style="height:400px"></div>');
  });
</script>
</body></html>`;

const ext = await mkdtemp(join(tmpdir(), 'ss-stall-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-stall-prof-'));
for (const f of FILES) await cp(join(root, f), join(ext, f));
for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});

try {
  await ctx.route('https://www.youtube.com/@stalltest**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));

  const id = unpackedId(await realpath(ext));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await extPage.waitForTimeout(400);
  await extPage.evaluate(async ({ CHANNEL, ROOT, VIDEO }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      enabled_sites: { [ROOT]: true },
      ['yt_position_' + CHANNEL]: { videoId: VIDEO, type: 'video', timestamp: Date.now() }
    });
  }, { CHANNEL, ROOT, VIDEO });
  await extPage.close();

  const page = await ctx.newPage();
  await page.goto(CHANNEL, { waitUntil: 'domcontentloaded' });

  // The target appears after 21 polls (~21s); allow for the 3s start delay.
  let state = null;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1000);
    state = await page.evaluate((video) => {
      const link = document.querySelector(`a[href*="v=${video}"]`);
      const card = link && link.closest('ytd-rich-item-renderer');
      const rect = card ? card.getBoundingClientRect() : null;
      return {
        scrollY: Math.round(scrollY),
        height: document.documentElement.scrollHeight,
        target: !!card,
        targetTop: rect ? Math.round(rect.top) : null,
      };
    }, VIDEO);
    if (state.target && state.scrollY > 1000) break;
  }

  console.log('\nintermittent lazy-load stalls');
  check(state.target === true, 'scan kept going past the old cumulative stall cap', JSON.stringify(state));
  check(state.scrollY > 1000, 'restore scrolled to the saved card', JSON.stringify(state));
  check(state.targetTop !== null && state.targetTop > -100 && state.targetTop < 900,
    'saved card is in view', JSON.stringify(state));
} finally {
  await ctx.close();
}

console.log(failures === 0
  ? '\nScan survives intermittent lazy-load stalls.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
