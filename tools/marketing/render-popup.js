const path = require('path');
const { writeFile } = require('fs/promises');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright'));

// Renders the real extension popup for the store screenshots, for BOTH layouts.
//
// Why this is not just "screenshot the popup":
//   - There are two layouts and both are worth showing. The classic popup is
//     portrait (360x400 here; Chrome caps a popup at 600px tall and scrolls past
//     that), and store screenshots must be 640x400 / 1280x800, so it is rendered
//     at native size and composited onto a themed frame rather than stretched.
//     It renders at the full 400px frame height rather than taller: the Stack
//     layout's utility bar is `position: fixed` to the bottom of the viewport, so
//     a taller viewport would push it below the crop and out of the asset.
//     The compact popup is natively 640x400, so it is captured full-bleed.
//     Which one is the default is decided in manifest.json, not here.
//   - The mock must report the layout the page declares, otherwise popup.js
//     performs its (correct) redirect and you silently capture the wrong page.
//
// Also renders two feature cards (both valid as store screenshots): Prev / Next
// (the real popup in watch-page mode) and backup / restore (the real import
// window, driven to its success state). Each is composited beside announcement
// copy so it cannot drift from the product.
//
// Outputs marketing-screenshot-<layout>-<theme>-1280x800.png at 2x and
// marketing-feature-{watch-nav,backup}-1280x800.png. build.sh downscales to 640x400.
//
// Usage: node render-popup.js [outDir]

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = process.argv[2] || path.join(__dirname, 'out');

const LAYOUTS = [
  // Portrait, so it needs compositing: render natively, then place on a themed canvas.
  // Height matches the frame so the fixed bottom toolbar stays inside the crop.
  { key: 'classic', file: 'popup-classic.html', width: 360, height: 400, frame: true },
  // Compact is already exactly one store screenshot, so capture it directly.
  { key: 'modern', file: 'popup.html', width: 640, height: 400, frame: false },
];

const FRAME_W = 640;
const FRAME_H = 400;

// The watch-page scenario: the Current panel shows the Prev / Next navigation
// instead of a saved position. Real ids so the previews resolve and the copy is
// recognisable.
const WATCH_NAV = {
  schema: 2,
  videoId: 'yhZAXXI83-4',
  playlistId: 'UUSHZKyawb77ixDdsGog4iWA',
  index: 58,
  current: {
    videoId: 'yhZAXXI83-4',
    title: 'Adam Frank: Alien Civilizations and the Search for Extraterrestrial Life | Lex Fridman Podcast #455',
    duration: '3:26:40',
    thumbnail: 'https://i.ytimg.com/vi/yhZAXXI83-4/maxresdefault.jpg'
  },
  channelId: 'UCSHZKyawb77ixDdsGog4iWA',
  channelUrl: 'https://www.youtube.com/@lexfridman',
  channelUploads: true,
  prev: {
    videoId: 'u321m25rKXc',
    title: 'Volodymyr Zelenskyy: Ukraine, War, Peace, Putin, Trump, NATO, and Freedom | Lex Fridman Podcast #456',
    duration: '3:39:11',
    thumbnail: 'https://i.ytimg.com/vi/u321m25rKXc/mqdefault.jpg'
  },
  next: {
    videoId: '9xz8i90Hp2A',
    title: 'Saagar Enjeti: Trump, MAGA, DOGE, Obama, FDR, JFK, History & Politics | Lex Fridman Podcast #454',
    duration: '4:02:24',
    thumbnail: 'https://i.ytimg.com/vi/9xz8i90Hp2A/mqdefault.jpg'
  }
};

// Drives the standalone import window (import.html) into its success state. The
// real page runs; only the extension's reply is mocked.
const MOCK_IMPORT = `
  window.chrome = (function(){
    var responses = { import_positions: { success: true, imported: 12, skipped: 0 } };
    return {
      runtime: {
        lastError: null,
        sendMessage: function(msg, cb){
          var resp = responses[msg && msg.action] || { success: true };
          if (cb) setTimeout(function(){ window.chrome.runtime.lastError = null; cb(resp); }, 140);
        }
      },
      windows: { getCurrent: function(cb){ if(cb) cb({ id: 1 }); }, remove: function(){} }
    };
  })();`;

