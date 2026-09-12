// End-to-end test for the popup layout toggle and video previews.
//
// Loads the real extension in Chromium and asserts:
//   - the manifest's default_popup opens the classic layout with no redirect
//   - toggling switches layout, persists it, and repoints chrome.action.setPopup
//   - reopening the toolbar popup self-heals to the stored layout
//   - previews are always on, with no toggle control anywhere
//   - thumbnails load from the CDN, duration badges render, and failures degrade
//
// Run: node tools/verify-layout.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, rm, cp, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
};

/** Chrome's unpacked-extension ID: sha256(path) -> first 32 hex digits mapped 0-15 => a-p */
function unpackedId(absPath) {
  const hex = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css',
               'popup-classic.html', 'popup-classic.css', 'popup.js', 'LICENSE'];

const ext = await mkdtemp(join(tmpdir(), 'ss-lay-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-lay-prof-'));
const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>probe</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const probeUrl = `http://127.0.0.1:${server.address().port}/`;

let ctx;
try {
  for (const f of FILES) await cp(join(root, f), join(ext, f));
  for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

  // Probe content script so we can read chrome.runtime.id from a page context.
  await writeFile(join(ext, '__probe.js'),
    `document.documentElement.setAttribute('data-ext-id', chrome.runtime.id);`);
  const mf = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  mf.content_scripts[0].js.unshift('__probe.js');
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

  const defaultPopup = mf.action.default_popup;
  const otherPage = defaultPopup === 'popup-classic.html' ? 'popup.html' : 'popup-classic.html';
  // Derive the expected layout from the manifest so flipping the default does not
  // silently invalidate this test.
  const expectedDefault = defaultPopup === 'popup-classic.html' ? 'classic' : 'modern';
  const expectedMarkup = expectedDefault === 'classic' ? '.masthead' : '.app';

  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

  const probe = await ctx.newPage();
  await probe.goto(probeUrl, { waitUntil: 'domcontentloaded' });
  await probe.waitForFunction(() => document.documentElement.hasAttribute('data-ext-id'), null, { timeout: 15000 });
  const id = await probe.getAttribute('html', 'data-ext-id');
  await probe.close();
  check(id === unpackedId(await realpath(ext)), 'extension loaded', `id=${id}`);

  const open = async (file) => {
    const p = await ctx.newPage();
    await p.bringToFront();
    await p.goto(`chrome-extension://${id}/${file}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    return p;
  };
  const storedLayout = (p) => p.evaluate(() => new Promise((r) =>
    chrome.storage.local.get(['layout'], (v) => r(v.layout))));

  // ---- 1. A plain toolbar open lands on the manifest default ----
  console.log(`\ndefault popup (${defaultPopup})`);
  check(defaultPopup === 'popup.html' || defaultPopup === 'popup-classic.html',
    'manifest default_popup is one of the two layouts', defaultPopup);

  let page = await open(defaultPopup);
  check(page.url().endsWith(defaultPopup), 'no redirect on first open', page.url().split('/').pop());
  let layout = await page.evaluate(() => document.body.dataset.layout);
  check(layout === expectedDefault, `${expectedDefault} is the default layout`, layout);
  check(await page.locator(expectedMarkup).count() === 1, `${expectedDefault} markup present`);
  check(await storedLayout(page) === expectedDefault, `default persisted as "${expectedDefault}"`);

  // ---- 2. Previews are always on, with no toggle ----
  console.log('\nvideo previews (always on)');
  check(await page.locator('#preview-toggle').count() === 0, 'no preview toggle in the default layout');

  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({
    'yt_position_https://www.youtube.com/@testchannel/videos': {
      videoId: 'EVu1pi2LE50', type: 'video', timestamp: Date.now(), duration: '19:49',
    },
  }, r)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(700);

  check(await page.locator('#positions-list .entry-thumb').count() === 1, 'thumbnail renders with no opt-in');
  check((await page.locator('.entry-duration').first().textContent()) === '19:49', 'duration badge rendered');

  // Images are inserted via innerHTML with loading="lazy" — poll, don't sleep.
  await page.waitForFunction(() => {
    const el = document.querySelector('#positions-list .entry-thumb img');
    return !!el && el.complete && el.naturalWidth > 0;
  }, null, { timeout: 10000 }).catch(() => {});
  const img = await page.evaluate(() => {
    const el = document.querySelector('#positions-list .entry-thumb img');
    return el ? { complete: el.complete, w: el.naturalWidth } : null;
  });
  check(img && img.w === 320, 'thumbnail actually loads from i.ytimg.com', JSON.stringify(img));

  // ---- 3. Failure fallback ----
  // i.ytimg.com answers a deleted video with 404 + a valid placeholder JPEG, so the
  // generic error path is exercised directly rather than relying on the CDN.
  const fallback = await page.evaluate(() => {
    const el = document.querySelector('#positions-list .entry-thumb img');
    if (!el) return null;
    el.dispatchEvent(new Event('error'));
    const thumb = el.closest('.entry-thumb');
    const entry = el.closest('.entry');
    return {
      thumbHidden: getComputedStyle(thumb).display === 'none',
      entryNoThumb: entry.classList.contains('no-thumb'),
      entryDisplay: getComputedStyle(entry).display,
    };
  });
  const expectedDisplay = expectedDefault === 'classic' ? 'block' : 'flex';
  check(fallback?.thumbHidden, 'a failed thumbnail is hidden', JSON.stringify(fallback));
  check(fallback?.entryNoThumb, 'entry marked .no-thumb', JSON.stringify(fallback));
  check(fallback?.entryDisplay === expectedDisplay,
    `${expectedDefault}: entry falls back to ${expectedDisplay} (no empty preview column)`,
    fallback?.entryDisplay);

  // ---- 4. Toggling to the other layout ----
  console.log(`\ntoggling to ${otherPage}`);
  const storedBefore = await storedLayout(page);
  await page.locator('#layout-toggle').click();
  await page.waitForURL(new RegExp(otherPage.replace('.', '\\.')), { timeout: 5000 });
  await page.waitForTimeout(600);

  check(page.url().endsWith(otherPage), `navigated to ${otherPage}`, page.url().split('/').pop());
  const newLayout = await page.evaluate(() => document.body.dataset.layout);
  check(newLayout !== layout, 'layout actually changed', `${storedBefore} -> ${newLayout}`);
  check(await storedLayout(page) === newLayout, 'new preference persisted', newLayout);

  const popupTarget = await page.evaluate(() => new Promise((r) => chrome.action.getPopup({}, (v) => r(v))));
  check(popupTarget.endsWith(otherPage), 'action popup repointed', String(popupTarget));
  check(await page.locator('#preview-toggle').count() === 0,
    `no preview toggle in the ${newLayout} layout either`);

  // Classic-specific layout guarantees. Whichever page classic happens to be, its
  // entries use a preview grid that must collapse when a thumbnail is missing —
  // otherwise the row keeps an empty 96px column. When classic IS the default this
  // was already covered above; cover it here when classic is the other page.
  if (newLayout === 'classic') {
    const usingGrid = await page.evaluate(() => {
      const e = document.querySelector('#positions-list .entry');
      return e ? getComputedStyle(e).display : null;
    });
    check(usingGrid === 'grid', 'classic: entries use the preview grid', String(usingGrid));

    const dropped = await page.evaluate(() => {
      const img = document.querySelector('#positions-list .entry-thumb img');
      if (!img) return null;
      img.dispatchEvent(new Event('error'));
      const entry = img.closest('.entry');
      return {
        noThumb: entry.classList.contains('no-thumb'),
        display: getComputedStyle(entry).display,
      };
    });
    check(dropped?.noThumb && dropped?.display === 'block',
      'classic: a failed preview drops the row out of the grid', JSON.stringify(dropped));
  }

  // ---- 5. Toolbar open self-heals to the stored layout ----
  console.log('\nreopening the default popup');
  const reopened = await open(defaultPopup);
  await reopened.waitForURL(new RegExp(otherPage.replace('.', '\\.')), { timeout: 5000 }).catch(() => {});
  await reopened.waitForTimeout(500);
  check(await reopened.evaluate(() => document.body.dataset.layout) === newLayout,
    'self-heals to the stored layout');
  await reopened.close();

  // ---- 6. Round trip back ----
  console.log('\ntoggling back');
  await page.locator('#layout-toggle').click();
  await page.waitForURL(new RegExp(defaultPopup.replace('.', '\\.')), { timeout: 5000 });
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.body.dataset.layout) === layout, 'returned to the default layout');
  check(await storedLayout(page) === layout, 'preference restored', layout);

  await page.close();
} catch (err) {
  failures++;
  console.log(`\n❌ ${err.message.split('\n')[0]}`);
} finally {
  if (ctx) await ctx.close();
  await rm(ext, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  server.close();
}

console.log(failures === 0 ? '\n🎉 layout + previews verified end to end' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
