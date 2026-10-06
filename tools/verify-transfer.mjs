// End-to-end test for saved-list export / import.
//
// Loads the real extension in Chromium and asserts:
//   - "Export" downloads a JSON file with the versioned wrapper and every stored position
//   - the popup's Import control opens the dedicated import window
//   - that window reads a file back, re-enables the imported channels, and reports counts
//   - malformed entries and non-http keys are skipped rather than written
//
// Import deliberately runs outside the action popup: opening the OS file picker
// dismisses the popup and tears down the message port mid-request, so this test
// drives the real import page the button opens.
//
// Run: node tools/verify-transfer.mjs

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

function unpackedId(absPath) {
  const hex = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css',
               'popup-classic.html', 'popup-classic.css', 'popup.js', 'import.html', 'import.js',
               'LICENSE'];

const IMPORT_KEY = 'yt_position_https://www.youtube.com/@importedchannel/videos';
const IMPORT_DURATION = '12:34';

const ext = await mkdtemp(join(tmpdir(), 'ss-xfer-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-xfer-prof-'));
const importFile = join(await mkdtemp(join(tmpdir(), 'ss-xfer-file-')), 'positions.json');

const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>probe</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const probeUrl = `http://127.0.0.1:${server.address().port}/`;

// Two valid entries, plus malformed ones that must be skipped:
//   - a non-http key
//   - a value that is not an object
//   - an entry with no videoId and no scrollY
await writeFile(importFile, JSON.stringify({
  kind: 'youtube-scroll-saver-positions',
  version: 1,
  positions: {
    'https://www.youtube.com/@importedchannel/videos': {
      videoId: 'EVu1pi2LE50', type: 'video', timestamp: 1700000000000, duration: IMPORT_DURATION,
    },
    'https://www.youtube.com/@importedchannel/shorts': {
      videoId: 'vuPgnGoKkcE', type: 'shorts', timestamp: 1700000001000,
    },
    'not-a-url': { videoId: 'junk' },
    'https://www.youtube.com/@bad/videos': 'not-an-object',
    'https://www.youtube.com/@empty/videos': { title: 'no id and no scroll' },
  },
}, null, 2));