// Real ids from the test channel, so the always-on previews resolve.
const MOCK = (theme, layout, watch) => {
  const channel = 'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos';
  const tabUrl = watch ? 'https://www.youtube.com/watch?v=' + WATCH_NAV.videoId : channel;
  const tabTitle = watch
    ? 'Adam Frank: Alien Civilizations and the Search for Extraterrestrial Life | Lex Fridman Podcast #455'
    : 'Learn English with Bob the Canadian';
  return `
    window.chrome = (function(){
      var now = Date.now();
      var positions = {
        '${channel}': { videoId:'EVu1pi2LE50', type:'video', timestamp: now - 4*24*3600*1000, duration:'19:49' },
        'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/shorts':
          { videoId:'vuPgnGoKkcE', type:'shorts', timestamp: now - 30*60*1000, duration:'3:32' }
      };
      var watchNav = ${JSON.stringify(WATCH_NAV)};
      var store = { theme: '${theme}', layout: '${layout}' };
      var responses = {
        ping: { ok:true },
        get_extension_enabled: { enabled:true },
        get_current_tab_position: { position: positions['${channel}'] },
        get_positions: { positions: positions },
        get_watch_nav: { ok:true, nav: watchNav },
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
            cb([{ id: 5, url:${JSON.stringify(tabUrl)}, title:${JSON.stringify(tabTitle)} }]);
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

// Render one popup at its native size, 2x for crispness. Throws if the page
// redirects, so a wrong-layout capture can never ship silently.
async function capturePopup(browser, { file, width, height, theme, layout, watch }) {
  const popup = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await popup.addInitScript(MOCK(theme, layout, watch));
  await popup.goto('file://' + path.join(ROOT, file));
  await popup.waitForTimeout(700);
  await settleThumbnails(popup);
  const landed = popup.url().split('/').pop();
  if (landed !== file) throw new Error(`expected ${file}, got ${landed}`);
  const shot = await popup.screenshot({ type: 'png', caret: 'hide' });
  await popup.close();
  return shot;
}

// The feature card: the real popup (watch-page mode) beside the announcement
// copy, at the store screenshot size. Dark, matching the banner and tile.
function featureFrameHtml(dataUri) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    :root{--grad-a:#ff8a4a;--grad-b:#ff2f6e;--line:#33353a;}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:1280px;height:800px;overflow:hidden}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      -webkit-font-smoothing:antialiased;color:#f6f6f7;position:relative;
      background:
        radial-gradient(760px 560px at 74% 4%, rgba(207,26,26,.18), transparent 60%),
        radial-gradient(680px 480px at 6% 108%, rgba(255,47,110,.12), transparent 62%),
        linear-gradient(135deg,#0f0f11 0%,#17171a 55%,#1b1b1e 100%);
    }
    .grid{position:absolute;inset:0;opacity:.4;pointer-events:none;
      background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),
        linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
      background-size:64px 64px;
      -webkit-mask-image:radial-gradient(760px 560px at 50% 50%,#000 42%,transparent 74%);
      mask-image:radial-gradient(760px 560px at 50% 50%,#000 42%,transparent 74%);}
    .wrap{position:relative;display:flex;align-items:center;height:800px;padding:0 44px;gap:44px;}
    .copy{flex:0 0 372px;}
    .eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;
      letter-spacing:.15em;text-transform:uppercase;color:#ff9a9a;
      background:rgba(207,26,26,.16);border:1px solid rgba(255,110,110,.28);
      padding:7px 13px;border-radius:999px;}
    .eyebrow .dot{width:6px;height:6px;border-radius:50%;background:#ff4d4d;box-shadow:0 0 10px #ff4d4d;}
    h1{margin-top:22px;font-size:44px;line-height:1.05;letter-spacing:-.025em;font-weight:800;}
    h1 .hl{background:linear-gradient(92deg,var(--grad-a),var(--grad-b));
      -webkit-background-clip:text;background-clip:text;color:transparent;}
    .sub{margin-top:18px;font-size:16px;line-height:1.5;color:#a9adb4;}
    .sub b{color:#e8eaee;font-weight:600;}
    .feats{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px;}
    .feat{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:#e3e5e9;
      background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:999px;padding:7px 13px;}
    .feat .ck{width:15px;height:15px;border-radius:50%;flex:none;color:#0f0f11;font-size:10px;font-weight:800;
      display:inline-flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,var(--grad-a),var(--grad-b));}
    .visual{position:relative;flex:0 0 776px;height:485px;}
    .glow{position:absolute;inset:-40px -30px;border-radius:50%;
      background:radial-gradient(closest-side,rgba(255,60,110,.20),transparent);filter:blur(10px);}
    .pop{position:relative;z-index:2;width:776px;height:485px;border-radius:16px;overflow:hidden;
      box-shadow:0 48px 90px rgba(0,0,0,.55),0 2px 0 rgba(255,255,255,.05) inset;}
    .pop img{width:100%;height:100%;display:block;}
  </style></head><body>
    <div class="grid"></div>
    <div class="wrap">
      <div class="copy">
        <span class="eyebrow"><span class="dot"></span>New · Watch-page Prev / Next</span>
        <h1>Binge a channel<br>without the <span class="hl">scroll.</span></h1>
        <p class="sub">On any video, the popup shows <b>‹ Prev</b> and <b>Next ›</b> for that channel's uploads — and the channel's saved spot follows along, so you always resume at the latest video.</p>
        <div class="feats">
          <span class="feat"><span class="ck">✓</span>Every channel</span>
          <span class="feat"><span class="ck">✓</span>Spot follows along</span>
          <span class="feat"><span class="ck">✓</span>100% private</span>
        </div>
      </div>
      <div class="visual">
        <div class="glow"></div>
        <div class="pop"><img src="${dataUri}" alt=""></div>
      </div>
    </div>
  </body></html>`;
}

