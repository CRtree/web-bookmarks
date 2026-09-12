// Validates extension localization.
//
// The item NAME is hardcoded in manifest.json and intentionally not localized.
// Only the summary (description) is localized via __MSG_description__.
//
//  1. Static  — every _locales/<code> folder uses a code Chrome actually supports,
//               each messages.json parses and defines `description`, the description
//               stays within the 132-char store summary limit, and the manifest name
//               is a literal string (not a __MSG_name__ reference).
//  2. Runtime — the extension loads in Chromium, the name comes through verbatim, and
//               __MSG_description__ resolves to a real localized string (never a raw
//               __MSG_ token), falling back to default_locale when the app locale has
//               no folder.
//
// Localized `name` values are reported as INACTIVE: they only take effect if
// manifest.json switches to "name": "__MSG_name__".
//
// Run: node tools/verify-i18n.mjs
//
// Note: headless_shell (Playwright's default headless) cannot load extensions, so
// this uses channel:'chromium'. --lang is ignored for the app locale on macOS, so
// the runtime check asserts against whatever locale Chromium actually reports.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, rm, readdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(root, '_locales');

// From https://developer.chrome.com/docs/extensions/reference/api/i18n
const SUPPORTED = new Set(`ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr
gu he hi hr hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk
vi zh_CN zh_TW`.split(/\s+/).filter(Boolean));

const DESC_LIMIT = 132; // Chrome Web Store item summary limit

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ❌ ${msg}`); };

// ---------------------------------------------------------------- static pass
console.log('── static validation ──────────────────────────────────────────');

const folders = (await readdir(LOCALES_DIR, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const defaultLocale = manifest.default_locale;

if (!defaultLocale) fail('manifest.json has no default_locale');
if (typeof manifest.name !== 'string' || manifest.name.startsWith('__MSG_')) {
  fail(`manifest.name is "${manifest.name}" — expected a hardcoded string (name is intentionally not localized)`);
} else {
  console.log(`  ✅ name (hardcoded, not localized): "${manifest.name}"`);
}
if (manifest.description !== '__MSG_description__') fail('manifest.description should be "__MSG_description__"');
if (defaultLocale && !folders.includes(defaultLocale)) fail(`default_locale "${defaultLocale}" has no _locales folder`);

const messages = {};
let hasInactiveNames = false;
for (const code of folders) {
  if (!SUPPORTED.has(code)) {
    fail(`${code}: not a valid Chrome locale code (will be silently ignored by Chrome)`);
    continue;
  }
  try {
    const json = JSON.parse(await readFile(join(LOCALES_DIR, code, 'messages.json'), 'utf8'));
    messages[code] = json;
    if (!json.description?.message) fail(`${code}: missing "description" message`);
    if (json.name?.message) hasInactiveNames = true;
    const d = json.description?.message ?? '';
    if (d.length > DESC_LIMIT) fail(`${code}: description is ${d.length} chars (limit ${DESC_LIMIT})`);
    else console.log(`  ✅ ${code.padEnd(6)} desc=${d.length}c`);
  } catch (err) {
    fail(`${code}: ${err.message}`);
  }
}

if (hasInactiveNames) {
  console.log('  ℹ️  localized `name` values present but INACTIVE (manifest name is hardcoded)');
}

/** Chrome's lookup order: exact code -> parent locale -> default_locale. */
function expectedFor(code) {
  const parent = code.split('_')[0];
  for (const c of [code, parent, defaultLocale, 'en']) {
    if (c && messages[c]) return messages[c];
  }
  return null;
}

// --------------------------------------------------------------- runtime pass
console.log('\n── runtime validation ─────────────────────────────────────────');

const PROBE = `document.documentElement.setAttribute('data-ss-probe', JSON.stringify({
  name: chrome.runtime.getManifest().name,
  desc: chrome.runtime.getManifest().description,
  ui: chrome.i18n.getMessage('@@ui_locale')
}));`;

const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>probe</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const ext = await mkdtemp(join(tmpdir(), 'ss-ext-'));
const profile = await mkdtemp(join(tmpdir(), 'ss-profile-'));
let ctx;

try {
  for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js', 'LICENSE']) {
    await cp(join(root, f), join(ext, f));
  }
  for (const d of ['icons', '_locales']) await cp(join(root, d), join(ext, d), { recursive: true });
  await writeFile(join(ext, '__probe.js'), PROBE);

  const mf = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  mf.content_scripts[0].js.unshift('__probe.js');
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-ss-probe'),
    null,
    { timeout: 15000 },
  );

  const info = JSON.parse(await page.getAttribute('html', 'data-ss-probe'));
  const expected = expectedFor(info.ui);

  console.log(`  ui_locale : ${info.ui}`);
  console.log(`  name      : ${info.name}`);
  console.log(`  summary   : ${info.desc}`);

  if (/__MSG_/.test(info.name) || /__MSG_/.test(info.desc)) {
    fail('unresolved __MSG_ token in resolved manifest');
  } else if (!info.name || !info.desc) {
    fail('resolved manifest name/description is empty');
  } else if (info.name !== manifest.name) {
    fail(`name should not be localized: got "${info.name}", expected "${manifest.name}"`);
  } else if (expected && info.desc !== expected.description.message) {
    fail(`summary mismatch for ${info.ui}: got "${info.desc}", expected "${expected.description.message}"`);
  } else {
    console.log(`  ✅ name hardcoded + summary resolved for "${info.ui}"`);
  }
} catch (err) {
  fail(`runtime check: ${err.message.split('\n')[0]}`);
} finally {
  if (ctx) await ctx.close();
  await rm(ext, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  server.close();
}

console.log(failures === 0 ? '\n🎉 all localization checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
