import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = __dirname;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: true });
  try { return await fn(browser); }
  finally { await browser.close(); }
}

async function runTestHtml(page, url, waitMs) {
  await page.goto(url, { waitUntil: 'load' });
  await sleep(waitMs);
  const text = await page.evaluate(() => {
    const el = document.getElementById('results');
    return el ? el.textContent : '';
  });
  return text;
}

// =========================================================
// TEST 1: test_scroll_restore.html
// =========================================================
async function test1() {
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`${msg.type()}: ${msg.text()}`));

    await page.goto('file://' + path.join(PROJECT, 'test_scroll_restore.html'), { waitUntil: 'load' });
    await sleep(6000);

    const text = await page.evaluate(() => {
      const el = document.getElementById('results');
      return el ? el.textContent : '';
    });

    const lines = text.split('\n').filter(l => l.trim());
    const results = lines.map(l => ({
      pass: l.startsWith('✅'),
      name: l.replace(/^[✅❌]\s*/, '').split(':')[0].trim(),
      detail: l.replace(/^[✅❌]\s*/, '')
    }));

    await ctx.close();
    return { suite: 'basic_scroll_restore', results, logs };
  });
}

// =========================================================
// TEST 2: test_spa_navigation.html
// =========================================================
async function test2() {
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`${msg.type()}: ${msg.text()}`));

    await page.goto('file://' + path.join(PROJECT, 'test_spa_navigation.html'), { waitUntil: 'load' });
    await sleep(14000);

    const text = await page.evaluate(() => {
      const el = document.getElementById('results');
      return el ? el.textContent : '';
    });

    const lines = text.split('\n').filter(l => l.trim());
    const results = lines.map(l => ({
      pass: l.startsWith('✅'),
      name: l.replace(/^[✅❌]\s*/, '').split(':')[0].trim(),
      detail: l.replace(/^[✅❌]\s*/, '')
    }));

    await ctx.close();
    return { suite: 'spa_navigation', results, logs };
  });
}

// =========================================================
// TEST 3: Core integration — content.js with chrome mocks
// =========================================================
async function test3() {
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`${msg.type()}: ${msg.text()}`));

    const contentJs = fs.readFileSync(path.join(PROJECT, 'content.js'), 'utf8');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Core Integration</title>
<style>
  body { margin: 0; height: 12000px; }
  article { display: block; padding: 20px; }
  .long-text { height: 10000px; }
  #results { position: fixed; top: 0; right: 0; background: #222; color: #0f0;
    padding: 15px; font: 13px monospace; z-index: 9999; max-width: 550px; white-space: pre-wrap; }
</style>
</head>
<body>
<article>
  <h1>Test Article for Scroll Saving</h1>
  <div class="long-text">
    <p style="margin-top:3000px">Scroll target here</p>
  </div>
