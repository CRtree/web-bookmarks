const path = require('path');
const { writeFile } = require('fs/promises');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright'));

// Renders the real extension popup for the store screenshots, for BOTH layouts.
//
// Why this is not just "screenshot the popup":
//   - There are two layouts and both are worth showing. The classic popup is
//     portrait (360x689); store screenshots must be 640x400 / 1280x800, so it is
//     rendered at native size and composited onto a themed frame rather than
//     stretched. The compact popup is natively 640x400, so it is captured
//     full-bleed. Which one is the default is decided in manifest.json, not here.
//   - The mock must report the layout the page declares, otherwise popup.js
//     performs its (correct) redirect and you silently capture the wrong page.
//
// Outputs marketing-screenshot-<layout>-<theme>-1280x800.png at 2x. build.sh
// downscales those to the 640x400 store size.
//
// Usage: node render-popup.js [outDir]

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = process.argv[2] || path.join(__dirname, 'out');

const LAYOUTS = [
  // Portrait, so it needs compositing: render natively, then place on a themed canvas.
  { key: 'classic', file: 'popup-classic.html', width: 360, height: 689, frame: true },
  // Compact is already exactly one store screenshot, so capture it directly.
  { key: 'modern', file: 'popup.html', width: 640, height: 400, frame: false },
];

const FRAME_W = 640;
const FRAME_H = 400;

// Real ids from the test channel, so the always-on previews resolve.
const MOCK = (theme, layout) => {
  const channel = 'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos';
  return `
    window.chrome = (function(){
      var now = Date.now();
      var positions = {
        '${channel}': { videoId:'EVu1pi2LE50', type:'video', timestamp: now - 4*24*3600*1000, duration:'19:49' },
        'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/shorts':
          { videoId:'vuPgnGoKkcE', type:'shorts', timestamp: now - 30*60*1000, duration:'3:32' }
      };
      var store = { theme: '${theme}', layout: '${layout}' };
      var responses = {
        ping: { ok:true },
        get_extension_enabled: { enabled:true },
        get_current_tab_position: { position: positions['${channel}'] },
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
          query: function(q, cb){ setTimeout(function(){
            cb([{ url:'${channel}', title:'Learn English with Bob the Canadian' }]);
          }, 0); },
          create: function(o, cb){ if(cb) setTimeout(function(){ cb({}); }, 0); }
        },
        action: { setPopup: function(o, cb){ if(cb) setTimeout(cb, 0); } }
      };
    })();
  `;
};

// Thumbnails use loading="lazy", which Chrome only resolves once the page has
// actually painted. A headless render can therefore screenshot empty boxes, so
// force them eager and wait for real bytes. This is a quirk of the renderer, not
// of the extension — in a real popup the page is visible and lazy loading works.
async function settleThumbnails(page) {
  const present = await page
    .waitForFunction(() => document.querySelectorAll('.entry-thumb img').length > 0,
      null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!present) return;

  await page.evaluate(() => {
    document.querySelectorAll('.entry-thumb img').forEach((img) => {
      if (!img.complete || img.naturalWidth === 0) {
        img.loading = 'eager';
        const src = img.src;
        img.src = '';
        img.src = src;
      }
    });
  });

  await page
    .waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.entry-thumb img')];
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, null, { timeout: 15000 })
    .catch(() => console.warn('  ⚠️  some thumbnails did not load'));
}

// Puts the portrait popup on a 640x400 canvas with a shadow and a themed backdrop.
function frameHtml(dataUri, theme, popupW, popupH) {
  const light = theme === 'light';
  const bg = light
    ? `radial-gradient(520px 420px at 78% -10%, rgba(207,26,26,.10), transparent 62%),
       linear-gradient(135deg,#f4f5f7 0%,#e9ebef 60%,#e3e6ea 100%)`
    : `radial-gradient(520px 420px at 78% -10%, rgba(207,26,26,.20), transparent 62%),
       linear-gradient(135deg,#0f0f11 0%,#17171a 55%,#1b1b1e 100%)`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${FRAME_W}px;height:${FRAME_H}px;overflow:hidden}
    body{background:${bg};display:flex;justify-content:center;align-items:flex-start}
    img{
      width:${popupW}px;height:${popupH}px;display:block;
      box-shadow:0 24px 60px rgba(0,0,0,${light ? '.18' : '.55'});
      border-radius:0 0 10px 10px;
    }
  </style></head><body><img src="${dataUri}" alt=""></body></html>`;
}

(async () => {
  const browser = await chromium.launch();

  for (const { key, file, width, height, frame: needsFrame } of LAYOUTS) {
    for (const theme of ['light', 'dark']) {
      // 1. The popup at its native size, 2x for crispness.
      const popup = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 2,
      });
      await popup.addInitScript(MOCK(theme, key));
      await popup.goto('file://' + path.join(ROOT, file));
      await popup.waitForTimeout(700);
      await settleThumbnails(popup);
      // Fail loudly rather than silently shipping a screenshot of the wrong page.
      const landed = popup.url().split('/').pop();
      if (landed !== file) throw new Error(`expected ${file}, got ${landed}`);
      const shot = await popup.screenshot({ type: 'png', caret: 'hide' });
      await popup.close();

      const outName = `marketing-screenshot-${key}-${theme}-1280x800.png`;

      if (!needsFrame) {
        // Already exactly one store screenshot.
        await writeFile(path.join(OUT_DIR, outName), shot);
        console.log(`rendered popup-${key}-${theme}`);
        continue;
      }

      // 2. Composite the portrait popup into the 640x400 store frame.
      const frame = await browser.newPage({
        viewport: { width: FRAME_W, height: FRAME_H },
        deviceScaleFactor: 2,
      });
      await frame.setContent(
        frameHtml('data:image/png;base64,' + shot.toString('base64'), theme, width, height)
      );
      await frame.waitForTimeout(200);
      await frame.screenshot({
        path: path.join(OUT_DIR, outName),
        clip: { x: 0, y: 0, width: FRAME_W, height: FRAME_H },
        caret: 'hide',
      });
      await frame.close();

      console.log(`rendered popup-${key}-${theme}`);
    }
  }

  await browser.close();
})();