// The backup / restore feature card: the real import window in its success
// state, beside the copy that explains export + import.
function backupFrameHtml(dataUri) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    :root{--grad-a:#ff8a4a;--grad-b:#ff2f6e;--line:#33353a;}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:1280px;height:800px;overflow:hidden}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      -webkit-font-smoothing:antialiased;color:#f6f6f7;position:relative;
      background:
        radial-gradient(760px 560px at 24% 4%, rgba(207,26,26,.16), transparent 60%),
        radial-gradient(680px 480px at 98% 108%, rgba(255,47,110,.12), transparent 62%),
        linear-gradient(135deg,#0f0f11 0%,#17171a 55%,#1b1b1e 100%);
    }
    .grid{position:absolute;inset:0;opacity:.4;pointer-events:none;
      background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),
        linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
      background-size:64px 64px;
      -webkit-mask-image:radial-gradient(760px 560px at 50% 50%,#000 42%,transparent 74%);
      mask-image:radial-gradient(760px 560px at 50% 50%,#000 42%,transparent 74%);}
    .wrap{position:relative;display:flex;align-items:center;height:800px;padding:0 96px;gap:72px;}
    .copy{flex:1 1 auto;max-width:470px;}
    .eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;
      letter-spacing:.15em;text-transform:uppercase;color:#ff9a9a;
      background:rgba(207,26,26,.16);border:1px solid rgba(255,110,110,.28);
      padding:7px 13px;border-radius:999px;}
    .eyebrow .dot{width:6px;height:6px;border-radius:50%;background:#ff4d4d;box-shadow:0 0 10px #ff4d4d;}
    h1{margin-top:22px;font-size:44px;line-height:1.05;letter-spacing:-.025em;font-weight:800;}
    h1 .hl{background:linear-gradient(92deg,var(--grad-a),var(--grad-b));
      -webkit-background-clip:text;background-clip:text;color:transparent;}
    .sub{margin-top:18px;font-size:16px;line-height:1.5;color:#a9adb4;}
    .feats{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px;}
    .feat{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:#e3e5e9;
      background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:999px;padding:7px 13px;}
    .feat .ck{width:15px;height:15px;border-radius:50%;flex:none;color:#0f0f11;font-size:10px;font-weight:800;
      display:inline-flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,var(--grad-a),var(--grad-b));}
    .visual{position:relative;flex:0 0 auto;}
    .glow{position:absolute;inset:-46px;border-radius:50%;
      background:radial-gradient(closest-side,rgba(255,60,110,.18),transparent);filter:blur(12px);}
    .shot{position:relative;z-index:2;width:440px;border-radius:18px;
      box-shadow:0 48px 90px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);}
    .shot img{width:100%;height:auto;display:block;border-radius:18px;}
  </style></head><body>
    <div class="grid"></div>
    <div class="wrap">
      <div class="copy">
        <span class="eyebrow"><span class="dot"></span>Backup &amp; restore</span>
        <h1>Your saved spots,<br><span class="hl">portable.</span></h1>
        <p class="sub">Export every saved position to a single JSON file, then import it back on this browser or a new one. Imported channels are re-enabled so they restore right away.</p>
        <div class="feats">
          <span class="feat"><span class="ck">✓</span>One JSON file</span>
          <span class="feat"><span class="ck">✓</span>Merges safely</span>
          <span class="feat"><span class="ck">✓</span>No account needed</span>
        </div>
      </div>
      <div class="visual">
        <div class="glow"></div>
        <div class="shot"><img src="${dataUri}" alt=""></div>
      </div>
    </div>
  </body></html>`;
}

// Drives the real import page through idle -> working -> success, then cards it.
async function renderBackupFeature(browser, outDir) {
  const page = await browser.newPage({
    viewport: { width: 560, height: 640 },
    deviceScaleFactor: 2,
  });
  await page.addInitScript(MOCK_IMPORT);
  await page.goto('file://' + path.join(ROOT, 'import.html'));
  // The card is captured on its own, so the page backdrop must not bleed into
  // the rounded corners.
  await page.addStyleTag({ content: 'body{background:transparent!important}' });
  await page.waitForSelector('#state-idle:not([hidden])');

  const positions = {};
  for (let i = 0; i < 12; i++) {
    positions['https://www.youtube.com/@channel-' + i + '/videos'] = {
      videoId: 'vid' + String(i).padStart(8, '0'),
      type: 'video',
      timestamp: Date.now() - i * 86400000,
      duration: i % 2 ? '12:34' : '3:32'
    };
  }
  const payload = JSON.stringify({ kind: 'scroll-saver-positions', version: 1, positions });
  await page.setInputFiles('#file', {
    name: 'scroll-saver-positions-2026-01-01.json',
    mimeType: 'application/json',
    buffer: Buffer.from(payload)
  });
  await page.waitForSelector('#state-success:not([hidden])');
  await page.waitForTimeout(1300); // let the badge pop / ring / check draw settle
  const card = await page.locator('#card').screenshot({ type: 'png' });
  await page.close();

  const frame = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  await frame.setContent(backupFrameHtml('data:image/png;base64,' + card.toString('base64')));
  await frame.waitForTimeout(400);
  await frame.screenshot({
    path: path.join(outDir, 'marketing-feature-backup-1280x800.png'),
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    caret: 'hide',
  });
  await frame.close();
  console.log('rendered feature-backup');
}

// The 5th store screenshot: introduces the watch-page Prev / Next feature. The
// popup is the real one in watch mode, so it cannot drift from the product.
async function renderFeature(browser, outDir) {
  const shot = await capturePopup(browser, {
    file: 'popup.html', width: 640, height: 400, theme: 'dark', layout: 'modern', watch: true
  });
  const frame = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  await frame.setContent(featureFrameHtml('data:image/png;base64,' + shot.toString('base64')));
  await frame.waitForTimeout(400);
  await frame.screenshot({
    path: path.join(outDir, 'marketing-feature-watch-nav-1280x800.png'),
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    caret: 'hide',
  });
  await frame.close();
  console.log('rendered feature-watch-nav');
}

(async () => {
  const browser = await chromium.launch();

  for (const { key, file, width, height, frame: needsFrame } of LAYOUTS) {
    for (const theme of ['light', 'dark']) {
      // 1. The popup at its native size, 2x for crispness.
      const shot = await capturePopup(browser, { file, width, height, theme, layout: key });

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

  await renderFeature(browser, OUT_DIR);
  await renderBackupFeature(browser, OUT_DIR);

  await browser.close();
})();