let ctx;
try {
  for (const f of FILES) await cp(join(root, f), join(ext, f));
  for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });

  await writeFile(join(ext, '__probe.js'),
    `document.documentElement.setAttribute('data-ext-id', chrome.runtime.id);`);
  const mf = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  mf.content_scripts[0].js.unshift('__probe.js');
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

  const probe = await ctx.newPage();
  await probe.goto(probeUrl, { waitUntil: 'domcontentloaded' });
  await probe.waitForFunction(() => document.documentElement.hasAttribute('data-ext-id'), null, { timeout: 15000 });
  const id = await probe.getAttribute('html', 'data-ext-id');
  await probe.close();
  check(id === unpackedId(await realpath(ext)), 'extension loaded', `id=${id}`);

  const openPopup = async () => {
    const p = await ctx.newPage();
    await p.bringToFront();
    await p.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(500);
    return p;
  };

  let page = await openPopup();

  // Seed two positions and an existing channel enablement to export / preserve.
  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({
    'yt_position_https://www.youtube.com/@alpha/videos': {
      videoId: 'EVu1pi2LE50', type: 'video', timestamp: 1700000000000, duration: '19:49',
    },
    'yt_position_https://www.youtube.com/@beta/shorts': {
      videoId: 'vuPgnGoKkcE', type: 'shorts', timestamp: 1700000001000,
    },
    enabled_sites: { 'https://www.youtube.com/@alpha': true },
  }, r)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(500);

  // ---- Export ----
  console.log('\nexport');
  check(await page.locator('#export-positions').count() === 1, 'Export control present');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator('#export-positions').click(),
  ]);
  check(/^scroll-saver-positions-.*\.json$/.test(download.suggestedFilename()),
    'download is a dated JSON file', download.suggestedFilename());

  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  check(exported.kind === 'youtube-scroll-saver-positions', 'wrapper carries the kind tag', String(exported.kind));
  check(exported.version === 1, 'wrapper carries a version', String(exported.version));
  check(Object.keys(exported.positions || {}).length === 2, 'both positions exported',
    String(Object.keys(exported.positions || {}).length));
  check(exported.positions['https://www.youtube.com/@beta/shorts']?.type === 'shorts',
    'entry fields round-trip', JSON.stringify(exported.positions['https://www.youtube.com/@beta/shorts']));

  // ---- Import ----
  // The popup button must open the dedicated window, not open a file picker in
  // the popup (which would be dismissed with the message port still open).
  console.log('\nimport');
  check(await page.locator('#import-positions').count() === 1, 'Import control present');
  const [importWin] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 10000 }),
    page.locator('#import-positions').click(),
  ]);
  await importWin.waitForLoadState('domcontentloaded');
  await importWin.bringToFront();
  check(importWin.url().endsWith('import.html'), 'Import opens the dedicated window', importWin.url());
  check(await importWin.locator('#file').count() === 1, 'import window has a file input');

  await importWin.setInputFiles('#file', importFile);
  await importWin.waitForSelector('#state-success:not([hidden])', { timeout: 10000 }).catch(() => {});

  check(await importWin.locator('#state-success').isVisible(), 'success state shown after import');
  check((await importWin.locator('#imported-count').textContent()).trim() === '2',
    'success state shows the imported count', await importWin.locator('#imported-count').textContent());
  check(/positions imported/.test(await importWin.locator('#imported-label').textContent()),
    'success state labels the count');
  check(/3 invalid entries were skipped/.test(await importWin.locator('#success-detail').textContent()),
    'success state reports skipped entries', await importWin.locator('#success-detail').textContent());
  check(await importWin.locator('#close').isVisible(), 'Done button appears after import');

  const after = await importWin.evaluate(() => new Promise((r) => chrome.storage.local.get(null, r)));
  const imported = after[IMPORT_KEY];
  check(!!imported, 'valid entry written to storage');
  check(imported?.duration === IMPORT_DURATION, 'duration preserved on import', JSON.stringify(imported));
  check(after['yt_position_https://www.youtube.com/@bad/videos'] === undefined,
    'non-object entry skipped');
  check(after['yt_position_https://www.youtube.com/@empty/videos'] === undefined,
    'entry without videoId/scrollY skipped');
  check(after['yt_position_not-a-url'] === undefined, 'non-http key skipped');
  check(after['yt_position_https://www.youtube.com/@alpha/videos'] !== undefined,
    'merge keeps existing positions');

  const enabled = after.enabled_sites || {};
  check(enabled['https://www.youtube.com/@importedchannel'] === true,
    'imported channel enabled at its root', JSON.stringify(Object.keys(enabled)));
  check(enabled['https://www.youtube.com/@alpha'] === true,
    'pre-existing channel enablement untouched');

  // A bad file must land on the error state, and "Import another file" resets.
  await importWin.locator('#again').click();
  check(await importWin.locator('#state-idle').isVisible(), 'reset returns to the idle state');
  await writeFile(importFile, '{ this is not json');
  await importWin.setInputFiles('#file', importFile);
  await importWin.waitForSelector('#state-error:not([hidden])', { timeout: 10000 }).catch(() => {});
  check(await importWin.locator('#state-error').isVisible(), 'error state shown for a bad file');
  check(/not valid JSON/.test(await importWin.locator('#error-detail').textContent()),
    'error state explains the problem', await importWin.locator('#error-detail').textContent());

  await importWin.close();

  // The stored list reflects the import on the next popup open.
  page = await openPopup();
  check((await page.evaluate(() => document.querySelectorAll('#positions-list .entry').length)) === 4,
    'stored list reflects the import on reopen');
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

console.log(failures === 0 ? '\n🎉 export + import verified end to end' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
