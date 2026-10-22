// Verifies a hard page load restores an off-screen video by scanning directly,
// without forcing the extra page refresh that used to double every visit.
//
// The fixture hides the saved card until the scan scrolls to the bottom, which is
// exactly the case that used to trigger the pre-scan reload. A reload is detected
// by counting main-frame navigations (the initial goto is 1) and by the
// sessionStorage marker the reload path writes.
//
// No network: the channel page is a local fixture.
// Run: node tools/verify-restore-refresh.mjs

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

const CHANNEL = 'https://www.youtube.com/@refreshtest';
const VIDEO = 'TARGETVID01';

// Four cards (~800px) then a tall spacer, so the saved card is far off-screen.
// Scrolling to the bottom appends the target card and another spacer, mimicking
// YouTube's infinite-scroll grid. The target never exists during the initial DOM.
const fixture = `<!doctype html><html><head>
<style>body{margin:0}</style>
</head><body>
<div id="cards"></div>
<div style="height:2000px"></div>
<div id="more"></div>
<div style="height:800px"></div>
<script>
  function card(id) {
    return '<ytd-rich-item-renderer><a href="/watch?v=' + id + '">' +
      '<div style="height:200px">' + id + '</div></a></ytd-rich-item-renderer>';
  }
  var cards = document.getElementById('cards');
  for (var i = 0; i < 4; i++) cards.insertAdjacentHTML('beforeend', card('INITVID000' + i));
  var loaded = false;
  addEventListener('scroll', function() {
    if (loaded) return;
    if (scrollY + innerHeight >= document.body.scrollHeight - 100) {
      loaded = true;
      document.getElementById('more').innerHTML = card('${VIDEO}');
      document.body.insertAdjacentHTML('beforeend', '<div style="height:800px"></div>');
    }
  });
</script>
</body></html>`;

const ext = await mkdtemp(join(tmpdir(), 'ss-refresh-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-refresh-prof-'));
for (const f of FILES) await cp(join(root, f), join(ext, f));
for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});

try {
  await ctx.route('https://www.youtube.com/@refreshtest**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));

  const id = unpackedId(await realpath(ext));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await extPage.waitForTimeout(400);
  await extPage.evaluate(async ({ CHANNEL, VIDEO }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      enabled_sites: { [CHANNEL]: true },
      ['yt_position_' + CHANNEL]: { videoId: VIDEO, type: 'video', timestamp: Date.now() }
    });
  }, { CHANNEL, VIDEO });
  await extPage.close();

  const page = await ctx.newPage();
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });

  await page.goto(CHANNEL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const navsAfterLoad = navigations;

  // Wait for the scan to reveal the hidden target and scroll to it.
  let state = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    state = await page.evaluate((video) => {
      const link = document.querySelector(`a[href*="/watch?v=${video}"]`);
      const target = link && link.closest('ytd-rich-item-renderer');
      const rect = target ? target.getBoundingClientRect() : null;
      return {
        scrollY: Math.round(window.scrollY),
        target: !!target,
        targetTop: rect ? Math.round(rect.top) : null,
        markers: Object.keys(sessionStorage).filter((k) => k.startsWith('ss_scan_reload_')),
      };
    }, VIDEO);
    if (state.scrollY > 2000) break;
  }

  console.log('\nhard page load');
  check(navsAfterLoad === 1, 'initial load is a single navigation', String(navsAfterLoad));
  check(navigations === 1, 'restore did not reload the page', `navigations=${navigations}`);
  check(state.markers.length === 0, 'no refresh marker was written', JSON.stringify(state.markers));
  check(state.target === true, 'scan loaded the saved card', JSON.stringify(state));
  check(state.scrollY > 2000, 'restore scrolled to the saved card without a refresh', JSON.stringify(state));
} finally {
  await ctx.close();
}

console.log(failures === 0
  ? '\nRestore works on a fresh load without the forced refresh.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
