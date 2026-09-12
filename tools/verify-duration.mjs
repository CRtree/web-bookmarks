// Live end-to-end test for duration capture.
//
// Loads the real extension, opens a YouTube channel, dispatches a pointerdown on
// a video card (which is what content.js listens for), then asserts the entry it
// wrote to chrome.storage.local has a videoId AND a duration matching the card's
// own badge.
//
// Requires network access to youtube.com.
// Run: node tools/verify-duration.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL = 'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
};

const ext = await mkdtemp(join(tmpdir(), 'ss-dur-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-dur-prof-'));
const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>probe</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const probeUrl = `http://127.0.0.1:${server.address().port}/`;

let ctx;
try {
  for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css',
                   'popup-classic.html', 'popup-classic.css', 'popup.js', 'LICENSE']) {
    await cp(join(root, f), join(ext, f));
  }
  for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

  await writeFile(join(ext, '__probe.js'),
    `document.documentElement.setAttribute('data-ext-id', chrome.runtime.id);`);
  const mf = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  mf.content_scripts[0].js.unshift('__probe.js');
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    locale: 'en-US',
  });

  const probe = await ctx.newPage();
  await probe.goto(probeUrl, { waitUntil: 'domcontentloaded' });
  await probe.waitForFunction(() => document.documentElement.hasAttribute('data-ext-id'), null, { timeout: 15000 });
  const id = await probe.getAttribute('html', 'data-ext-id');
  await probe.close();

  const page = await ctx.newPage();
  await page.goto(CHANNEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  for (const sel of ['button[aria-label*="Accept" i]', 'button[aria-label*="Reject" i]']) {
    const el = page.locator(sel).first();
    if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(2500); break; }
  }
  // Tracking is opt-in per channel, so enable it before the page can attach its
  // click listener. Must be done from an extension context.
  const enabler = await ctx.newPage();
  await enabler.goto(`chrome-extension://${id}/popup-classic.html`, { waitUntil: 'domcontentloaded' });
  await enabler.waitForTimeout(400);
  const enabled = await enabler.evaluate((url) => new Promise((r) =>
    chrome.runtime.sendMessage({ action: 'set_extension_enabled', url, enabled: true },
      (resp) => r(chrome.runtime.lastError ? String(chrome.runtime.lastError) : resp))), CHANNEL);
  await enabler.close();
  check(enabled && enabled.success !== false, 'channel enabled for tracking', JSON.stringify(enabled));

  // Reload so content.js re-inits with tracking on.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);

  // Pick a regular video card and read its own badge as ground truth.
  const target = await page.evaluate(() => {
    const CARD = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media';
    for (const a of document.querySelectorAll('a[href*="/watch?v="]')) {
      const m = (a.getAttribute('href') || '').match(/[?&]v=([^&]+)/);
      if (!m) continue;
      const card = a.closest(CARD);
      const badge = card && card.querySelector('.ytBadgeShapeText, ytd-thumbnail-overlay-time-status-renderer');
      const truth = badge ? badge.textContent.trim() : null;
      if (truth) return { videoId: m[1], truth };
    }
    return null;
  });

  check(!!target, 'found a video card with a duration badge', JSON.stringify(target));
  if (!target) throw new Error('no target card');

  // Dispatch the same event content.js listens for, so we do not navigate away.
  await page.evaluate((videoId) => {
    const a = [...document.querySelectorAll('a[href*="/watch?v="]')]
      .find((el) => (el.getAttribute('href') || '').includes(videoId));
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  }, target.videoId);
  await page.waitForTimeout(1200);

  // chrome.storage is not reachable from the YouTube page's main world, so read
  // it from an extension page instead.
  const reader = await ctx.newPage();
  await reader.goto(`chrome-extension://${id}/popup-classic.html`, { waitUntil: 'domcontentloaded' });
  await reader.waitForTimeout(500);
  const saved = await reader.evaluate(() => new Promise((r) => chrome.storage.local.get(null, (items) => {
    const out = {};
    for (const [k, v] of Object.entries(items)) if (k.startsWith('yt_position_')) out[k] = v;
    r(out);
  })));
  await reader.close();

  const entries = Object.entries(saved);
  check(entries.length === 1, 'one position written', JSON.stringify(saved));

  const [, entry] = entries[0] || [];
  check(entry?.videoId === target.videoId, 'saved videoId matches the clicked card', JSON.stringify(entry));
  check(entry?.duration === target.truth,
    `saved duration matches the card badge (${target.truth})`, JSON.stringify(entry?.duration));
  check(entry?.type === 'video', 'type recorded as video', String(entry?.type));

  console.log(`\n  saved entry: ${JSON.stringify(entry)}`);
} catch (err) {
  failures++;
  console.log(`\n❌ ${err.message.split('\n')[0]}`);
} finally {
  if (ctx) await ctx.close();
  await rm(ext, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  server.close();
}

console.log(failures === 0 ? '\n🎉 duration capture verified live' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