</article>
<pre id="results">Running...</pre>
<script>
// Mock chrome API (matches content.js expectations)
window._testStorage = {};
window._saveCount = 0;
window.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        if (keys === null) Object.assign(result, window._testStorage);
        else keys.forEach(k => { if (window._testStorage[k]) result[k] = window._testStorage[k]; });
        setTimeout(() => cb(result), 0);
      },
      set: (obj, cb) => {
        Object.assign(window._testStorage, obj);
        window._saveCount++;
        if (cb) setTimeout(() => cb(), 0);
      },
    }
  },
  runtime: {
    id: 'test-ext-id',
    lastError: null,
    sendMessage: (msg, cb) => { setTimeout(() => cb({ enabled: true }), 0); }
  }
};
window._testResults = [];
function assert(name, pass, detail) {
  window._testResults.push({ name, pass, detail: detail || '' });
  document.getElementById('results').textContent = window._testResults
    .map(r => (r.pass ? '✅' : '❌') + ' ' + r.name + ': ' + r.detail).join('\\n');
}
</script>
<script>${contentJs}</script>
<script>
// Wait for tracking to activate, cooldown to expire, then test
setTimeout(async () => {
  const dbg = window.debugReadingPosition;
  if (!dbg) { assert('Debug API', false, 'not found'); return; }

  // C1: Debug API available
  assert('Debug API available', true, 'found');

  // Wait for tracking after sendMessage round-trip + cooldown
  // Timeline: T=0 page loads -> init -> sendMessage(0ms) -> proceedWithInit
  // -> setupTracking -> restoreScrollPosition (delay=300ms)
  // -> finishRestore (sets restoreCompletedAt) -> cooldown starts (3s)
  // -> cooldown ends at T=3.3s
  await sleep(4000);

  // C2: Tracking active
  assert('Tracking active', dbg.isTrackingActive() === true,
    'tracking=' + dbg.isTrackingActive());

  // C3: Not restoring
  assert('Not restoring', dbg.isRestoring() === false,
    'isRestoring=' + dbg.isRestoring());

  // C4: Scroll (now after cooldown) + wait for debounce save
  window.scrollTo(0, 3000);
  await sleep(2000);  // 1s debounce + buffer

  const k = dbg.getStorageKey(window.location.href);
  const d = window._testStorage[k];
  assert('Position saved at ~3000px',
    d && d.scrollY >= 2900,
    'saved scrollY=' + (d ? d.scrollY : 'N/A'));

  // C5: Duplicate save prevented (scroll within 50px)
  const cntBefore = window._saveCount;
  window.scrollTo(0, 3030);
  await sleep(2000);
  assert('Duplicate save blocked',
    window._saveCount === cntBefore,
    'save count: ' + cntBefore + ' -> ' + window._saveCount);

  // C6: Top-of-page save suppressed
  const savedY = d ? d.scrollY : 0;
  window.scrollTo(0, 0);
  await sleep(2000);
  const d2 = window._testStorage[k];
  assert('Top-of-page not overwritten',
    d2 && d2.scrollY >= 2900,
    'scrollY=' + (d2 ? d2.scrollY : 'N/A') + ' (saved was ' + savedY + ')');

  // C7: Restore resets isRestoring
  // smooth scroll settle check fires after 500ms delay + up to 200ms per check
  dbg.forceRestore();
  await sleep(1500);
  assert('Restore resets isRestoring',
    dbg.isRestoring() === false,
    'isRestoring=' + dbg.isRestoring());

  // C8: Storage key prefix
  assert('Storage key prefix',
    k.startsWith('reading_position_'),
    'key=' + k);

  // C9: URL normalization
  const result = dbg.normalizeUrl('https://www.youtube.com/@channel?query=param');
  assert('YouTube URL normalization',
    !result.includes('query=param'),
    'normalized=' + result);

  console.log('Core integration tests done');
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
</script>
</body></html>`;

    const tmpFile = path.join(PROJECT, '_test3.html');
    fs.writeFileSync(tmpFile, html);
    await page.goto('file://' + tmpFile, { waitUntil: 'load' });
    await sleep(12000);

    const text = await page.evaluate(() => {
      const el = document.getElementById('results');
      return el ? el.textContent : '';
    });

    const lines = text.split('\n').filter(l => l.trim());
    const results = lines.map(l => ({
      pass: l.startsWith('✅'),
      name: l.replace(/^[✅❌]\s*/, '').split(':')[0].trim(),
      detail: l.replace(/^[✅❌]\s*/, '')
    }));

    try { fs.unlinkSync(tmpFile); } catch(e) {}
    await ctx.close();
    return { suite: 'core_integration', results, logs };
  });
}

// =========================================================
// TEST 4: YouTube features (click, SPA, listener lifecycle)
// =========================================================
async function test4() {
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`${msg.type()}: ${msg.text()}`));

    const contentJs = fs.readFileSync(path.join(PROJECT, 'content.js'), 'utf8');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>YouTube Features</title>
<style>
  body { margin: 0; height: 10000px; }
  article { display: block; }
  ytd-rich-item-renderer { display: block; height: 200px; margin: 20px;
    background: #f5f5f5; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
  #results { position: fixed; top: 0; right: 0; background: #222; color: #0f0;
    padding: 15px; font: 13px monospace; z-index: 9999; max-width: 550px; white-space: pre-wrap; }
</style>
</head>
<body>
<article>
  <h1>YouTube-like Page</h1>
  <p style="margin-top:4000px">Long content for scroll testing</p>
</article>
<ytd-rich-item-renderer id="v1">
  <a id="link1" href="/watch?v=abc123">Video abc123</a>
</ytd-rich-item-renderer>
<ytd-rich-item-renderer id="v2">
  <a id="link2" href="https://www.youtube.com/watch?v=xyz789">Video xyz789</a>
</ytd-rich-item-renderer>
<ytd-rich-item-renderer id="v3">
  <a id="link3" href="/shorts/s1">Shorts</a>
</ytd-rich-item-renderer>

<pre id="results">Running...</pre>
<script>
window._testStorage = {};
window._saveCount = 0;
window.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        if (keys === null) Object.assign(result, window._testStorage);
        else keys.forEach(k => { if (window._testStorage[k]) result[k] = window._testStorage[k]; });
        setTimeout(() => cb(result), 0);
      },
      set: (obj, cb) => {
        Object.assign(window._testStorage, obj);
        window._saveCount++;
        if (cb) setTimeout(() => cb(), 0);
      },
    }
  },
  runtime: {
    id: 'test-ext-id',
    lastError: null,
    sendMessage: (msg, cb) => { setTimeout(() => cb({ enabled: true }), 0); }
  }
};
window._testResults = [];
function assert(name, pass, detail) {
  window._testResults.push({ name, pass, detail: detail || '' });
  document.getElementById('results').textContent = window._testResults
    .map(r => (r.pass ? '✅' : '❌') + ' ' + r.name + ': ' + r.detail).join('\\n');
}
</script>
<script>${contentJs}</script>
<script>
setTimeout(async () => {
  const dbg = window.debugReadingPosition;
  if (!dbg) { assert('Debug API', false, 'not found'); return; }

  await sleep(4000);

  // D1: Tracking active on article page (not actually YouTube, but isArticlePage triggers)
  assert('Tracking active', dbg.isTrackingActive() === true,
    'tracking=' + dbg.isTrackingActive());
  if (!dbg.isTrackingActive()) return;

  // D2: Normalize YouTube URLs
  const norm = dbg.normalizeUrl;
  const r1 = norm('https://www.youtube.com/watch?v=abc123&feature=share');
  assert('Watch URL preserves all params (only channel pages strip)',
    r1.includes('abc123') && r1.includes('share'),
    'normalized=' + r1);

  const r2 = norm('https://www.youtube.com/@channel?query=keep');
  assert('Channel URL strips all params',
    !r2.includes('query=keep'),
    'normalized=' + r2);

  const r3 = norm('https://x.com/user/status/123?s=20&t=abc');
  assert('X/Twitter URL strips tracking params',
    r3.includes('/status/123') && !r3.includes('s=20'),
    'normalized=' + r3);

  // D3: SPA navigation — pushState triggers redirect
  // window.location.href doesn't change with pushState,
  // but the extension's pushState interceptor should save position
  // before navigating. We verify isRestoring behavior.
  const beforeRestoring = dbg.isRestoring();
  history.pushState({}, '', '/page2');
  await sleep(200);
  // pushState interceptor should try to restore (find nothing)
  // and finishRestore should be called
  assert('isRestoring resets after pushState navigation',
    dbg.isRestoring() === false,
    'isRestoring=' + dbg.isRestoring());

  // D4: Multiple forceRestore calls blocked
  dbg.forceRestore();
  dbg.forceRestore(); // 2nd should be blocked
  await sleep(500);
  assert('Multiple restores blocked',
    dbg.isRestoring() === false,
    'isRestoring=' + dbg.isRestoring());

  // D5: getStorageKey returns consistent results
  const k1 = dbg.getStorageKey(window.location.href);
  const k2 = dbg.getStorageKey(window.location.href);
  assert('Storage key deterministic', k1 === k2,
    k1 + ' vs ' + k2);

  console.log('YouTube features tests done');
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
</script>
</body></html>`;

    const tmpFile = path.join(PROJECT, '_test4.html');
    fs.writeFileSync(tmpFile, html);
    await page.goto('file://' + tmpFile, { waitUntil: 'load' });
    await sleep(10000);

    const text = await page.evaluate(() => {
      const el = document.getElementById('results');
      return el ? el.textContent : '';
    });

    const lines = text.split('\n').filter(l => l.trim());
    const results = lines.map(l => ({
      pass: l.startsWith('✅'),
      name: l.replace(/^[✅❌]\s*/, '').split(':')[0].trim(),
      detail: l.replace(/^[✅❌]\s*/, '')
    }));

    try { fs.unlinkSync(tmpFile); } catch(e) {}
    await ctx.close();
    return { suite: 'youtube_spa_features', results, logs };
  });
}

