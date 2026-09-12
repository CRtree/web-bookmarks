// Screenshots every popup layout x theme with a mocked chrome.* API, so all
// variants can be reviewed side by side. Dev/verification tool.
//
// Run: node tools/screenshot-layouts.mjs [outDir]
//
// Outputs popup-<layout>-<theme>.png at 2x. Writes to /tmp/ss-layouts by default.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(tmpdir(), 'ss-layouts');

const PAGES = [
  { layout: 'modern', file: 'popup.html', width: 640 },
  { layout: 'classic', file: 'popup-classic.html', width: 600 },
];

// Real ids from the test channel so the thumbnails actually resolve.
const POSITIONS = `{
  'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/shorts':
    { videoId:'vuPgnGoKkcE', type:'shorts', timestamp: now - 30*60*1000, duration:'3:32' },
  'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos':
    { videoId:'EVu1pi2LE50', type:'video', timestamp: now - 4*24*3600*1000, duration:'19:49' }
}`;

function chromeMock(layout, theme) {
  return `
    window.chrome = (function(){
      var now = Date.now();
      var positions = ${POSITIONS};
      var store = { theme: '${theme}', layout: '${layout}' };
      var responses = {
        ping: { ok:true },
        get_extension_enabled: { enabled:true },
        get_current_tab_position: { position: positions['https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos'] },
        get_positions: { positions: positions },
        get_all_logs: { logs:[] },
        clear_position: { success:true },
        clear_all: { success:true },
        set_extension_enabled: { success:true }
      };
      return {
        runtime: {
          lastError: null,
          sendMessage: function(msg, cb){
            var a = msg && msg.action;
            if (a === 'store_log'){ if(cb) setTimeout(function(){ cb({}); }, 0); return; }
            var resp = (a && responses[a] !== undefined) ? responses[a] : {};
            if (cb) setTimeout(function(){ window.chrome.runtime.lastError = null; cb(resp); }, 0);
          }
        },
        storage: {
          local: {
            get: function(keys, cb){
              var result = {};
              if (keys === null) result = Object.assign({}, store, { positions: positions });
              else if (Array.isArray(keys)) keys.forEach(function(k){ result[k] = store[k]; });
              else result[keys] = store[keys];
              setTimeout(function(){ cb(result); }, 0);
            },
            set: function(obj, cb){ Object.assign(store, obj); if(cb) setTimeout(cb, 0); }
          }
        },
        tabs: {
          query: function(q, cb){ setTimeout(function(){ cb([{ url:'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos', title:'Learn English with Bob the Canadian' }]); }, 0); },
          create: function(o, cb){ if(cb) setTimeout(function(){ cb({}); }, 0); }
        },
        action: { setPopup: function(o, cb){ if(cb) setTimeout(cb, 0); } },
        i18n: { getMessage: function(){ return ''; } }
      };
    })();
  `;
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const summary = [];

for (const { layout, file, width } of PAGES) {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 420 }, deviceScaleFactor: 2 });
    await page.addInitScript(chromeMock(layout, theme));
    await page.goto('file://' + join(root, file));
    await page.waitForTimeout(2500); // let the CDN thumbnails arrive

    // A redirect would mean the layout preference logic misfired.
    const landedOn = page.url().split('/').pop();
    if (landedOn !== file) console.log(`⚠️  ${file} redirected to ${landedOn}`);

    const m = await page.evaluate(() => ({
      h: document.documentElement.scrollHeight,
      rows: document.querySelectorAll('#positions-list .entry').length,
      thumbs: document.querySelectorAll('#positions-list .entry-thumb').length,
    }));

    await page.screenshot({ path: join(outDir, `popup-${layout}-${theme}.png`), caret: 'hide' });
    summary.push({ layout, theme, ...m });
    await page.close();
  }
}

await browser.close();

console.log('layout   theme  rows  thumbs  contentH');
for (const s of summary) {
  console.log(
    `${s.layout.padEnd(8)} ${s.theme.padEnd(6)} ${String(s.rows).padEnd(5)} ` +
    `${String(s.thumbs).padEnd(7)} ${s.h}`
  );
}
console.log(`\nwrote to ${outDir}`);