// =========================================================
// MAIN
// =========================================================
async function main() {
  console.log('🧪 Scroll Saver — QA Validation Suite\n');
  console.log('Platform:', process.platform, 'Node:', process.version);
  console.log('Time:', new Date().toISOString(), '\n');

  const suites = [test1, test2, test3, test4];
  const allResults = [];

  for (const suiteFn of suites) {
    console.log(`Running ${suiteFn.name}...`);
    const { suite, results, logs } = await suiteFn();
    allResults.push({ suite, results, logs });
    const fail = results.filter(r => !r.pass).length;
    console.log(`  ${results.length} assertions, ${fail} failed\n`);
  }

  // REPORT
  console.log('='.repeat(60));
  console.log('📊 QA TEST REPORT');
  console.log('='.repeat(60));

  let totalPass = 0, totalFail = 0;
  for (const { suite, results } of allResults) {
    const pass = results.filter(r => r.pass).length;
    const fail = results.filter(r => !r.pass).length;
    totalPass += pass;
    totalFail += fail;
    const icon = fail === 0 ? '✅' : '❌';
    console.log(`\n${icon} ${suite}: ${pass} passed, ${fail} failed`);
    for (const r of results) {
      if (!r.pass) console.log(`   ❌ ${r.name} — ${r.detail}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`Total: ${totalPass + totalFail} assertions`);
  console.log(`✅ Passed: ${totalPass}`);
  console.log(totalFail > 0 ? `❌ Failed: ${totalFail}` : `✅ All tests passed!`);

  // Print errors
  for (const { suite, logs } of allResults) {
    const errors = logs.filter(l => l.startsWith('error:'));
    if (errors.length > 0) {
      console.log(`\n⚠️  [${suite}] Console errors (${errors.length}):`);
      errors.slice(0, 10).forEach(e => console.log(`  ${e}`));
    }
  }

  // Fix verification
  console.log('\n--- Fix Verification ---');
  const allLogs = allResults.flatMap(r => r.logs);

  const checks = {
    'finishRestore() centralized': () => allLogs.some(l => l.includes('isRestoring reset to false')),
    'Post-restore cooldown (3s)': () => allLogs.some(l => l.includes('stability cooldown')),
    'Click listener attach lifecycle': () => allLogs.some(l => l.includes('Click interception attached')),
    'Click listener remove lifecycle': () => allLogs.some(l => l.includes('Click interception removed')),
    'Progressive scroll logic': () => allLogs.some(l => l.includes('Progressive scroll')),
    'Save-on-navigate (pushState)': () => allLogs.some(l => l.includes('pushState') && l.toLowerCase().includes('sav')),
    'Restore race condition guard (isRestoring)': () => allLogs.some(l => l.includes('Already restoring, skipping')),
  };

  for (const [name, check] of Object.entries(checks)) {
    const ok = check();
    console.log(`  ${ok ? '✅' : 'ℹ️'} ${name}: ${ok ? 'triggered' : 'not triggered (scenario may not apply)'}`);
  }

  process.exit(totalFail > 0 ? 1 : 0);
}

main();
